# Bank Simulator

## Overview

The bank simulator provides a multi-currency virtual banking layer for the AdventureWorks simulation environment. It tracks the financial position of the simulated business across all currencies supported by the website, allowing AI agents to model realistic cash flow scenarios alongside the manufacturing and supply chain simulators.

### Key behaviours

- **On first use**: tables are created in Azure Table Storage and the USD account is seeded with the total historical profit from `EXEC [Sales].[usp_GetTotalProfit]`.
- **One account per currency**: every currency in `Sales.Currency` gets its own virtual account. Foreign-currency sales (e.g. a EUR sale) update the EUR account; they do not touch the USD account.
- **USD-only purchases**: vendor payments and payroll always debit the USD account.
- **Exchange rate conversion**: a total USD-equivalent figure is calculated on-demand using the most recent `Sales.CurrencyRate` record for each non-USD currency (`AverageRate` = foreign units per 1 USD, so `USD = foreignAmount / AverageRate`).
- **Negative balances allowed**: no overdraft limits, interest, or transaction fees.
- **Optimistic concurrency**: account updates use Azure Table Storage ETags to prevent lost-update races.
- **Scale-to-zero safe**: all state lives in Table Storage; the underlying Azure Functions container can scale to zero between requests.

---

## Architecture

```
Client / MCP Agent
        │
        ▼
  GET/POST /api/bank/*          ← BankControlFunction (Azure Functions)
        │
        ▼
  BankService                   ← business logic, Table Storage, SQL
    ├── awBankAccounts           (Azure Table Storage — one row per currency)
    └── awBankTransactions       (Azure Table Storage — one row per transaction)
        │
        └── Sales.CurrencyRate   (Azure SQL — latest exchange rates for USD totals)
            Sales.Currency       (Azure SQL — supported currency list)
            Sales.usp_GetTotalProfit  (Azure SQL — seed value on first run)
```

### Simulator integration

The bank is now integrated with the Supply Chain and Manufacturing simulators so that real business events automatically flow through the virtual accounts:

| Event                       | Bank transaction                                   | Reference prefix   |
| --------------------------- | -------------------------------------------------- | ------------------ |
| PO approved                 | USD debit for `TotalDue` (unit cost + freight)     | `PO-{id}`          |
| PO rejected (from approved) | USD credit refund                                  | `PO-{id}-refund`   |
| Work order completed        | USD debit for total `ActualCost` from routing      | `WO-{id}`          |
| Routing operation completed | USD payroll debit (operator hours × hourly rate)   | `WO-{id}-OP-{seq}` |
| Scrap event                 | USD write-off at `ProductCostHistory.StandardCost` | `SCRAP-WO-{id}`    |

All bank calls are non-blocking — if Table Storage is temporarily unavailable, the simulator operation continues and a warning is logged.

### MCP exposure

```
MCP Server (api-mcp)
  ├── BankMcpTools
  │     ├── GetBankStatus             → GET /api/bank/status
  │     ├── GetBankAccount            → GET /api/bank/accounts/{code}
  │     ├── GetBankTransactions       → GET /api/bank/transactions[/{code}]
  │     ├── BankDeposit               → POST /api/bank/deposit
  │     ├── BankWithdraw              → POST /api/bank/withdraw
  │     ├── GetSupportedCurrencies    → GET /api/bank/currencies
  │     ├── GetFinancialSummary       → GET /api/financials/summary
  │     ├── GetProcurementTransactions→ GET /api/financials/procurement
  │     └── GetManufacturingFinancials→ GET /api/financials/manufacturing
  └── SimulatorMcpTools
        └── ResetAllSimulators        → POST /api/simulators/reset
```

---

## Azure Table Storage schema

### `awBankAccounts`

| Attribute    | Type    | Notes                                          |
| ------------ | ------- | ---------------------------------------------- |
| PartitionKey | string  | Always `"accounts"`                            |
| RowKey       | string  | ISO 4217 currency code (e.g. `"USD"`, `"EUR"`) |
| Balance      | decimal | Current balance in that currency               |
| CurrencyName | string  | Full currency name (e.g. `"Euro"`)             |

### `awBankTransactions`

