FROM oven/bun:1-alpine AS build
WORKDIR /app

# Workspace manifests first, so `bun install` is cached until a dependency changes.
# Add a line here for every new workspace package.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/

RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:distroless AS runner
WORKDIR /app
ENV NODE_ENV=production

# Needed for outbound TLS (GitHub OAuth, Neon). distroless ships no CA bundle.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# The bundle is self-contained — node_modules is never copied.
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/apps/web/public ./public

EXPOSE 8080
ENTRYPOINT ["bun"]
CMD ["dist/index.js"]
