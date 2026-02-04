# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Accept API URL as build argument
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

# Build the application with the environment variable baked in
RUN npm run build

# Production stage
FROM nginx:alpine

# Install bash for runtime config injection
RUN apk add --no-cache bash

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration for SPA routing
RUN echo 'server { \
    listen 80; \
    server_name _; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location /config.js { \
        add_header Content-Type application/javascript; \
        add_header Cache-Control "no-cache, no-store, must-revalidate"; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Create entrypoint script directly
RUN printf '#!/bin/sh\n\
set -e\n\
echo "Starting entrypoint script..."\n\
echo "API_URL: $API_URL"\n\
echo "API_FUNCTIONS_URL: $API_FUNCTIONS_URL"\n\
echo "window.APP_CONFIG = { API_URL: \\"$API_URL\\", API_FUNCTIONS_URL: \\"$API_FUNCTIONS_URL\\" };" > /usr/share/nginx/html/config.js\n\
echo "Generated config.js:"\n\
cat /usr/share/nginx/html/config.js\n\
exec nginx -g "daemon off;"\n' > /docker-entrypoint.sh && \
    chmod +x /docker-entrypoint.sh

# Expose port 80
EXPOSE 80

# Start with custom entrypoint
ENTRYPOINT ["/docker-entrypoint.sh"]
