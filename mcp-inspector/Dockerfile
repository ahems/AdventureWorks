FROM mcr.microsoft.com/mirror/docker/library/node:20-bookworm-slim

# Install nginx
RUN apt-get update && apt-get install -y nginx --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install MCP Inspector globally
RUN npm install -g @modelcontextprotocol/inspector

# Configure nginx to proxy both ports through port 80
COPY nginx.conf /etc/nginx/sites-available/inspector.conf
RUN rm -f /etc/nginx/sites-enabled/default \
    && ln -s /etc/nginx/sites-available/inspector.conf /etc/nginx/sites-enabled/inspector.conf

# Copy startup script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

CMD ["/entrypoint.sh"]
