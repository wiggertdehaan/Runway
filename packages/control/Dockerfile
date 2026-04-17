# syntax=docker/dockerfile:1.7
# Build context: repository root (see docker-compose.yml).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── Install deps ─────────────────────────────────────────
# Copy only the manifests first so Docker caches the install
# step when source changes but dependencies don't.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/control/package.json ./packages/control/
COPY packages/mcp/package.json ./packages/mcp/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @runway/control...

# ── Build ────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY packages/control ./packages/control
RUN pnpm --filter @runway/control build

# ── Runtime ──────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/runway.db

# Copy the entire workspace from the build stage. This preserves
# the pnpm symlink structure (node_modules -> .pnpm store) which
# is needed for module resolution at runtime.
COPY --from=build /app /app

# NOTE: control runs as root because it talks to the host Docker
# socket mounted at /var/run/docker.sock to build and run app
# containers. A non-root user inside the container would need to
# match the host's docker group GID, which varies by host. Since
# write access to the Docker socket is already equivalent to root
# on the host, running the node process as root inside the
# container doesn't meaningfully widen the blast radius. This
# changes when we move builds into an isolated builder service.
RUN mkdir -p /data
EXPOSE 3000
WORKDIR /app/packages/control
CMD ["node", "dist/index.js"]
