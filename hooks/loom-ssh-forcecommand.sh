#!/usr/bin/env bash
# SSH ForceCommand entry. The SSH key IS the auth: bind one key per tenant.
# In the loomd host's authorized_keys (or a Match block), pin the tenant name to the key:
#
#   command="/usr/local/bin/loom-ssh-forcecommand alice",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... alice
#
# Then `ssh loom@vps` with alice's key drops her straight into her own container.
set -euo pipefail
tenant="${1:?usage: loom-ssh-forcecommand <tenant>}"
exec loomd enter "$tenant"
