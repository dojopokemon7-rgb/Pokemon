# ============================================================
# STAGE 1 — deps
# Install production + dev dependencies so we can build.
# ============================================================
FROM node:22-alpine AS deps

# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine
# for why libc6-compat is needed.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy lockfile and manifests first for layer caching.
# The prisma/ schema must be present before `npm ci` because the postinstall
# hook runs `prisma generate`, which needs prisma/schema.prisma.
COPY package.json package-lock.json* ./
COPY prisma ./prisma

RUN npm ci

# ============================================================
# STAGE 2 — builder
# Run the Next.js production build.
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma Client during build so it's available at runtime
RUN npx prisma generate

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# ============================================================
# STAGE 3 — runner
# Minimal production image using Next.js standalone output.
# ============================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy the standalone build output, owned by the non-root runtime user so Next
# can write its runtime caches (ISR/prerender under .next/cache). Without
# `--chown`, the copied tree is root-owned and the `nextjs` user hits
# `EACCES: mkdir '/app/.next/cache'` on first render.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma client binary needs the schema for migrations (optional here, but good practice)
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

# Pre-create the Next.js cache dir owned by the runtime user so ISR/prerender
# cache writes never hit EACCES (the standalone output omits this dir).
RUN mkdir -p .next/cache && chown -R nextjs:nodejs .next

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Use server.js produced by `output: 'standalone'`
CMD ["node", "server.js"]
