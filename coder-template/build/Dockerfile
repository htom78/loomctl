# Per-tenant Coder workspace image: git + node + loom CLI + (native agent) + code-server.
# Coder injects its agent via the container entrypoint; this image only needs sh/curl + the toolchain.
FROM debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git curl ca-certificates nodejs npm procps \
    && rm -rf /var/lib/apt/lists/*

# loom CLI (this repo) baked in for the read-only rootfs.
COPY . /opt/loomctl
RUN cd /opt/loomctl && npm ci && npm run build && npm link

RUN curl -fsSL https://code-server.dev/install.sh | sh

# Install the native coding agent into the image (choose one):
#   RUN curl -fsSL https://.../claude-code-install.sh | bash
#   RUN npm i -g @your/codex-cli

RUN useradd -m -s /bin/bash dev
USER dev
WORKDIR /home/dev/projects
