# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Multi-stage build producing a ~315 MB runtime image.
#
# Node 24 is the floor rather than a preference: the app uses the built-in
# `node:sqlite` module, which is what lets it store vectors and run BM25 with no
# native addon to compile and no database service to operate.
# ---------------------------------------------------------------------------

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` for a reproducible install from the lockfile; dev deps are needed
# because the build runs TypeScript and Tailwind.
RUN npm ci


FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build


FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    LOG_FORMAT=json \
    DATA_DIR=/data

RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nextjs

# `output: "standalone"` emits a server with only the modules it actually uses,
# so node_modules is not copied wholesale.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# There is no `public/` directory: the only static asset is the app icon, which the
# App Router emits into `.next` for us.

# The sample corpus and the golden evaluation set, so the seed endpoint works and
# `npm run eval` can be run against the running image.
COPY --from=builder --chown=nextjs:nodejs /app/data ./data
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src ./src

# The database lives on a volume; without one, every restart is an empty corpus.
RUN mkdir -p /data && chown nextjs:nodejs /data
VOLUME ["/data"]

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
