# Quick Start Guide - Local Development

Follow these steps to run the AdventureWorks app locally with the GraphQL API.

## Prerequisites

- Node.js and npm installed
- .NET SDK installed (for Data API Builder)
- Azure CLI installed and logged in (`az login`)
- Azure resources already deployed (`azd up` completed)

## Step 1: One-Time Setup

Run the setup script to configure your local environment:

```bash
cd /workspaces/AdventureWorks
./setup-local-dev.sh
```

This will:
- Extract database connection information from Azure
- Create an `.env` file in the `api/` directory
- Configure the DATABASE_CONNECTION_STRING

## Step 2: Start the API Server

In a **new terminal**, start the local API server:

```bash
cd /workspaces/AdventureWorks/api
./start-local-api.sh
```

You should see:
```
Starting Data API Builder locally...
API will be available at: http://localhost:5000
GraphQL endpoint: http://localhost:5000/graphql
...
```

**Keep this terminal running!** The API server needs to stay active.

## Step 3: Start the Frontend App

In a **second terminal**, start the React app:

```bash
cd /workspaces/AdventureWorks/app
npm run dev
```

You should see:
```
VITE v5.4.19  ready in 264 ms
➜  Local:   http://localhost:8080/
```

## Step 4: Open the App

Open your browser to: **http://localhost:8080**

## Verify It's Working

1. **Check the home page loads** - You should see categories and featured products
2. **Open DevTools** (F12) → Network tab
3. **Look for GraphQL requests** - You should see requests to `http://localhost:5000/graphql`
4. **Check the console** - There should be no errors

## Troubleshooting

### CORS Error
If you still see CORS errors, verify:
- The API server is running at `http://localhost:5000`
- Your `/app/.env` file has: `VITE_API_URL=http://localhost:5000/graphql`
- You restarted the frontend after changing `.env`

### Database Connection Error
If the API can't connect to the database:
```bash
# Make sure you're logged into Azure CLI
az login

# Re-run the setup
./setup-local-dev.sh
```

### Port Already in Use
If port 5000 is already in use:
```bash
# Kill the process
lsof -ti:5000 | xargs kill -9

# Or change the port in api/dab-config.json
```

## Development Workflow

**Normal workflow** (after initial setup):

1. Open 2 terminals
2. **Terminal 1**: `cd api && ./start-local-api.sh`
3. **Terminal 2**: `cd app && npm run dev`
4. Browse to `http://localhost:8080`
5. Make changes to the code (both API and frontend will auto-reload)

## Testing the API Directly

Test the GraphQL endpoint:
```bash
curl -X POST http://localhost:5000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ productCategories { items { ProductCategoryID Name } } }"}'
```

Test the REST endpoint:
```bash
curl http://localhost:5000/api/ProductCategory
```

## Architecture

```
┌─────────────────────┐
│   Browser           │
│   localhost:8080    │
└──────────┬──────────┘
           │
           │ GraphQL Requests
           ▼
┌─────────────────────┐
│   API Server        │
│   localhost:5000    │
│   (DAB)             │
└──────────┬──────────┘
           │
           │ SQL Queries
           ▼
┌─────────────────────┐
│   Azure SQL         │
│   Database          │
│   AdventureWorks    │
└─────────────────────┘
```

## Stopping Everything

- **Stop the API**: Press `Ctrl+C` in the API terminal
- **Stop the frontend**: Press `Ctrl+C` in the app terminal

## Next Steps

Once everything is working:
- Make code changes (hot reload is enabled)
- Add new GraphQL queries
- Create new components
- Test new features

## Production Deployment

When ready to deploy:
```bash
cd /workspaces/AdventureWorks
azd deploy app
```

The production build will:
- Use the production API URL (from Azure environment)
- Include Azure AD authentication
- Have proper CORS configuration
- Use optimized production builds
