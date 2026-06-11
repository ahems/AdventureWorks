# Reporting Feature

The Reports page in the admin portal provides pre-aggregated charts across the full AdventureWorks dataset. It bypasses the DAB GraphQL 100-item pagination limit by querying Azure SQL directly from Azure Functions.

## Architecture

```
app-admin (Container App)
  └── /reports page (React + Recharts)
        └── useReportingData hooks
              └── Azure Functions (api-functions Container App)
                    └── ReportingFunctions.cs → ReportingService.cs
                          └── Azure SQL (GROUP BY / SUM aggregates)
```

DAB returns at most 100 rows per request and has no `GROUP BY` support. The Functions tier aggregates server-side and returns ~10–20 rows per endpoint — making the chart data small, fast, and independent of dataset size.

## Endpoints

All endpoints are HTTP GET, `AuthorizationLevel.Anonymous`, under the `/api/reporting/` prefix.

| Route                             | SQL tables                                                                                                         | Returns                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `reporting/revenue-by-category`   | `Sales.SalesOrderDetail`, `Production.Product`, `Production.ProductSubcategory`, `Production.ProductCategory`      | `[{ categoryName, revenue }]`                                 |
| `reporting/monthly-trend`         | `Sales.SalesOrderHeader`, last 12 months                                                                           | `[{ year, month, revenue, orderCount }]`                      |
| `reporting/top-products?limit=N`  | `Sales.SalesOrderDetail`, `Production.Product`, default top 10                                                     | `[{ productName, revenue, unitsSold }]`                       |
| `reporting/orders-by-status`      | `Sales.SalesOrderHeader`                                                                                           | `[{ status, orderCount }]`                                    |
| `reporting/revenue-by-territory`  | `Sales.SalesOrderHeader`, `Sales.SalesTerritory`                                                                   | `[{ territoryName, countryRegionCode, revenue, orderCount }]` |
| `reporting/inventory-by-category` | `Production.ProductInventory`, `Production.Product`, `Production.ProductSubcategory`, `Production.ProductCategory` | `[{ categoryName, totalQuantity, productCount }]`             |

## Source Files

### Backend

| File                                            | Purpose                                                |
| ----------------------------------------------- | ------------------------------------------------------ |
| `api-functions/Services/ReportingService.cs`    | 6 Dapper methods returning pre-aggregated record types |
| `api-functions/Functions/ReportingFunctions.cs` | 6 HTTP trigger functions wrapping `ReportingService`   |
| `api-functions/Program.cs`                      | DI registration — `AddScoped<ReportingService>`        |

### Frontend

| File                                       | Purpose                                |
| ------------------------------------------ | -------------------------------------- |
| `app-admin/src/hooks/useReportingData.ts`  | 6 React Query hooks + typed interfaces |
| `app-admin/src/pages/ReportsPage.tsx`      | Full page with 6 Recharts panels       |
| `app-admin/src/components/AdminHeader.tsx` | "Reports" nav link (BarChart3 icon)    |
| `app-admin/src/App.tsx`                    | `/reports` route                       |

## Caching

All hooks use `staleTime: 15 * 60 * 1000` (15 minutes). Aggregate revenue data changes infrequently; background refetch happens automatically once the cache expires.

## Adding a New Report

1. **SQL query** — Add a new `async Task<IEnumerable<TRecord>> GetXxx()` method in `ReportingService.cs`. Use a parameterized Dapper query. Define the return record type in the same file.

2. **Function** — Add a new `[Function("ReportXxx")]` method in `ReportingFunctions.cs` with route `"reporting/xxx"`.

3. **Hook** — Add a typed interface and `useXxxData` hook in `useReportingData.ts`.

4. **Chart** — Add a `<ChartCard>` component in `ReportsPage.tsx` and include it in the responsive grid.

5. **Deploy** — `azd deploy api-functions` (backend), then `azd deploy app-admin` (frontend).

## Deployment

```bash
# Deploy the Functions (backend SQL queries)
azd deploy api-functions

# Deploy the admin portal (frontend)
azd deploy app-admin
```

Both use ACR remote build and deploy to Azure Container Apps.
