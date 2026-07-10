terraform {
  required_providers {
    coder  = { source = "coder/coder" }
    docker = { source = "kreuzwerker/docker" }
  }
}

provider "coder" {}

variable "docker_socket" {
  description = "Optional Docker socket URI for macOS, rootless Docker, or remote provisioners"
  default     = ""
}

provider "docker" {
  host = var.docker_socket != "" ? var.docker_socket : null
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# ---------------------------------------------------------------------------
# Parameters (the tenant picks these when creating their workspace)
# ---------------------------------------------------------------------------
data "coder_parameter" "auth_mode" {
  name         = "auth_mode"
  display_name = "Model auth mode"
  description  = "gateway = central API billing via LiteLLM; subscription = log in with YOUR OWN seat"
  type         = "string"
  default      = "gateway"
  mutable      = true
  option {
    name  = "Gateway (API key, central billing)"
    value = "gateway"
  }
  option {
    name  = "Subscription (your own seat)"
    value = "subscription"
  }
}

data "coder_parameter" "cpus" {
  name    = "cpus"
  type    = "number"
  default = 2
  mutable = true
}

data "coder_parameter" "memory_gb" {
  name    = "memory_gb"
  type    = "number"
  default = 4
  mutable = true
}

data "coder_parameter" "pids_limit" {
  name    = "pids_limit"
  type    = "number"
  default = 256
  mutable = true
}

# ---------------------------------------------------------------------------
# Variables (set per-deployment, e.g. in a *.auto.tfvars)
# ---------------------------------------------------------------------------
variable "gateway_url" {
  description = "LiteLLM gateway URL exposed inside the tenant-private network"
  default     = "http://egress:4000"
}

variable "gateway_key" {
  description = "SEAM: per-tenant virtual key. Source from a secret store, not plaintext."
  default     = ""
  sensitive   = true
}

variable "gitea_url" {
  default = "http://egress:3000"
}

variable "skills_repo_url" {
  description = "Shared git-backed skills + brain repo"
  default     = "http://egress:3000/team/_skills.git"
}

variable "workspace_image" {
  default = "loom/coder-workspace:latest"
}

variable "egress_image" {
  description = "Minimal socat image used by the per-workspace allow-list proxy"
  default     = "loom/coder-egress:latest"
}

variable "coder_upstream" {
  description = "Fixed host:port target for Coder agent traffic"
  default     = "host.docker.internal:3000"
}

variable "coder_proxy_port" {
  description = "Private-network port matching the Coder access URL"
  default     = 3000
}

variable "gateway_upstream" {
  description = "Fixed host:port target for LiteLLM traffic"
  default     = "litellm:4000"
}

variable "gateway_proxy_port" {
  default = 4000
}

variable "gitea_upstream" {
  description = "Fixed host:port target for Gitea traffic"
  default     = "gitea:3000"
}

variable "gitea_proxy_port" {
  default = 3000
}

variable "runtime" {
  description = "Container runtime / isolation tier: runsc (gVisor) | \"\" (runc) | kata-fc"
  default     = "runsc"
}

variable "network" {
  description = "Service network joined only by each workspace's allow-list egress proxy"
  default     = "loom-net"
}

variable "brain_ingest_url_template" {
  description = "Central brain signal endpoint template. Use {tenant}, e.g. http://harness.internal:8787/tenants/{tenant}/brain/signals. Empty keeps local ingest fallback."
  default     = ""
}

variable "brain_ingest_token" {
  description = "Developer/admin key for central brain signal ingest. Source from a secret store, not plaintext."
  default     = ""
  sensitive   = true
}

locals {
  tenant_key       = data.coder_workspace_owner.me.name
  brain_ingest_url = var.brain_ingest_url_template == "" ? "" : replace(var.brain_ingest_url_template, "{tenant}", local.tenant_key)
}

# ---------------------------------------------------------------------------
# The Coder agent that runs INSIDE the workspace
# ---------------------------------------------------------------------------
resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"

  env = merge(
    {
      LOOM_GATEWAY_URL = var.gateway_url
      LOOM_GITEA_URL   = var.gitea_url
      LOOM_SKILLS_REPO = "/home/dev/projects/_skills"
      LOOM_AUTH_MODE   = data.coder_parameter.auth_mode.value
      LOOM_BRAIN_INGEST_URL   = local.brain_ingest_url
      LOOM_BRAIN_INGEST_TOKEN = var.brain_ingest_token
      LOOM_BRAIN_CLIENT_ID    = "${local.tenant_key}/${data.coder_workspace.me.name}"
    },
    data.coder_parameter.auth_mode.value == "gateway" ? {
      # gateway mode: point the native CLI at the central gateway
      ANTHROPIC_BASE_URL   = var.gateway_url
      ANTHROPIC_AUTH_TOKEN = var.gateway_key
    } : {}
    # subscription mode: inject NOTHING — the tenant runs `claude login` with their own seat.
  )

  startup_script = <<-EOT
    set -e

    # 1) loom CLI (baked into the image)
    command -v loom >/dev/null 2>&1 || echo ">> loom CLI missing; rebuild workspace image with build/Dockerfile."

    # 2) shared skills + brain repo (git-backed; the brain's memory lives here)
    if [ ! -d "$HOME/projects/_skills/.git" ]; then
      git clone "${var.skills_repo_url}" "$HOME/projects/_skills" 2>/dev/null || mkdir -p "$HOME/projects/_skills"
    fi

    # 3) brain Stop hook → ingest run signals after every /goal run
    command -v loom >/dev/null 2>&1 && loom hooks-install || true

    # 4) auth notice
    if [ "${data.coder_parameter.auth_mode.value}" = "subscription" ]; then
      echo ">> Subscription mode: run 'claude login' ONCE with your own account; it persists in this workspace."
    fi

    # 5) browser IDE
    if command -v code-server >/dev/null 2>&1; then
      code-server --auth none --port 13337 "$HOME/projects" >/tmp/code-server.log 2>&1 &
    else
      echo ">> code-server missing; rebuild workspace image with build/Dockerfile."
    fi
  EOT

  metadata {
    display_name = "CPU"
    key          = "cpu"
    script       = "top -bn1 | awk '/Cpu/ {print $2\"%\"}'"
    interval     = 10
    timeout      = 1
  }
}

