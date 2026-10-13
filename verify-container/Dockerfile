# Verification image: runs the BE-P and FE-P gates on agent-written code
# without host credentials (docs/orchestration.md).
# Base images are pinned by digest; rebuild with
#   node verify-container/run-gate.mjs build-image
# and update the digests deliberately, never by tag drift.
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS node

FROM mcr.microsoft.com/dotnet/sdk:8.0@sha256:f7e28a0a3f6f9235929ec19274fd0ddf8534e9159f99fac602ac73304f1ce99f

# Tools the gates call: git (migration/merge-base checks, FE fingerprints),
# python3 (endpoint authorization), util-linux flock + coreutils timeout (gate
# locks and step limits), procps. No SSH client, no Docker CLI, no cloud CLIs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 util-linux procps ca-certificates \
    && apt-get purge -y --auto-remove openssh-client 2>/dev/null || true \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# pnpm pinned to FE-P's packageManager; installed at build time so gates run offline.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable --install-directory /usr/local/bin pnpm \
    && corepack prepare pnpm@11.5.3 --activate \
    && chmod -R a+rX /opt/corepack

# Unprivileged user with the host user's ids, so files written into the
# bind-mounted worktree stay owned by that user. .NET needs a passwd entry for
# the running uid (named mutexes fail without one).
ARG VERIFY_UID=1000
ARG VERIFY_GID=1000
RUN groupadd -o -g "${VERIFY_GID}" verify && useradd -o -u "${VERIFY_UID}" -g "${VERIFY_GID}" -d /home/verify -M -s /bin/bash verify
USER verify
ENV HOME=/home/verify

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_NETWORK=0
