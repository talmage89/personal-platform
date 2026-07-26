FROM oven/bun:1-alpine AS build
WORKDIR /app

# Deliberately copying everything before installing, rather than staging each
# workspace manifest for a cached install layer. Docker's COPY cannot glob across
# directories while preserving structure, so the staged version needs one line
# per package — and a forgotten line fails the build with an unresolved workspace
# dependency, which is exactly how @platform/auth broke this. The install takes
# about seven seconds; that is cheaper than the footgun.
COPY . .

RUN bun install --frozen-lockfile
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
