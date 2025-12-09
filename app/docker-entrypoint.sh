#!/bin/sh
set -e

echo "Starting entrypoint script..."
echo "API_URL: ${API_URL}"

# Generate config.js with the API_URL from environment variable
cat > /usr/share/nginx/html/config.js << EOF
window.APP_CONFIG = {
  API_URL: "${API_URL}"
};
EOF

echo "Generated config.js:"
cat /usr/share/nginx/html/config.js

# Start nginx
exec nginx -g 'daemon off;'
