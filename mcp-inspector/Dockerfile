FROM node:22-bookworm-slim

# Install nginx
RUN apt-get update && apt-get install -y nginx --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /inspector
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY gateway.mjs ./

# Expose only the authenticated loopback gateway.
COPY nginx.conf /etc/nginx/sites-available/inspector.conf
RUN rm -f /etc/nginx/sites-enabled/default \
    && ln -s /etc/nginx/sites-available/inspector.conf /etc/nginx/sites-enabled/inspector.conf

# Copy startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

CMD ["/entrypoint.sh"]
