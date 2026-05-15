FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install

FROM oven/bun:1.2-alpine
WORKDIR /app

# Install the Claude Code CLI so subscription-mode reviews can shell out
# to `claude -p`. We use npm (via Alpine's nodejs) because @anthropic-ai/
# claude-code is published with node-style global bin shims that bun's
# global install doesn't always wire up identically. Credentials come
# from the host's ~/.claude/ via the docker-compose bind-mount.
RUN apk add --no-cache nodejs npm \
  && npm install -g @anthropic-ai/claude-code \
  && claude --version || true

# Seed a minimal global config. /root/.claude.json sits *next to* the
# bind-mounted /root/.claude/ dir (not inside it), so without this the
# first `claude -p` in every freshly-recreated container emits a
# harmless "config file not found" notice 3x to stderr while it builds
# a default. Claude Code tolerates/migrates {}; seeding it keeps logs
# clean. The bind-mount only covers the dir, so this file is never shadowed.
RUN echo '{}' > /root/.claude.json

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY DESIGN.md ./DESIGN.md

ENV NODE_ENV=production
EXPOSE 8787
CMD ["bun", "run", "src/index.ts"]
