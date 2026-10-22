# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src/ ./src/

RUN npm run build
RUN npm prune --production

# Production stage
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install curl for healthcheck
RUN apk add --no-cache curl

# Run as non-root node user
USER node

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["server"]
