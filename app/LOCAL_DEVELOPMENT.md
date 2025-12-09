# Local Development Setup Guide

## The CORS Issue

When running the app locally at `http://localhost:8080` (or `http://127.0.0.1:8080`), you'll get a CORS error when trying to access the production API:

```
Access to fetch at 'https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql' 
from origin 'http://127.0.0.1:8080' has been blocked by CORS policy
```

This happens because:
1. The production API (`dab-config.prod.json`) only allows requests from `@env('APP_URL')` (the deployed app URL)
2. The production API requires Azure AD authentication
3. Local development URLs are not in the allowed origins list

## Solution: Run API Locally

The recommended solution is to run the Data API Builder (DAB) locally with the development configuration.

### Step 1: Check Database Connection

First, ensure you have access to the database. Check if the `DATABASE_CONNECTION_STRING` environment variable is set:

```bash
echo $DATABASE_CONNECTION_STRING
```

If not set, you'll need to get the connection string from Azure or set up a local database.

### Step 2: Start the Local API Server

Open a new terminal and run:

```bash
cd /workspaces/AdventureWorks/api
./start-local-api.sh
```

This will:
- Install Data API Builder if not already installed
- Start the API at `http://localhost:5000`
- Enable CORS for all origins
- Allow anonymous access (no authentication required)

The API endpoints will be:
- GraphQL: `http://localhost:5000/graphql`
- REST: `http://localhost:5000/api`
- Swagger: `http://localhost:5000/swagger`

### Step 3: Update Your .env File

The `.env` file is already configured to use localhost:

```env
VITE_API_URL=http://localhost:5000/graphql
```

### Step 4: Start the Frontend App

In another terminal, start the React app:

```bash
cd /workspaces/AdventureWorks/app
npm run dev
```

The app will be available at `http://localhost:8080`

### Step 5: Verify Everything Works

1. Open your browser to `http://localhost:8080`
2. Open browser DevTools (F12) → Network tab
3. You should see GraphQL requests to `http://localhost:5000/graphql`
4. Check that categories and products load correctly

## Alternative: Use a Proxy (Not Recommended)

If you can't run the API locally, you could set up a development proxy, but this is more complex and not recommended.

## Development Configuration Details

### Development Config (`dab-config.json`)
```json
{
  "cors": {
    "origins": ["*"],  // Allows all origins
    "allow-credentials": false
  },
  "authentication": {
    "provider": "StaticWebApps"  // Allows anonymous access
  }
}
```

### Production Config (`dab-config.prod.json`)
```json
{
  "cors": {
    "origins": ["@env('APP_URL')"],  // Only allows deployed app
    "allow-credentials": true
  },
  "authentication": {
    "provider": "AzureAD",  // Requires authentication
    "jwt": {
      "audience": "@env('API_APP_ID_URI')",
      "issuer": "https://sts.windows.net/@env('TENANT_ID')/"
    }
  }
}
```

## Troubleshooting

### API Won't Start

**Error**: `dab: command not found`

**Solution**: Install Data API Builder globally:
```bash
dotnet tool install -g Microsoft.DataApiBuilder
```

### Database Connection Error

**Error**: Cannot connect to database

**Solution**: Set the connection string environment variable:
```bash
export DATABASE_CONNECTION_STRING="Server=your-server.database.windows.net;Database=AdventureWorks;..."
```

Or create a local SQL Server database with the AdventureWorks schema.

### Port Already in Use

**Error**: Port 5000 already in use

**Solution**: Kill the process using port 5000:
```bash
lsof -ti:5000 | xargs kill -9
```

Or change the port in `dab-config.json`:
```json
{
  "host": {
    "port": 5001  // Change to different port
  }
}
```

Then update `.env`:
```env
VITE_API_URL=http://localhost:5001/graphql
```

### CORS Still Failing

**Error**: Still getting CORS errors

**Solution**: 
1. Verify the API is running: `curl http://localhost:5000/graphql`
2. Check your `.env` file has the correct URL
3. Restart the Vite dev server after changing `.env`
4. Clear browser cache

## Multiple Terminals Workflow

For smooth development, you'll need 2 terminals:

**Terminal 1 - API Server**:
```bash
cd /workspaces/AdventureWorks/api
./start-local-api.sh
```

**Terminal 2 - Frontend App**:
```bash
cd /workspaces/AdventureWorks/app
npm run dev
```

## Testing the Local API

Once the API is running, test it:

```bash
# Test GraphQL
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ productCategories { items { ProductCategoryID Name } } }"}'

# Test REST
curl http://localhost:5000/api/ProductCategory
```

## Switching Between Local and Production

### For Local Development
```env
# .env
VITE_API_URL=http://localhost:5000/graphql
```

### For Testing Production API
```env
# .env
VITE_API_URL=https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql
```

**Note**: You won't be able to access the production API from localhost due to CORS and authentication restrictions.

## Production Deployment

When deploying to production:
1. The app uses the deployed API URL (set via Azure environment variables)
2. CORS is configured to allow the deployed app domain
3. Azure AD authentication is required
4. All communication happens within Azure (no CORS issues)

## Summary

For local development:
1. ✅ Run API locally with `./start-local-api.sh`
2. ✅ Use `VITE_API_URL=http://localhost:5000/graphql`
3. ✅ Development config allows CORS from any origin
4. ✅ No authentication required locally
5. ✅ Keep both API and frontend running in separate terminals
