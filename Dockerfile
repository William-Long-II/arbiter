FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN bun install

FROM oven/bun:1.2-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY DESIGN.md ./DESIGN.md

ENV NODE_ENV=production
EXPOSE 8787
CMD ["bun", "run", "src/index.ts"]
