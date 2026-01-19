# Application Insights Connection String Injection Flow

## Overview

This document explains how the Application Insights connection string automatically flows from Azure infrastructure to the deployed frontend application.

## Deployment Flow

### 1. Infrastructure Provisioning (`azd provision`)

**File**: [infra/main.bicep](infra/main.bicep)

```bicep
output APPINSIGHTS_CONNECTIONSTRING string = appinsights.outputs.connectionString
```

- Bicep creates the Application Insights resource
- Outputs the connection string as `APPINSIGHTS_CONNECTIONSTRING`
- This value is stored in the `azd` environment

### 2. Pre-Deploy Hook (`azd deploy`)

**File**: [scripts/predeploy.sh](scripts/predeploy.sh)

```bash
APPINSIGHTS_CONN_STR=$(azd env get-value APPINSIGHTS_CONNECTIONSTRING)
```

The predeploy script:

1. Reads `APPINSIGHTS_CONNECTIONSTRING` from `azd env`
2. Creates `app/.env.production` with:
   ```
   VITE_API_URL=...
   VITE_API_FUNCTIONS_URL=...
   VITE_APPINSIGHTS_CONNECTIONSTRING=...
   ```
3. This file is read by Vite during the build process

### 3. Build Process

**File**: [app/scripts/build-with-env.sh](app/scripts/build-with-env.sh)

```bash
export $(cat .env.production | xargs)
npm run build
```

The build script:

1. Loads `.env.production` variables
2. Exports them as environment variables
3. Runs `npm run build`

### 4. NPM Build

**File**: [app/package.json](app/package.json)

```json
{
  "scripts": {
    "build": "npm run update-config && vite build && npm run post-build-config"
  }
}
```

The build process:

1. **update-config**: Writes `config.js` with environment variables
2. **vite build**: Compiles the React app
3. **post-build-config**: Copies `config.js` to `dist/config.js`

### 5. Config Generation

**File**: [app/scripts/update-config.js](app/scripts/update-config.js)

```javascript
const APPINSIGHTS_CONNECTIONSTRING =
  process.env.VITE_APPINSIGHTS_CONNECTIONSTRING || "";

const configContent = `
window.APP_CONFIG = {
  API_URL: '${API_URL}',
  API_FUNCTIONS_URL: '${API_FUNCTIONS_URL}',
  APPINSIGHTS_CONNECTIONSTRING: '${APPINSIGHTS_CONNECTIONSTRING}'
};
`;
```

This script:

1. Reads `VITE_APPINSIGHTS_CONNECTIONSTRING` from environment
2. Generates `public/config.js` with runtime configuration
3. This file is loaded by `index.html` before the React app

### 6. Runtime Loading

**File**: [app/index.html](app/index.html)

```html
<script src="/config.js"></script>
```

The HTML loads `config.js` which sets `window.APP_CONFIG` with the connection string.

### 7. Application Initialization

**File**: [app/src/lib/appInsights.ts](app/src/lib/appInsights.ts)

```typescript
export const initAppInsights = () => {
  const connectionString = window.APP_CONFIG?.APPINSIGHTS_CONNECTIONSTRING;
  // ... initialize Application Insights
};
```

The app:

1. Reads connection string from `window.APP_CONFIG`
2. Initializes Application Insights SDK
3. Begins tracking telemetry

## Complete Chain

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. azd provision                                                 │
│    infra/main.bicep → outputs APPINSIGHTS_CONNECTIONSTRING      │
│    Stored in azd environment                                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. azd deploy (predeploy hook)                                  │
│    scripts/predeploy.sh                                          │
│    - Reads from azd env                                         │
│    - Writes to app/.env.production                              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Build Process                                                 │
│    app/scripts/build-with-env.sh                                │
│    - Loads .env.production                                      │
│    - Exports VITE_APPINSIGHTS_CONNECTIONSTRING                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. NPM Build                                                     │
│    npm run build                                                 │
│    - update-config.js reads env var                             │
│    - Writes to public/config.js                                 │
│    - Vite builds app                                            │
│    - Copies config.js to dist/                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Deployed Static Web App                                      │
│    dist/config.js contains connection string                    │
│    index.html loads config.js                                   │
│    window.APP_CONFIG.APPINSIGHTS_CONNECTIONSTRING set           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. React App Runtime                                            │
│    App.tsx → initAppInsights()                                  │
│    Reads window.APP_CONFIG.APPINSIGHTS_CONNECTIONSTRING         │
│    Initializes Application Insights SDK                         │
│    ✓ Telemetry tracking active                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files Modified

### Infrastructure

- ✅ `infra/modules/applicationinsights.bicep` - Outputs connection string
- ✅ `infra/main.bicep` - Passes to frontend, adds to outputs

### Deployment Scripts

- ✅ `scripts/predeploy.sh` - Reads from azd env, writes to .env.production

### Frontend Configuration

- ✅ `app/scripts/update-config.js` - Reads env var, writes to config.js
- ✅ `app/src/vite-env.d.ts` - TypeScript types for APP_CONFIG

### Application Code

- ✅ `app/src/lib/appInsights.ts` - Reads from window.APP_CONFIG
- ✅ `app/src/App.tsx` - Initializes on app start

## Verification

After deployment, verify the connection string injection:

### 1. Check azd environment

```bash
azd env get-values | grep APPINSIGHTS_CONNECTIONSTRING
```

### 2. Check deployed config.js

Visit: `https://your-app-url/config.js`

Should contain:

```javascript
window.APP_CONFIG = {
  API_URL: "https://...",
  API_FUNCTIONS_URL: "https://...",
  APPINSIGHTS_CONNECTIONSTRING: "InstrumentationKey=...",
};
```

### 3. Check browser console

Open DevTools → Console, should see:

```
[App Insights] Initialized successfully
```

### 4. View live telemetry

Azure Portal → Application Insights → Live Metrics

## Troubleshooting

### Connection string not set in config.js

- Check `azd env get-values` includes `APPINSIGHTS_CONNECTIONSTRING`
- Verify `scripts/predeploy.sh` was updated
- Check build logs for `VITE_APPINSIGHTS_CONNECTIONSTRING: ***set***`

### Telemetry not working

- Open browser DevTools → Console
- Look for `[App Insights]` messages
- Check Network tab for requests to `dc.services.visualstudio.com`

### Local development

For local dev, create `app/.env.local`:

```
VITE_APPINSIGHTS_CONNECTIONSTRING=<your-connection-string>
```

Or leave empty - telemetry will be disabled with a warning.

## Security Note

Application Insights connection strings are **safe to expose** in client-side code. They only allow:

- ✅ Sending telemetry data to Application Insights
- ❌ Cannot read existing data
- ❌ Cannot modify configuration
- ❌ Cannot delete data

The connection string is intentionally designed for browser/mobile app usage.
