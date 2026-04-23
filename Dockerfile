FROM oven/bun:1-debian AS base
WORKDIR /app

# System deps:
#  - curl + ca-certificates + git: needed to install the Claude Code CLI and
#    to let git operations work inside the container.
#  - gosu: used by the entrypoint to drop privileges from root -> bun after
#    chown'ing the mounted data directory. su-exec is smaller but not in
#    Debian main; gosu is the Debian-blessed equivalent.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git gosu \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @anthropic-ai/claude-code \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base
# The oven/bun base image already provides a `bun` user at UID/GID 1000.
# Reuse it instead of creating a second UID-1000 user (which fails with
# `groupadd: GID 1000 not unique`, exit code 4). UID 1000 still matches a
# typical host user, so the mounted ~/.claude directory stays readable.
#
# /app is root-owned by default after WORKDIR, and /app/data doesn't exist
# yet — pre-create it and hand both to `bun` so the non-root process can
# open the sqlite file (and create the dir when no host volume is mounted).
RUN mkdir -p /app/data && chown -R bun:bun /app

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src
# scripts/backup-db.ts is invoked via docker compose exec by scripts/backup.sh
# to produce an online-safe sqlite snapshot.
COPY --chown=bun:bun scripts ./scripts

# Entrypoint script self-heals /app/data ownership at boot before dropping
# privileges. Without this, a fresh bind mount (./data created by Docker on
# the host with root ownership) locks the bun user out with SQLITE_CANTOPEN.
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Deliberately NOT `USER bun` here — the entrypoint needs to start as root
# so it can chown a fresh mounted data dir, then drops to `bun` via gosu.
ENV NODE_ENV=production
ENV AUTO_REVIEWER_CONFIG=/app/config.yaml
ENV AUTO_REVIEWER_DB=/app/data/state.sqlite

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
