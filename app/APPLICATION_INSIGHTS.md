# Application Insights Integration

Application Insights has been integrated into the AdventureWorks frontend to track user behavior, performance, and custom telemetry events.

## Features

### Automatic Tracking

- **Page Views**: Automatically tracks all page navigation via React Router
- **AJAX Calls**: Tracks all API calls to the GraphQL backend
- **Performance**: Monitors page load times and application performance
- **Exceptions**: Captures and reports JavaScript errors

### Custom Event Tracking

The following custom events are tracked:

#### User Authentication

- `User_Login` - When a user successfully logs in
  - Properties: `userId`, `email`
- `User_Signup` - When a new user creates an account
  - Properties: `userId`, `email`
- `User_Logout` - When a user logs out
  - Properties: `userId`

#### Product Interactions

- `Product_View` - When a user views a product detail page
  - Properties: `productId`, `productName`, `category`, `subcategory`, `price`
- `Product_AddToCart` - When a user adds a product to their cart
  - Properties: `productId`, `productName`, `quantity`, `price`, `size`, `color`

#### E-Commerce

- `Purchase_Complete` - When a user completes a purchase
  - Properties: `orderId`, `customerId`, `revenue`, `tax`, `shipping`, `itemCount`, `paymentMethod`, `currencyCode`, `items[]`

## Configuration

### Local Development

For local development, Application Insights is optional. If no connection string is provided in the environment variables, telemetry will be disabled with a console warning.

### Azure Deployment

The Application Insights connection string is automatically injected during deployment via the infrastructure pipeline:

1. The Bicep infrastructure creates the Application Insights resource
2. The connection string is passed to the Static Web App configuration
3. The `config.js` file is updated during build with the connection string
4. The app initializes Application Insights on load

### Environment Variables

- `VITE_APPINSIGHTS_CONNECTIONSTRING` - Application Insights connection string (optional for local dev)

## Files Modified

### Infrastructure

- `/infra/modules/applicationinsights.bicep` - Updated to use key-based auth instead of Entra ID
- `/infra/modules/swa-app.bicep` - Added `appInsightsConnectionString` parameter
- `/infra/main.bicep` - Passes connection string to frontend module

### Application Code

- `/app/src/lib/appInsights.ts` - Application Insights initialization and helper functions
- `/app/src/App.tsx` - Wraps app with `AppInsightsContext`
- `/app/src/context/AuthContext.tsx` - Tracks login/logout events
- `/app/src/context/CartContext.tsx` - Tracks add to cart events
- `/app/src/pages/ProductPage.tsx` - Tracks product views
- `/app/src/pages/CheckoutPage.tsx` - Tracks purchase completions

### Configuration

- `/app/scripts/update-config.js` - Updated to include App Insights connection string
- `/app/public/config.js` - Runtime config with connection string

## Usage

### Tracking Custom Events

```typescript
import { trackEvent } from "@/lib/appInsights";

// Track a simple event
trackEvent("Button_Click", { buttonName: "subscribe" });

// Track with properties
trackEvent("Search", {
  query: "mountain bike",
  resultsCount: 42,
  filterCategory: "bikes",
});
```

### Tracking Exceptions

```typescript
import { trackException } from "@/lib/appInsights";

try {
  // Your code
} catch (error) {
  trackException(error as Error, {
    context: "ProductPage",
    productId: 123,
  });
}
```

### Setting User Context

```typescript
import { setUserContext, clearUserContext } from "@/lib/appInsights";

// After successful login
setUserContext(userId);

// After logout
clearUserContext();
```

## Viewing Telemetry

### Azure Portal

1. Navigate to your Application Insights resource in the Azure Portal
2. View telemetry in various sections:
   - **Live Metrics** - Real-time telemetry stream
   - **Application map** - Dependency visualization
   - **Performance** - Page load times and AJAX calls
   - **Failures** - Exceptions and failed requests
   - **Users/Events/Cohorts** - User behavior analysis

### Sample Queries (Log Analytics)

```kusto
// View all custom events
customEvents
| where timestamp > ago(24h)
| summarize count() by name
| order by count_ desc

// Track conversion funnel
customEvents
| where name in ('Product_View', 'Product_AddToCart', 'Purchase_Complete')
| summarize count() by name

// Average order value
customEvents
| where name == 'Purchase_Complete'
| summarize avg(todouble(customDimensions.revenue))

// Most viewed products
customEvents
| where name == 'Product_View'
| summarize viewCount = count() by productId = tostring(customDimensions.productId), productName = tostring(customDimensions.productName)
| order by viewCount desc
| take 10
```

## Authentication Change

The infrastructure was updated to use **key-based authentication** instead of Entra ID authentication (`disableLocalAuth: false`). This allows the browser-based React app to authenticate using the connection string without requiring managed identity or user authentication.

## NPM Packages

- `@microsoft/applicationinsights-web` - Core Application Insights SDK
- `@microsoft/applicationinsights-react-js` - React-specific plugin for router tracking

Installed with `--legacy-peer-deps` to work with React 18.
