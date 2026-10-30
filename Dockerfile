FROM node:20-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
# tzdata: lets TZ=Asia/Karachi (docker-compose) set the server's local day
RUN apk add --no-cache openssl tzdata
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 backend

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
# Brand assets (logo) used by the PDF / Excel report exports
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

# middleware/upload.ts writes to UPLOAD_ROOT/<organizationId>/ at runtime as
# the non-root `backend` user — without this, /app (owned by root) has no
# writable location at all and every file upload crashes with EACCES.
# backups/ is where db:reset-all-data writes its safety copy.
RUN chmod +x /app/docker-entrypoint.sh \
  && mkdir -p /app/uploads /app/backups \
  && chown -R backend:nodejs /app/uploads /app/backups

USER backend

EXPOSE 4000

CMD ["./docker-entrypoint.sh"]
