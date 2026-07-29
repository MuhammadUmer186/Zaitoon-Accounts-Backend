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
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 backend

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# middleware/upload.ts writes to UPLOAD_ROOT/<organizationId>/ at runtime as
# the non-root `backend` user — without this, /app (owned by root) has no
# writable location at all and every file upload crashes with EACCES.
RUN mkdir -p /app/uploads && chown -R backend:nodejs /app/uploads

USER backend

EXPOSE 4000

CMD ["node", "dist/index.js"]
