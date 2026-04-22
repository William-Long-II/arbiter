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
# Run as a non-root user. UID 1000 matches the typical host user so the
# mounted ~/.claude directory stays readable without extra chown gymnastics.
RUN groupadd -g 1000 reviewer \
 && useradd  -u 1000 -g 1000 -m -s /bin/bash reviewer

COPY --from=deps --chown=reviewer:reviewer /app/node_modules ./node_modules
COPY --chown=reviewer:reviewer package.json bun.lock tsconfig.json ./
COPY --chown=reviewer:reviewer src ./src

USER reviewer
ENV NODE_ENV=production
ENV AUTO_REVIEWER_CONFIG=/app/config.yaml
ENV AUTO_REVIEWER_DB=/app/data/state.sqlite

CMD ["bun", "run", "src/index.ts"]
