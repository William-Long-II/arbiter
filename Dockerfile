FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
WORKDIR /app

# Run as non-root
RUN addgroup -S reviewme && adduser -S reviewme -G reviewme
COPY --from=deps --chown=reviewme:reviewme /app/node_modules ./node_modules
COPY --chown=reviewme:reviewme package.json bun.lock tsconfig.json index.ts ./
COPY --chown=reviewme:reviewme src ./src

USER reviewme
ENV NODE_ENV=production
# Bind to all interfaces inside the container; the reverse proxy is
# responsible for who can reach it.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "index.ts"]