| Attribute       | Type           | Notes                                                                                  |
| --------------- | -------------- | -------------------------------------------------------------------------------------- |
| PartitionKey    | string         | ISO 4217 currency code                                                                 |
| RowKey          | string         | Reverse-chronological sort key (`{MaxLong - ticks:D20}~{Guid}`)                        |
| Amount          | decimal        | Positive = credit, negative = debit                                                    |
| BalanceAfter    | decimal        | Running balance in that currency after this transaction                                |
| TransactionType | string         | `initial` \| `sale` \| `purchase` \| `payroll` \| `deposit` \| `withdrawal` \| `other` |
| Description     | string         | Human-readable reason for the transaction                                              |
| ReferenceId     | string?        | Optional link to originating event (sales order ID, PO number, etc.)                   |
| TransactedAtUtc | DateTimeOffset | UTC timestamp of the transaction                                                       |

---

## REST API reference

All routes are under `/api/bank/`. Authentication: `Anonymous` (same as other simulator endpoints).

### `GET /api/bank/status`

Returns all account balances plus a live USD-equivalent total.

**Response**

```json
{
  "accounts": [
    { "currencyCode": "EUR", "currencyName": "Euro", "balance": 12345.67 },
    { "currencyCode": "USD", "currencyName": "US Dollar", "balance": 987654.32 }
  ],
  "totalUsd": 1001234.56,
  "reportedAtUtc": "2026-04-16T12:00:00Z"
}
```

---

### `GET /api/bank/accounts`

Returns all currency account balances (array).

---

### `GET /api/bank/accounts/{currencyCode}`

Returns the balance for a single currency (e.g. `/api/bank/accounts/EUR`).

---

### `GET /api/bank/transactions[?maxCount=50]`

Returns the most recent transactions across all currencies, ordered by time descending.

- `maxCount`: 1–200, default 50.

---

### `GET /api/bank/transactions/{currencyCode}[?maxCount=50]`

Returns recent transactions for a single currency.

---

### `POST /api/bank/deposit`

Credits an amount to a currency account. Positive amounts only.

**Request body**

```json
{
  "currencyCode": "EUR",
  "amount": 1500.0,
  "description": "Customer sale SO-12345",
  "referenceId": "SO-12345",
  "transactionType": "sale"
}
```

**Response**: the recorded `BankTransaction` object.

---

### `POST /api/bank/withdraw`

Debits an amount from a currency account. Negative balances are permitted.

**Request body**

```json
{
  "currencyCode": "USD",
  "amount": 3200.0,
  "description": "Vendor payment PO-789",
  "referenceId": "PO-789",
  "transactionType": "purchase"
}
```

**Response**: the recorded `BankTransaction` object (amount will be stored as negative).

---

### `GET /api/bank/currencies`

Lists all currencies from `Sales.Currency` (the full set supported by the website).

---

## Financial Reporting API

Three endpoints expose bank transaction history segmented by simulator domain. All are read-only and require no body.

### `GET /api/financials/summary`

Aggregated financial summary across all simulators.

**Response**

```json
{
  "procurement": {
    "totalSpend": 142500.0,
    "totalRefunds": 3200.0,
    "netSpend": 139300.0,
    "transactionCount": 48
  },
  "manufacturing": {
    "totalCost": 28940.5,
    "transactionCount": 15
  },
  "payroll": {
    "totalCost": 9870.25,
    "transactionCount": 92
  },
  "scrap": {
    "totalWriteOffs": 1240.0,
    "transactionCount": 7
  },
  "totals": {
    "totalOperatingCost": 40050.75,
    "totalAllSpend": 182550.75
  },
  "generatedAtUtc": "2026-04-19T10:00:00Z"
}
```

---

### `GET /api/financials/procurement[?maxCount=50]`

Returns recent procurement transactions (PO approval debits and refunds). `maxCount` 1–500, default 50.

---

### `GET /api/financials/manufacturing[?maxCount=50&type=all]`

Returns recent manufacturing financial transactions.

| `type` value    | Content returned                        |
| --------------- | --------------------------------------- |
| `all` (default) | All manufacturing-related transactions  |
| `completions`   | WO completion overhead charges (`WO-*`) |
| `payroll`       | Per-operation labour charges            |
| `scrap`         | Scrap write-offs (`SCRAP-WO-*`)         |

