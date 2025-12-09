# Runtime Configuration Fix

## Problem
The deployed app was trying to use `localhost:5000/graphql` instead of the production API URL because:
1. The `.env` file had `VITE_API_URL=http://localhost:5000/graphql`
2. Vite bakes environment variables into the build at **build time**
3. The Azure Container App had `API_URL` environment variable, but it wasn't being used

## Solution
Implemented **runtime configuration injection** so the API URL can be changed without rebuilding the app.

### How It Works

#### 1. Docker Entrypoint Script
The Dockerfile now includes a startup script that generates `/config.js` from environment variables:

```dockerfile
# Generate config.js with runtime environment variables
cat > /usr/share/nginx/html/config.js << EOF
window.APP_CONFIG = {
  API_URL: "${API_URL:-http://localhost:5000/graphql}"
};
EOF
```

#### 2. Load Config Before App
The `index.html` loads `config.js` before the main app:

```html
<script src="/config.js"></script>
<script type="module" src="/src/main.tsx"></script>
```

#### 3. GraphQL Client Reads Runtime Config
The GraphQL client checks `window.APP_CONFIG` first:

```typescript
const getApiUrl = (): string => {
  // Try runtime config first (production)
  if (typeof window !== 'undefined' && window.APP_CONFIG?.API_URL) {
    return window.APP_CONFIG.API_URL;
  }
  
  // Fall back to build-time env var (local dev)
  return import.meta.env.VITE_API_URL || 'http://localhost:5000/graphql';
};
```

### Files Changed

1. **app/Dockerfile** - Added entrypoint script to generate config.js
2. **app/index.html** - Load config.js before main app
3. **app/public/config.js** - Fallback config for local development
4. **app/src/lib/graphql-client.ts** - Read from window.APP_CONFIG
5. **app/src/vite-env.d.ts** - TypeScript definitions for APP_CONFIG
6. **app/.env** - Updated comments

### Benefits

✅ **No rebuild needed** to change API URL  
✅ **Environment-specific** without multiple builds  
✅ **12-factor app compliant** - configuration via environment  
✅ **Works locally and in production** - automatic fallback  

### Deployment

The infrastructure already sets `API_URL` in the Container App environment variables:

```bicep
env: [
  {
    name: 'API_URL'
    value: apiUrl  // Set from main.bicep output
  }
]
```

When you deploy:
```bash
azd deploy app
```

The app will automatically use the correct API URL from the Container App environment.

### Testing

1. **Local Development**: Uses `VITE_API_URL` from `.env`
2. **Production**: Uses `API_URL` from Container App environment

To verify in production:
1. Open browser DevTools
2. Console: `window.APP_CONFIG.API_URL`
3. Should show: `https://your-api.azurecontainerapps.io/graphql`

### Troubleshooting

**Issue**: App still uses localhost in production

**Solution**: 
1. Check Container App environment variable is set: `az containerapp show --name todoapp-app-xxx --resource-group rg-xxx --query properties.template.containers[0].env`
2. Restart the container: `az containerapp revision restart`
3. Check `/config.js` in browser: should show production API URL