resource "coder_app" "code_server" {
  agent_id     = coder_agent.main.id
  slug         = "code-server"
  display_name = "VS Code (browser)"
  url          = "http://localhost:13337/?folder=/home/dev/projects"
  icon         = "/icon/code.svg"
  subdomain    = false
  share        = "owner"
}

# Each tenant gets an internal-only network. The workspace cannot route to the
# host, another tenant, PostgreSQL, or Redis; only the fixed egress listeners.
resource "docker_network" "workspace" {
  name     = "loom-private-${local.tenant_key}-${data.coder_workspace.me.id}"
  internal = true
}

resource "docker_container" "egress" {
  count = data.coder_workspace.me.start_count
  image = var.egress_image
  name  = "loom-egress-${local.tenant_key}-${lower(data.coder_workspace.me.name)}"

  command = [<<-EOT
    socat TCP-LISTEN:${var.coder_proxy_port},fork,reuseaddr TCP:${var.coder_upstream} &
    socat TCP-LISTEN:${var.gitea_proxy_port},fork,reuseaddr TCP:${var.gitea_upstream} &
    exec socat TCP-LISTEN:${var.gateway_proxy_port},fork,reuseaddr TCP:${var.gateway_upstream}
  EOT
  ]

  cpus      = "0.25"
  memory    = 128
  read_only = true
  capabilities {
    drop = ["ALL"]
  }
  security_opts = ["no-new-privileges:true"]

  provisioner "local-exec" {
    command = "docker update --pids-limit 64 ${self.name} >/dev/null"
  }

  networks_advanced {
    name    = docker_network.workspace.name
    aliases = ["egress"]
  }

  networks_advanced {
    name = var.network
  }

  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }
}

# ---------------------------------------------------------------------------
# Persistent home → ~/.claude session store + (subscription) login survive rebuilds.
# This is why native --resume works per tenant across sessions.
# ---------------------------------------------------------------------------
resource "docker_volume" "home" {
  name = "loom-home-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.id}"
  lifecycle {
    ignore_changes = all
  }
}

# ---------------------------------------------------------------------------
# The workspace container — isolated with gVisor (var.runtime) and a private network.
# ---------------------------------------------------------------------------
resource "docker_container" "workspace" {
  count   = data.coder_workspace.me.start_count
  image   = var.workspace_image
  name    = "loom-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  runtime = var.runtime

  entrypoint = [
    "sh",
    "-c",
    join("\n", [
      "mkdir -p /home/dev/.cache/coder-agent",
      "export TMPDIR=/home/dev/.cache/coder-agent",
      replace(coder_agent.main.init_script, "/localhost|127\\.0\\.0\\.1/", "egress"),
    ]),
  ]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]

  # resource caps
  cpus   = tostring(data.coder_parameter.cpus.value)
  memory = data.coder_parameter.memory_gb.value * 1024

  # hardening
  read_only = true
  tmpfs = {
    "/tmp" = "rw,noexec,nosuid,size=64m"
  }
  capabilities {
    drop = ["ALL"]
  }
  security_opts = ["no-new-privileges:true"]

  # docker_container does not expose HostConfig.PidsLimit; apply it after create.
  provisioner "local-exec" {
    command = "docker update --pids-limit ${data.coder_parameter.pids_limit.value} ${self.name} >/dev/null"
  }

  volumes {
    container_path = "/home/dev"
    volume_name    = docker_volume.home.name
    read_only      = false
  }

  networks_advanced {
    name = docker_network.workspace.name
  }

  depends_on = [docker_container.egress]
}
