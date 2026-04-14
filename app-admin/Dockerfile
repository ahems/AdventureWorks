# Build stage - use ACR-cached node image to avoid Docker Hub rate limits
FROM avacriy5viuu3lrqdg.azurecr.io/node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application (config is injected at runtime via entrypoint, not baked in)
RUN npm run build

# Production stage - serve with 'serve' (no nginx, stays on ACR-cached node image)
FROM avacriy5viuu3lrqdg.azurecr.io/node:20-alpine

WORKDIR /app

# Install serve globally for SPA static file hosting
RUN npm install -g serve

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Expose port 80
EXPOSE 80

# Start with custom entrypoint
ENTRYPOINT ["/docker-entrypoint.sh"]
