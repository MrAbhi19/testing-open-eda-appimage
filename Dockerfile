# syntax=docker/dockerfile:1.7
# gh-agent Docker Image
# Multi-stage build for minimal production image

# ---------- Build stage ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY src ./src
COPY .agent/config.yaml ./.agent/config.yaml

# Build (type-check only, no emit)
RUN npm run build

# ---------- Production stage ----------
FROM node:22-alpine AS runtime

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1000 -S agent && \
    adduser -u 1000 -S agent -G agent

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built application and config
COPY --from=builder /app/src ./src
COPY --from=builder /app/.agent/config.yaml ./.agent/config.yaml

# Create directories for conversation persistence and logs
RUN mkdir -p .agent/conversations .agent/logs && \
    chown -R agent:agent /app

# Switch to non-root user
USER agent

# Expose port for health check (if needed)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Default command
CMD ["node", "--import=tsx", "src/cli.ts"]