---

## Coordinated Reset

### `POST /api/simulators/reset`

Resets **all three simulators together** in the correct order:

1. Clears the manufacturing work-order queue.
2. Resets the supply chain — reverts POs and re-seeds vendor stock.
3. Resets the bank — wipes all transactions and re-seeds the USD balance.

**Destructive** — all bank history, vendor stock, and in-flight work orders are permanently deleted.

Use this instead of individual resets to avoid orphaned bank transactions (e.g. a PO that was approved and debited, but whose supply-chain records are then wiped by an isolated supply-chain reset).

**Response**

```json
{
  "message": "Simulator reset complete.",
  "steps": [
    "Manufacturing queue cleared.",
    "Supply chain reset. Vendor stock re-seeded.",
    "Bank reset and re-seeded. New USD total: $1,234,567.89"
  ],
  "resetAtUtc": "2026-04-19T10:00:00Z"
}
```

---

## MCP tools reference

### Bank tools (`BankMcpTools`)

| Tool                         | Description                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GetBankStatus`              | All currency balances + USD total. Use to check the current financial position.                       |
| `GetBankAccount`             | Balance for a single currency (e.g. `"EUR"`).                                                         |
| `GetBankTransactions`        | Recent transactions, optionally filtered by currency code. Default 20, max 200.                       |
| `BankDeposit`                | Record incoming money. Use `transactionType: "sale"` for customer revenue.                            |
| `BankWithdraw`               | Record outgoing money. Vendor payments → `transactionType: "purchase"`, always `currencyCode: "USD"`. |
| `GetSupportedCurrencies`     | List all valid currency codes from the website database.                                              |
| `GetFinancialSummary`        | Aggregated spend across procurement, manufacturing, payroll, and scrap.                               |
| `GetProcurementTransactions` | Recent PO payment and refund transactions.                                                            |
| `GetManufacturingFinancials` | Recent manufacturing financial transactions, filterable by type (`completions`, `payroll`, `scrap`).  |

### Simulator control tools (`SimulatorMcpTools`)

| Tool                 | Description                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- |
| `ResetAllSimulators` | Reset manufacturing queue + supply chain + bank together. **Deletes all history.** |

---

## Simulation rules

| Rule                          | Behaviour                                                          |
| ----------------------------- | ------------------------------------------------------------------ |
| Currency for sales            | Use the currency the customer paid in (e.g. EUR, GBP, CAD)         |
| Currency for vendor payments  | Always USD                                                         |
| Currency for payroll          | Always USD                                                         |
| Currency for scrap write-offs | Always USD                                                         |
| PO debit timing               | At approval (`status → 2`); refund issued if subsequently rejected |
| WO completion charge          | Sum of all `WorkOrderRouting.ActualCost` rows                      |
| Payroll charge                | Per routing operation: `ActualResourceHrs × AssignedHourlyRate`    |
| Scrap write-off amount        | `ProductCostHistory.StandardCost × ScrappedQty`                    |
| Negative balances             | Allowed — no limit, no interest                                    |
| Overdraft charges             | None                                                               |
| Interest on positive balances | None                                                               |
| Transaction fees              | None                                                               |
| Exchange rates                | Most recent `Sales.CurrencyRate` record; missing rate → face value |

---

## Implementation notes

- **Azure Table Storage decimal limitation** — Table Storage has no native `decimal` type. The `BankAccountEntity.Balance`, `BankTransactionEntity.Amount`, and `BankTransactionEntity.BalanceAfter` fields are stored as `double` (mapped to `Edm.Double`). Explicit `(decimal)↔(double)` casts exist at the service boundary. Practical precision is 15–16 significant digits which is sufficient for monetary simulation.

---

## Local development

The bank simulator uses the same Azure Table Storage account as the manufacturing and supply chain simulators (`AzureWebJobsStorage:tableServiceUri`). No additional configuration is required.

1. Start the functions host: `func: host start` task (or `func host start` in `api-functions/`).
2. Trigger initialization: `GET http://localhost:7071/api/bank/status`
3. Tables `awBankAccounts` and `awBankTransactions` are created automatically on first call.
