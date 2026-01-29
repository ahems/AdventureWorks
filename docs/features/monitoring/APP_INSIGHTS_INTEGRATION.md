# Application Insights Integration Summary

## Overview

Application Insights has been successfully integrated into the AdventureWorks e-commerce application to provide comprehensive telemetry tracking for user behavior, performance monitoring, and business analytics.

## Changes Made

### 1. Infrastructure Updates

#### Application Insights Configuration ([infra/modules/applicationinsights.bicep](../infra/modules/applicationinsights.bicep))

- **Changed**: `disableLocalAuth: false` (was `true`)
- **Removed**: Entra ID role assignments for managed identity authentication
- **Added**: Outputs for `instrumentationKey`, `connectionString`, `resourceId`, and `name`
- **Reason**: Browser-based apps cannot use Managed Identity authentication; key-based auth is required

#### Main Infrastructure ([infra/main.bicep](../infra/main.bicep))

- **Added**: `appInsightsConnectionString` parameter to Static Web App module call
- **Added**: Two new outputs:
  - `APPINSIGHTS_INSTRUMENTATIONKEY`
  - `APPINSIGHTS_CONNECTIONSTRING`

#### Static Web App Module ([infra/modules/swa-app.bicep](../infra/modules/swa-app.bicep))

- **Added**: `appInsightsConnectionString` parameter
- **Updated**: `functionappsettings` config to include `APPINSIGHTS_CONNECTIONSTRING`

### 2. Frontend Application

#### Package Dependencies

Installed two NPM packages (with `--legacy-peer-deps` for React 18 compatibility):

- `@microsoft/applicationinsights-web` - Core SDK
- `@microsoft/applicationinsights-react-js` - React Router integration

#### New Files Created

**[app/src/lib/appInsights.ts](src/lib/appInsights.ts)**

- Application Insights initialization logic
- Helper functions for tracking events, exceptions, metrics
- User context management (set/clear authenticated user)
- Automatically sets user context from localStorage on init

#### Files Modified

**[app/src/App.tsx](src/App.tsx)**

- Imports Application Insights context provider
- Wraps entire app with `AppInsightsContext.Provider`
- Initializes Application Insights on app load

**[app/src/context/AuthContext.tsx](src/context/AuthContext.tsx)**

- Tracks `User_Login` events with userId and email
- Tracks `User_Signup` events with userId and email
- Tracks `User_Logout` events with userId
- Sets/clears authenticated user context in Application Insights

**[app/src/context/CartContext.tsx](src/context/CartContext.tsx)**

- Tracks `Product_AddToCart` events with:
  - productId, productName, quantity, price
  - Optional: size, color

**[app/src/pages/ProductPage.tsx](src/pages/ProductPage.tsx)**

- Tracks `Product_View` events with:
  - productId, productName, category, subcategory, price

**[app/src/pages/CheckoutPage.tsx](src/pages/CheckoutPage.tsx)**

- Tracks `Purchase_Complete` events with:
  - orderId, customerId, revenue, tax, shipping
  - itemCount, paymentMethod, currencyCode
  - Full list of purchased items with details

**[app/src/vite-env.d.ts](src/vite-env.d.ts)**

- Added `APPINSIGHTS_CONNECTIONSTRING` to `AppConfig` interface

#### Configuration Files

**[app/scripts/update-config.js](scripts/update-config.js)**

- Added `VITE_APPINSIGHTS_CONNECTIONSTRING` environment variable support
- Writes connection string to runtime config.js

**[app/public/config.js](public/config.js)**

- Added `APPINSIGHTS_CONNECTIONSTRING` field to `window.APP_CONFIG`

### 3. Documentation

**[app/APPLICATION_INSIGHTS.md](APPLICATION_INSIGHTS.md)**

- Complete documentation of the Application Insights integration
- Usage examples for custom tracking
- Sample Kusto queries for analytics
- Configuration and deployment details

## Tracked Events Summary

| Event Name          | Triggered When                 | Key Properties                                                  |
| ------------------- | ------------------------------ | --------------------------------------------------------------- |
| `User_Login`        | User successfully logs in      | userId, email                                                   |
| `User_Signup`       | New user creates account       | userId, email                                                   |
| `User_Logout`       | User logs out                  | userId                                                          |
| `Product_View`      | User views product detail page | productId, productName, category, subcategory, price            |
| `Product_AddToCart` | User adds product to cart      | productId, productName, quantity, price, size, color            |
| `Purchase_Complete` | User completes checkout        | orderId, customerId, revenue, tax, shipping, itemCount, items[] |

## Automatic Tracking

Application Insights automatically tracks:

- **Page Views**: All React Router navigation
- **AJAX Calls**: All GraphQL API requests
- **Performance**: Page load times, resource timing
- **Exceptions**: Unhandled JavaScript errors
- **User Behavior**: Click paths, session duration

## Deployment

### Local Development

1. No connection string required - telemetry disabled gracefully
2. Console warning shown if connection string not provided
3. All tracking functions are no-ops when disabled

### Azure Deployment

1. Run `azd up` to deploy infrastructure
2. Application Insights connection string automatically injected
3. Static Web App receives connection string via environment config
4. Build process updates `config.js` with connection string
5. App initializes telemetry on first load

## Testing

To verify Application Insights is working:

1. **Check Browser Console**: Should see `[App Insights] Initialized successfully`
2. **Azure Portal**: Navigate to Application Insights → Live Metrics
3. **Perform Actions**: Login, view products, add to cart, checkout
4. **View Telemetry**: Check Events in Application Insights portal

## Analytics Queries

Example Kusto queries to analyze data:

```kusto
// Conversion funnel
customEvents
| where name in ('Product_View', 'Product_AddToCart', 'Purchase_Complete')
| summarize count() by name

// Most viewed products
customEvents
| where name == 'Product_View'
| summarize views = count() by productName = tostring(customDimensions.productName)
| top 10 by views desc

// Average order value
customEvents
| where name == 'Purchase_Complete'
| summarize avg(todouble(customDimensions.revenue))
```

## Security Note

Application Insights connection strings are **not secrets**. They are safe to expose in client-side code as they only allow sending telemetry data to Application Insights, not reading or modifying existing data.

## Next Steps (Optional Enhancements)

1. Add tracking for search queries
2. Track wishlist additions
3. Track product comparison usage
4. Add custom metrics for cart abandonment
5. Create Application Insights alerts for anomalies
6. Set up availability tests for uptime monitoring
