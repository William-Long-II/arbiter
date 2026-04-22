FROM oven/bun:1-debian AS base
WORKDIR /app

# Node is required to install the Claude Code CLI globally (it ships as an npm package).
# Use the official NodeSource distribution for a stable 20.x LTS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
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

USER bun
ENV NODE_ENV=production
ENV AUTO_REVIEWER_CONFIG=/app/config.yaml
ENV AUTO_REVIEWER_DB=/app/data/state.sqlite

CMD ["bun", "run", "src/index.ts"]
