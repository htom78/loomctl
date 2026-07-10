# Per-tenant persistent workspace image.
# The persistent volume mounts at /home/dev, so ~/.claude (session store) and the tenant's
# own subscription login (if auth=subscription) survive between sessions → native --resume works.
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl bash nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash dev
# Install the loom CLI (this repo) and the native coding agent into the image:
#   COPY . /opt/loomctl && cd /opt/loomctl && npm ci && npm run build && npm link
#   RUN curl -fsSL https://.../claude-install.sh | bash    # or codex
USER dev
WORKDIR /home/dev/projects
# In subscription mode, the tenant runs `claude login` ONCE here; it persists in their volume.
