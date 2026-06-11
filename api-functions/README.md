# AdventureWorks Azure Functions (`api-functions`)

This project contains the serverless backend for the AdventureWorks e‑commerce demo. It runs as .NET 8 isolated Azure Functions (usually hosted in Azure Container Apps) and complements the Data API Builder (`api/`) and Static Web App frontend (`app/`).

High‑level responsibilities:

- Expose HTTP APIs that are not a good fit for DAB (AI, receipts, email, SEO, passwords).
- Run durable/background workflows for AI enrichment, translations, and document generation.
- Integrate with Azure OpenAI / Azure AI, Azure Storage (Blobs & Queues), Azure Communication Services, and Azure SQL via managed identity.

> **Note**: Function _names_ below refer to the `[Function("...")]` attribute and may differ from class or method names.

---

## AI Agent Functions

### `AIAgentChat`

- **Trigger / Route**: HTTP `POST /api/agent/chat`
- **Purpose**: Front-door chat endpoint for the AI support agent. Accepts a message, optional conversation history, customer metadata (`customerId`, `cultureId`), and an optional `threadId` for multi-turn conversation persistence. Forwards to `AIAgentService`, which invokes an Azure AI Foundry "kind: prompt" agent via the Responses API. Customer and culture context is passed as **structured inputs** (`{{customerId}}` / `{{cultureId}}` Handlebars templates in the agent's Foundry portal instructions) rather than being embedded in the user message. Memory is scoped per customer via the `x-memory-user-id` header. Returns the agent's reply, suggested follow-up questions, tools used, and the `threadId` (Foundry response ID) for the next request. Emits rich Application Insights telemetry for observability.

### `AIAgentStatus`

- **Trigger / Route**: HTTP `GET /api/agent/status`
- **Purpose**: Lightweight health/config endpoint for the AI agent. Returns static metadata such as agent status, framework version (`Azure.AI.Foundry`), and enabled capabilities (`foundry-responses-api`, `structured-inputs`, `memory-scoping`, `tool-choice-required`, `dual-mcp-servers`, `multi-turn-persistence`). Useful for smoke tests and diagnostics.

### AI Foundry Features Used by Agent Functions

All AI Foundry agent calls share the `FoundryAgentClient` singleton, which leverages these Responses API features:

| Feature                   | How it's used                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store: true`             | Every response is persisted by Foundry; enables memory and conversation history                                                                                                                                           |
| `previous_response_id`    | Chains multi-turn conversations (replaces thread/session management in the client)                                                                                                                                        |
| `x-memory-user-id`        | Scopes Foundry memory per user or persona so agents recall prior interactions                                                                                                                                             |
| `structured_inputs`       | Resolves `{{variable}}` Handlebars placeholders declared in each agent's Foundry portal definition at runtime — avoids duplicating agent versions for different customers or contexts                                     |
| `tool_choice: "required"` | Forces MCP tool calls for agents whose output depends on live catalog/inventory data (Help-Me-Choose, Order Generation, Promotion Generation) — prevents hallucinated product IDs or prices being written to the database |

**Per-agent configuration:**

| Agent                                            | Memory `userId`                                         | `tool_choice` | Structured input variables                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Chat (`AIAgentService`)                          | Customer ID                                             | auto (null)   | `customerId`, `cultureId`                                                                                                           |
| Help-Me-Choose (`HelpMeChooseService`)           | Customer ID                                             | `required`    | _(declared in portal)_                                                                                                              |
| Order Generation (`OrderGenerationAgentService`) | `order-gen-customer-{id}` or `order-gen-persona-{type}` | `required`    | `todayDate`, `personaDescription`, `isExistingCustomer`, `customerName`, `customerId`, `orderCount`, `totalSpend`, `recentProducts` |
| Promotion Generation (`PromotionAgentService`)   | `promotion-gen-{type}`                                  | `required`    | `promotionType`, `offerCategory`, `todayDate`, `categoryName`, `subcategoryName`, `categoryId`, `subcategoryId`                     |

> **Foundry portal prerequisite**: The `structured_inputs` schema (declaring each variable name and type) **must be added to each agent's definition in the Foundry portal** before the Handlebars templates in the instructions will resolve. See [docs/features/ai-agent/AI_AGENT_AUTOMATION.md](../docs/features/ai-agent/AI_AGENT_AUTOMATION.md) for details.

---

## Address Management Functions

### `GetAddresses`

- **Trigger / Route**: HTTP `GET /api/addresses?limit={int}&offset={int}`
- **Purpose**: Returns a paginated list of customer addresses from AdventureWorks via `AddressService`. Intended for frontend address management screens.

### `GetAddressById`

- **Trigger / Route**: HTTP `GET /api/addresses/{id}`
- **Purpose**: Fetches a single address by ID, returning `404` if not found.

### `CreateAddress`

- **Trigger / Route**: HTTP `POST /api/addresses`
- **Purpose**: Validates and inserts a new address record. Ensures required fields (line 1, city, postal code, state/province) are present and that `StateProvinceID` is positive.

### `UpdateAddress`

- **Trigger / Route**: HTTP `PUT /api/addresses/{id}`
- **Purpose**: Updates an existing address. Returns `404` if the address does not exist.

### `DeleteAddress`

- **Trigger / Route**: HTTP `DELETE /api/addresses/{id}`
- **Purpose**: Deletes an address by ID. Returns `204` on success, `404` if missing.

---

## Password & Identity Functions

### `SetPassword`

- **Trigger / Route**: HTTP `POST /api/password`
- **Purpose**: Sets or updates a PBKDF2‑hashed password for a `BusinessEntityID` via `PasswordService`. Performs basic validation (non‑empty, min length) before persisting hash and salt into the `Person.Password` table.

### `VerifyPassword`

- **Trigger / Route**: HTTP `POST /api/password/verify`
- **Purpose**: Verifies a plaintext password for a given `BusinessEntityID` by recomputing the PBKDF2 hash and comparing it with stored values. Returns a structured `IsValid`/`Message` payload.

### `RequestPasswordReset`

- **Trigger / Route**: HTTP `POST /api/password/reset/request`
- **Purpose**: Starts the password reset flow. Looks up a person by email, generates a short‑lived token stored in `Person.Password.PasswordSalt`, builds a frontend reset URL, and sends a reset email via `EmailService`. Always returns a generic success message to avoid leaking user existence.

### `ValidateResetToken`

- **Trigger / Route**: HTTP `POST /api/password/reset/validate`
- **Purpose**: Validates a reset token for a given `BusinessEntityID` by checking both the stored token and its 1‑hour expiry window.

### `ResetPassword`

- **Trigger / Route**: HTTP `POST /api/password/reset/complete`
- **Purpose**: Completes the reset flow. Validates token and new password strength, then calls `PasswordService.StorePasswordAsync` to write a new PBKDF2 hash and salt, effectively clearing the temporary reset token.

---

## Order Receipt & Email Functions

### `GenerateOrderReceipts_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateOrderReceipts_HttpStart`
- **Purpose**: Front‑door for receipt generation. Accepts either a single `salesOrderId` or multiple `salesOrderNumbers`, then enqueues one message per order onto the `order-receipt-generation` storage queue using managed identity.

### `GenerateOrderReceipts_QueueTrigger`

- **Trigger**: Queue `order-receipt-generation`
- **Purpose**: For each queued order, loads receipt data via `ReceiptService`, generates a PDF with `PdfReceiptGenerator`, and uploads it to blob storage. If email metadata is attached, enqueues an `order-email-generation` message to trigger downstream email delivery.

### `GenerateAndSendReceipt`

- **Trigger / Route**: HTTP `POST /api/orders/generate-and-send-receipt`
- **Purpose**: Convenience endpoint that validates order/customer/email IDs and then asynchronously kicks off the receipt workflow. It enqueues an `order-receipt-generation` message (with email metadata) and returns `202 Accepted` immediately.

### `SendOrderEmail_QueueTrigger`

- **Trigger**: Queue `order-email-generation`
- **Purpose**: After a receipt PDF exists, this function loads receipt data, constructs a rich order‑confirmation email (including a link to the receipt PDF in blob storage), and sends it via `EmailService` (Azure Communication Services).

### `SendCustomerEmail`

- **Trigger / Route**: HTTP `POST /api/customers/{customerId}/send-email`
- **Purpose**: Generic email‑sending endpoint. Validates that the email address ID and content are present, then uses `EmailService` to send an email (optionally with a storage attachment URL) to the given customer.

---

## Sales Order Status Processing

Demo pipeline that simulates order lifecycle (In Process → Approved/Rejected → Shipped or Backordered) via the `sales-order-status` queue. Used to demonstrate queue‑driven workflows and optional “pretend‑shipped” email. The frontend calls `BeginProcessingOrder` when an order is placed so processing starts automatically.

**Seed script**: To enqueue messages for all existing orders that are still In Process (Status 1), use [scripts/utilities/seed-sales-order-status-queue.sh](../scripts/utilities/seed-sales-order-status-queue.sh). It reads configuration from `azd env` (DAB URL, storage account, resource group), queries the DAB REST API for orders with `Status = 1`, and sends one message per order to the `sales-order-status` queue so the Functions process them as if they had just been placed. Use `--dry-run` to list orders without sending messages. Requires `az login` and `jq`; optional `DAB_ACCESS_TOKEN` if the DAB API requires auth.

### `BeginProcessingOrder`

- **Trigger / Route**: HTTP `POST /api/orders/begin-processing-order`
- **Purpose**: Entry point to start the order status pipeline. Accepts a body with `salesOrderId` (or `SalesOrderID`), validates it is positive, then enqueues a single message onto the `sales-order-status` queue with `{ "SalesOrderID": <id>, "Status": 1 }` and a random visibility timeout between 5 minutes and 1 hour. Returns `202 Accepted` with a short JSON body. Called by the order confirmation page after checkout so the demo pipeline runs without user action.

### `ProcessSalesOrderStatus_QueueTrigger`

- **Trigger**: Queue `sales-order-status`
- **Purpose**: Processes each message (JSON with `SalesOrderID` and `Status`). Implements a state machine over `Sales.SalesOrderHeader.Status`: from **1 (In Process)** moves to **2 (Approved)** (95%) or **4 (Rejected)** (5%); from **2 (Approved)** moves to **3 (Backordered)** (10%) or **5 (Shipped)** (90%); when a **3 (Backordered)** message is picked up after its visibility delay, the order is set to **5 (Shipped)**. For each transition the function updates the database, then either re‑queues the next step with a visibility timeout (1–12 hours for Approved, 2–4 days for Backordered) or stops (terminal statuses 4, 5, 6). When status becomes **5 (Shipped)**, it looks up the customer email via `OrderService.GetCustomerEmailInfoBySalesOrderIdAsync` and sends a “pretend‑shipped” demo email via `EmailService`. If the order no longer exists (e.g. removed by the seed job), the function logs “Order not found” and completes successfully so the message is removed without retry or poison queue.

---

## Product Media Functions (Images & Thumbnails)

### `GenerateProductImages_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductImages_HttpStart`
- **Purpose**: Clears the `product-image-generation` and `product-thumbnail-generation` queues (including poison queues), finds products that still need images, and enqueues one message per product for image generation.

### `GenerateProductImages_QueueTrigger`

- **Trigger**: Queue `product-image-generation`
- **Purpose**: For each product needing images, calls `AIService.GenerateProductImagesAsync` to generate up to 4 product photos with rate‑limit aware retry logic, saves them via `ProductService`, and then enqueues thumbnail jobs onto `product-thumbnail-generation`.

### `GenerateProductThumbnails_QueueTrigger`

- **Trigger**: Queue `product-thumbnail-generation`
- **Purpose**: Loads stored product photos, generates 200x200 thumbnails with ImageSharp, and persists them back to SQL via `ProductService.SaveProductThumbnailAsync`, ensuring idempotency if a thumbnail already exists.

---

## AI Enrichment & Embeddings

### `EmbellishProductsUsingAI_HttpStart`

- **Trigger / Route**: HTTP `POST /api/EmbellishProductsUsingAI_HttpStart`
- **Purpose**: Starts a Durable orchestration that enhances product marketing content using AI. Optionally accepts a list of product IDs to target.

### `EmbellishProductsUsingAI_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: Orchestrates the embellishment workflow:
  - Fetch finished‑goods products (`FetchProductsActivity`).
  - Enhance them with AI (`EnhanceProductsWithAIActivity`) in batches.
  - Persist enhanced content (`UpdateProductsActivity`).
  - Trigger `TranslateProductDescriptions_Orchestrator` for affected product models.

### `FetchProductsActivity`

- **Trigger**: Durable activity
- **Purpose**: Uses `ProductService` to read finished‑goods products from SQL (optionally filtered by product IDs).

### `EnhanceProductsWithAIActivity`

- **Trigger**: Durable activity
- **Purpose**: Uses `AIService` + Azure OpenAI to generate richer titles/descriptions for a batch of products.

### `UpdateProductsActivity`

- **Trigger**: Durable activity
- **Purpose**: Writes AI‑enhanced product content back to SQL via `ProductService`.

### `GenerateProductEmbeddings_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductEmbeddings_HttpStart`
- **Purpose**: Starts a Durable orchestration to generate vector embeddings for product descriptions.

### `GenerateProductEmbeddings_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: End‑to‑end pipeline to:
  - Load descriptions needing embeddings (`FetchProductDescriptionsActivity`).
  - Generate embeddings via AI (`GenerateEmbeddingsActivity`).
  - Persist them to SQL (`SaveEmbeddingsActivity`) in small batches.

### `FetchProductDescriptionsActivity`

- **Trigger**: Durable activity
- **Purpose**: Reads product descriptions that currently lack embeddings.

### `GenerateEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Calls `AIService.GenerateEmbeddingsAsync` to produce vector embeddings for a batch of descriptions.

### `SaveEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Writes embedding vectors back to SQL via `ProductService.SaveEmbeddingAsync`.

### `GenerateProductReviewEmbeddings_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductReviewEmbeddings_HttpStart`
- **Purpose**: Starts a Durable orchestration to create embeddings for product reviews (used by semantic search).

### `GenerateProductReviewEmbeddings_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: Mirrors the product description pipeline but for reviews:
  - Load reviews needing embeddings (`FetchProductReviewsActivity`).
  - Generate embedding vectors (`GenerateReviewEmbeddingsActivity`).
  - Persist them (`SaveReviewEmbeddingsActivity`).

### `FetchProductReviewsActivity`

- **Trigger**: Durable activity
- **Purpose**: Reads product reviews that still need embeddings from SQL via `ReviewService`.

### `GenerateReviewEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Calls `AIService.GenerateReviewEmbeddingsAsync` to compute vectors for a batch of reviews.

### `SaveReviewEmbeddingsActivity`

- **Trigger**: Durable activity
- **Purpose**: Saves review embeddings back into SQL using `ReviewService`.

### `GenerateProductReviewsUsingAI_HttpStart`

- **Trigger / Route**: HTTP `POST /api/GenerateProductReviewsUsingAI_HttpStart`
- **Purpose**: Clears the `product-review-generation` queue (and poison), discovers products needing synthetic reviews, and enqueues batches of products for AI review generation.

### `GenerateProductReviewsUsingAI_QueueTrigger`

- **Trigger**: Queue `product-review-generation`
- **Purpose**: For each batch, uses `AIService.GenerateProductReviewsAsync` to create realistic demo reviews, saves them via `ReviewService`, and when the queue is empty, automatically triggers the `GenerateProductReviewEmbeddings_HttpStart` endpoint to generate embeddings for the new reviews.

### `SemanticSearch`

- **Trigger / Route**: HTTP `POST /api/search/semantic`
- **Purpose**: Semantic search endpoint over products and reviews. Generates a query embedding via `AIService`, searches both description and review embedding tables, merges and deduplicates results, and returns the best matches ordered by similarity.

---

## Localization & Translation Functions

### `TranslateProductDescriptions_HttpStart`

- **Trigger / Route**: HTTP `POST /api/TranslateProductDescriptions_HttpStart`
- **Purpose**: Starts a Durable orchestration to translate product descriptions into multiple languages. Optionally accepts a list of `ProductModelID`s to limit the scope; otherwise uses recently enhanced products.

### `TranslateProductDescriptions_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: For each target product:
  - Fetch the product metadata (`FetchRecentlyEnhancedProductsActivity`).
  - Load supported non‑English cultures (`GetSupportedCulturesActivity`).
  - Translate into each culture (`TranslateSingleProductActivity` / `TranslateDescriptionsActivity`).
  - Persist translations using `SaveTranslationsActivity`.

### `FetchRecentlyEnhancedProductsActivity`

- **Trigger**: Durable activity
- **Purpose**: Reads either specific products by `ProductModelID` or the set of recently AI‑enhanced products from SQL using `ProductService`.

### `GetSupportedCulturesActivity`

- **Trigger**: Durable activity
- **Purpose**: Returns the list of supported AdventureWorks cultures (languages) for product translations.

### `TranslateSingleProductActivity`

- **Trigger**: Durable activity
- **Purpose**: Uses `AIService.TranslateProductAsync` to translate a single product into multiple cultures, typically as part of a loop over many products.

### `TranslateDescriptionsActivity`

- **Trigger**: Durable activity
- **Purpose**: Batch translation helper that calls `AIService.TranslateDescriptionsAsync` for multiple products and cultures at once.

### `SaveTranslationsActivity`

- **Trigger**: Durable activity
- **Purpose**: Persists translated descriptions to SQL via `ProductService.SaveTranslationsAsync`.

### `TranslateLanguageFile_HttpStart`

- **Trigger / Route**: HTTP `POST /api/TranslateLanguageFile_HttpStart`
- **Purpose**: Starts a Durable orchestration that translates a JSON language resource file (e.g., frontend i18n dictionary) into a target language. Validates supported language codes and accepts inline JSON `languageData`.

### `TranslateLanguageFile_Status`

- **Trigger / Route**: HTTP `GET /api/TranslateLanguageFile_Status?instanceId={id}`
- **Purpose**: Custom status endpoint for the language‑file orchestration. Returns runtime status, timestamps, and raw serialized output for debugging.

### `TranslateLanguageFile_Orchestrator`

- **Trigger**: Durable orchestration
- **Purpose**: Splits the language JSON into sections, invokes `TranslateSectionActivity` for each in parallel, reassembles the translated JSON, and calls `SaveTranslationResultActivity` to persist the result to blob storage, returning a SAS URL.

### `TranslateSectionActivity`

- **Trigger**: Durable activity
- **Purpose**: Traverses a section of the language JSON, calling `AIService` to translate string leaves while preserving structure and nested keys. Returns the translated section as JSON.

### `SaveTranslationResultActivity`

- **Trigger**: Durable activity
- **Purpose**: Writes the final translated JSON file to Azure Blob Storage (using managed identity), generating a short‑lived SAS URL that the caller can download.

---

## SEO & Documentation Functions

### `GetSitemap`

- **Trigger / Route**: HTTP `GET /api/sitemap.xml`
- **Purpose**: Generates an XML sitemap for SEO including static pages, category pages (derived from product categories), and individual product detail pages with last‑modified dates.

### `GetOpenApiSpec`

- **Trigger / Route**: HTTP `GET /api/openapi.json`
- **Purpose**: Programmatically builds and returns an OpenAPI document that describes the key HTTP functions (addresses, semantic search, SEO). Used by Swagger UI and external tooling.

### `GetSwaggerUI`

- **Trigger / Route**: HTTP `GET /api/swagger/ui`
- **Purpose**: Serves a static HTML page that hosts Swagger UI, preconfigured to load the OpenAPI spec from `/api/openapi.json` for interactive API exploration.

### `SeedJobStatus`

- **Trigger / Route**: HTTP `GET /api/seed/status`
- **Purpose**: Returns the status of the database seed job by reading the newest log file from the `seed-job-logs` Azure File Share. Response includes `status` (running / completed / failed / unknown), and when the job is running, a human-readable duration (e.g. `runningForHuman: "9m 42s"`) derived from the `Start Time:` line in the log. Used by the frontend Health page (`/health`) to show a Seed Job status card. Requires the Functions app’s managed identity to have **Storage File Data Privileged Reader** on the storage account (REST API with `ShareTokenIntent.Backup`; SMB Share Reader is SMB-only). See [infra/modules/storage.bicep](../infra/modules/storage.bicep).

---

## Simulator Control & Financial Reporting Functions

### `ResetAllSimulators`

- **Trigger / Route**: HTTP `POST /api/simulators/reset`
- **Purpose**: Coordinated reset of all three simulators in the correct order — clears the manufacturing work-order queue, resets the supply chain (reverts POs and re-seeds vendor stock), then resets the bank (wipes transaction history and re-seeds the USD balance). Returns a step-by-step result with the new USD seed amount. Use this instead of individual resets to avoid orphaned bank transactions.

### `GetFinancialSummary`

- **Trigger / Route**: HTTP `GET /api/financials/summary`
- **Purpose**: Returns an aggregated financial summary across all simulators, bucketing bank transactions by reference prefix into procurement spend, manufacturing overhead, payroll, and scrap write-offs. Includes computed totals (`totalOperatingCost`, `totalAllSpend`).

### `GetProcurementTransactions`

- **Trigger / Route**: HTTP `GET /api/financials/procurement[?maxCount=50]`
- **Purpose**: Returns recent procurement transactions — PO approval debits (`PO-*`) and rejection refunds (`PO-*-refund`) — ordered by time descending. `maxCount` 1–500, default 50.

### `GetManufacturingTransactions`

- **Trigger / Route**: HTTP `GET /api/financials/manufacturing[?type=all&maxCount=50]`
- **Purpose**: Returns recent manufacturing financial transactions filtered by type. `type` can be `all` (default), `completions` (WO completion overhead), `payroll` (per-operation labour), or `scrap` (scrap write-offs). `maxCount` 1–500, default 50.

---

## Admin AI Generation Functions

These endpoints power the AI-driven generation features in the admin portal (`app-admin`).

### `GenerateOrderWithAI`

- **Trigger / Route**: HTTP `POST /api/GenerateOrderWithAI`
- **Purpose**: AI-driven order simulation pipeline. Accepts a `personaType` (e.g. `"sporty-adventurer"`, `"existing-customer"`, `"random"`) and an optional `seedCustomerId`. Uses the Foundry Order Generation agent with `tool_choice: "required"` to research products via MCP, then creates a customer (if new), places an order, and generates a receipt PDF. Returns `salesOrderId`, customer details, `totalDue`, `receiptPdfBase64`, and a log of agent steps. Supports multi-turn refinement via `previousResponseId`.

### `GenerateCustomerWithAI`

- **Trigger / Route**: HTTP `POST /api/customers/generate-with-ai`
- **Purpose**: Generates a realistic fictitious customer profile for a given locale/persona using the Foundry Customer agent. Returns the created customer's ID, name, and email, ready for use in order simulation.

### `GeneratePromotion`

- **Trigger / Route**: HTTP `POST /api/GeneratePromotion`
- **Purpose**: Generates a promotion campaign suggestion using the Foundry Promotion agent. Accepts `promotionType`, `offerCategory`, `categoryId`, `categoryName`, `subcategoryId`, and `subcategoryName`. Returns a promotion strategy with discount percentage, conditions, headline, and body copy, plus a `threadId` for multi-turn refinement turns.

### `GenerateOrdersBulk`

- **Trigger / Route**: HTTP `POST /api/GenerateOrdersBulk`
- **Purpose**: Bulk order generation utility that enqueues multiple AI order-generation jobs concurrently. Used by the admin portal's Generate Orders page to simulate realistic purchase patterns across various personas.

### `CartRecoveryAnalysis`

- **Trigger / Route**: HTTP `POST /api/carts/analyze-recovery`
- **Purpose**: Analyses a batch of abandoned shopping carts using the Foundry Cart Recovery agent. Body: `{ "carts": [{ "cartId", "customerName", "totalValue", "daysStale", "totalItems", "productNames"? }] }`. Returns per-cart recovery strategies including `recoveryScore`, `urgency`, `emailSubject`, `emailBody`, and `recommendedDiscount`.

### `GenerateReviewsWithReplies`

- **Trigger / Route**: HTTP `POST /api/products/{productId}/generate-reviews-with-replies`
- **Purpose**: Generates synthetic product reviews with AI-written merchant reply responses for a specific product. Used by the admin portal's Reviews page to populate demo review content.

### `ReviewAnalysisBatch`

- **Trigger / Route**: HTTP `POST /api/reviews/analyze-batch`
- **Purpose**: Batch sentiment and theme analysis for a set of product reviews. Returns per-review analysis including sentiment score, key themes, and suggested action. Used by the admin portal Reviews page.

---

## Customer & Reporting Functions

### `GetTopSpenders`

- **Trigger / Route**: HTTP `GET /api/customers/top-spenders?limit=100`
- **Purpose**: Returns the top N customers by total spend, joining `Sales.Customer`, `Person.Person`, and `Sales.SalesOrderHeader`. Used by the admin portal Customer Stats page.

### `GetCustomerStats`

- **Trigger / Route**: HTTP `GET /api/customers/stats`
- **Purpose**: Returns aggregate customer statistics (total customers, new this month, average order value, etc.) for the admin portal dashboard.

### `SearchSuggestions`

- **Trigger / Route**: HTTP `GET /api/search/suggestions?q={term}`
- **Purpose**: Returns lightweight type-ahead search suggestions based on product names and categories. Used by the eshop search bar for fast autocomplete.

### `GetReceiptStatus`

- **Trigger / Route**: HTTP `GET /api/orders/{salesOrderId}/receipt-status`
- **Purpose**: Returns whether a PDF receipt has been generated for the given order, and if so the blob URL. Used by the order confirmation page to show a download link once the async receipt job completes.

### `GetReceipt`

- **Trigger / Route**: HTTP `GET /api/orders/{salesOrderId}/receipt`
- **Purpose**: Redirects or returns the PDF receipt blob for a given order. Returns `404` if the receipt has not yet been generated.

### `AdvanceOrderStatus`

- **Trigger / Route**: HTTP `POST /api/orders/{orderId}/advance-status`
- **Purpose**: Manually advances a sales order to the next status step in the pipeline by enqueuing a `sales-order-status` message. Useful for admin testing and demos without waiting for the automatic queue delay.

### `UpdateExchangeRates`

- **Trigger / Route**: HTTP `POST /api/exchange-rates/refresh`
- **Purpose**: Refreshes currency exchange rates in the database. Used by the admin portal Currencies page and the bank simulator to keep FX data current.

---

## Store / B2B Order Management Functions

These functions support the admin portal Stores page, which allows placing orders on behalf of B2B stores (phone/email orders).

### `GetStores`

- **Trigger / Route**: HTTP `GET /api/stores`
- **Purpose**: Returns all B2B stores with aggregated customer stats (order count, total revenue, last order date). Uses a CTE to aggregate across all `Sales.Customer` rows per store.

### `GetStore`

- **Trigger / Route**: HTTP `GET /api/stores/{storeId}`
- **Purpose**: Returns a single store with full details including contact info and order history summary.

### `GetStoreOrders`

- **Trigger / Route**: HTTP `GET /api/stores/{storeId}/orders`
- **Purpose**: Returns the order history for a specific store, joining through all `Customer` records associated with the store.

### `PlaceStoreOrder`

- **Trigger / Route**: HTTP `POST /api/store-orders`
- **Purpose**: Places a new B2B order on behalf of a store. Validates stock, creates `SalesOrderHeader` and `SalesOrderDetail` records, and triggers the order status pipeline.

### `GetStoreProducts`

- **Trigger / Route**: HTTP `GET /api/store-products`
- **Purpose**: Returns products available for store ordering with inventory information and pricing.

### `GetOrderLines`

- **Trigger / Route**: HTTP `GET /api/orders/{orderId}/lines`
- **Purpose**: Returns the line items for a specific order. Used by the Reorder feature in the admin portal.

### `GetProductCatalog`

- **Trigger / Route**: HTTP `GET /api/product-catalog`
- **Purpose**: Returns product categories with their subcategories and product counts. Powers the category picker in store order creation.

### `GetStoreTerritories`

- **Trigger / Route**: HTTP `GET /api/store-territories`
- **Purpose**: Returns territory summaries for B2B stores, sorted by revenue. Used for geographic analytics in the admin portal.

---

## Manufacturing Control & Planning Functions

These functions expose the manufacturing simulation. See [MANUFACTURING_SIMULATION.md](./MANUFACTURING_SIMULATION.md) for full simulation details.

### `ManufacturingBegin`

- **Trigger / Route**: HTTP `POST /api/manufacturing/begin`
- **Purpose**: Explodes the Bill of Materials, creates Work Orders and routing operations, and seeds the `work-order-queue` to start the production simulation.

### `ManufacturingStop`

- **Trigger / Route**: HTTP `POST /api/manufacturing/stop`
- **Purpose**: Clears the production queue, halting the manufacturing simulation (scale-to-zero follows).

### `ManufacturingStatus`

- **Trigger / Route**: HTTP `GET /api/manufacturing/status`
- **Purpose**: Returns live manufacturing counts — work orders in each status, shortages, scrap events, and per-location load.

### `ManufacturingActive`

- **Trigger / Route**: HTTP `GET /api/manufacturing/active`
- **Purpose**: Returns in-progress routing operations with elapsed time, used to animate the simulation dashboard.

### `GetScrapConfig` / `UpdateScrapConfig`

- **Trigger / Routes**: `GET /api/manufacturing/scrap-config`, `PUT /api/manufacturing/scrap-config/{locationId}`
- **Purpose**: Get or update per-location failure rates and applicable scrap reasons.

### `GetLocationConfig` / `UpdateLocationConfig`

- **Trigger / Routes**: `GET /api/manufacturing/location-config`, `PUT /api/manufacturing/location-config/{locationId}`
- **Purpose**: Get or update per-location capacity, shift, and throughput speed settings.

### `GetWorkforce` / `GetWorkforceDetail`

- **Trigger / Routes**: `GET /api/manufacturing/workforce`, `GET /api/manufacturing/workforce/detail`
- **Purpose**: Headcount summary by location and shift, or full worker list with status and pay rate.

### `GetScrapEvents`

- **Trigger / Route**: HTTP `GET /api/manufacturing/scrap-events[?vendorId=]`
- **Purpose**: Returns all scrap events with optional vendor filter. Used for quality analysis.

### `GetVendorQuality` / `GetVendorQualityById`

- **Trigger / Routes**: `GET /api/manufacturing/vendor-quality`, `GET /api/manufacturing/vendor-quality/{vendorId}`
- **Purpose**: Aggregated quality report per supplier vendor, or scoped to one vendor.

### `GetPlanFeasibility` / `GetPlanFeasibilityBulk`

- **Trigger / Routes**: `GET /api/plan/feasibility/{productId}?qty={n}`, `GET /api/plan/feasibility?qty={n}`
- **Purpose**: Check if a product (or all products) can be manufactured at a given quantity given current inventory and work orders.

### `GetPlanCost` / `GetPlanCostCurrent`

- **Trigger / Routes**: `GET /api/plan/cost/{productId}`, `GET /api/plan/cost/{productId}/current`
- **Purpose**: Standard vs current-price cost analysis for manufacturing a product.

### `GetPlanCatalog`

- **Trigger / Route**: HTTP `GET /api/plan/catalog`
- **Purpose**: Returns the manufacturable product catalog with BOM complexity and last production date.

### `GetOverstock`

- **Trigger / Route**: HTTP `GET /api/plan/overstock?minWeeks={n}`
- **Purpose**: Returns products with more than `minWeeks` of stock on hand.

### `GetThinMargin`

- **Trigger / Route**: HTTP `GET /api/plan/thin-margin?maxMarginPct={0.20}`
- **Purpose**: Returns products with gross margin below the threshold.

### `GetShortageforecast`

- **Trigger / Route**: HTTP `GET /api/plan/shortage-forecast?days={90}`
- **Purpose**: Forecasts which components will run out within the given number of days.

### `GetReorderRecommendations`

- **Trigger / Route**: HTTP `GET /api/plan/reorder-recommendations?days={60}`
- **Purpose**: Returns reorder recommendations for components expected to run short within the window.

### `WorkOrderOperationProcessor`

- **Trigger**: Queue `work-order-queue`
- **Purpose**: Queue-driven worker that processes manufacturing routing operations step-by-step, advancing work order status, recording scrap events, and making bank debit calls for labour and overhead costs.

---

## Supply Chain Control Functions

These functions expose the supply chain simulation. See [MANUFACTURING_SIMULATION.md](./MANUFACTURING_SIMULATION.md) for context.

### `GetVendors` / `GetVendor`

- **Trigger / Routes**: `GET /api/supply/vendors`, `GET /api/supply/vendors/{vendorId}`
- **Purpose**: Returns all vendors or a single vendor with stock and lead-time information.

### `GetSupplyCatalog` / `GetSupplyCatalogByProduct`

- **Trigger / Routes**: `GET /api/supply/catalog`, `GET /api/supply/catalog/{productId}`
- **Purpose**: Returns all purchasable components from vendors, or components for a specific product.

### `GetSupplyQuote`

- **Trigger / Route**: HTTP `GET /api/supply/quote?productId={id}&vendorId={id}&qty={n}`
- **Purpose**: Returns a price quote for purchasing a component from a specific vendor at a given quantity.

### `PlaceSupplyOrder`

- **Trigger / Route**: HTTP `POST /api/supply/order`
- **Purpose**: Places a purchase order with a vendor. Validates stock, records the PO in the database, and makes a bank debit for the cost.

### `GetSupplyOrders` / `GetSupplyOrderHistory`

- **Trigger / Routes**: `GET /api/supply/orders`, `GET /api/supply/orders/history`
- **Purpose**: Returns open purchase orders or the full PO history.

### `GetSupplyOrder`

- **Trigger / Route**: HTTP `GET /api/supply/order/{orderId}`
- **Purpose**: Returns a single purchase order by ID.

### `CancelSupplyOrder`

- **Trigger / Route**: HTTP `DELETE /api/supply/order/{orderId}`
- **Purpose**: Cancels an open purchase order and issues a refund bank credit.

### `SupplyChainRestock`

- **Trigger / Route**: HTTP `POST /api/supply/restock`
- **Purpose**: Triggers an automatic restock of vendor inventory to baseline levels (used by the simulator reset flow).

### `PurchaseOrderProcessor`

- **Trigger**: Queue `purchase-order-queue`
- **Purpose**: Queue-driven worker that processes purchase order approvals and rejections, updates inventory, and records bank transactions.

---

## Bank Simulator Functions

These functions expose the virtual bank. See [BANK_SIMULATOR.md](./BANK_SIMULATOR.md) for full documentation.

### `BankGetStatus`

- **Trigger / Route**: HTTP `GET /api/bank/status`
- **Purpose**: Returns the bank's overall health status and configuration.

### `BankGetAccounts` / `BankGetAccount`

- **Trigger / Routes**: `GET /api/bank/accounts`, `GET /api/bank/accounts/{currencyCode}`
- **Purpose**: Returns all accounts or a specific currency account with current balance.

### `BankGetTransactions` / `BankGetTransactionsByCurrency`

- **Trigger / Routes**: `GET /api/bank/transactions`, `GET /api/bank/transactions/{currencyCode}`
- **Purpose**: Returns recent transaction history, optionally filtered to a currency.

### `BankDeposit`

- **Trigger / Route**: HTTP `POST /api/bank/deposit`
- **Purpose**: Credits an amount to a currency account. Body: `{ "currencyCode", "amount", "reference", "description" }`.

### `BankWithdraw`

- **Trigger / Route**: HTTP `POST /api/bank/withdraw`
- **Purpose**: Debits an amount from a currency account. Returns `400` if insufficient funds.

### `BankGetCurrencies`

- **Trigger / Route**: HTTP `GET /api/bank/currencies`
- **Purpose**: Returns all supported currencies and their current exchange rates.

---

## Order-Triggered SQL Function

### `OrderPlacedSqlTrigger`

- **Trigger**: Azure Functions SQL Change Tracking on `Sales.SalesOrderHeader` (INSERT)
- **Purpose**: Fires automatically whenever a new order row is inserted. Enqueues receipt generation, starts the order status pipeline, and fire-and-forgets the Manufacturing agent to assess inventory and feasibility. See [docs/features/ai-agent/MANUFACTURING_AGENT.md](../docs/features/ai-agent/MANUFACTURING_AGENT.md) for the full architecture.

---

## Simulation Queue & Background Functions

### `SimulationOrderStart`

- **Trigger / Route**: HTTP `POST /api/simulation/orders/start`
- **Purpose**: Starts a simulation run that generates a burst of demo orders through the pipeline to warm up the system and demonstrate the full order lifecycle.

### `SimulationOrderQueueTrigger`

- **Trigger**: Queue `simulation-order-queue`
- **Purpose**: Processes queued simulation order generation jobs, calling `GenerateOrderWithAI` for each configured persona.

### `AIJobProcessor`

- **Trigger**: Queue `ai-job-queue`
- **Purpose**: Generic background AI job processor that dequeues tasks (e.g. bulk content generation or embedding jobs) and runs them asynchronously without blocking HTTP responses.

### `TransactionHistoryArchive`

- **Trigger / Route**: HTTP `GET /api/archive/trigger`
- **Purpose**: Archives old bank transaction history rows beyond a retention threshold to keep the transactions table lean.

---

## How This Project Fits Into The Overall Architecture

- **Frontend (`app/`)** calls these Functions for operations that need server‑side processing, long‑running workloads, or integration with external services (OpenAI, email, blob storage).
- **Database access** is handled via services such as `ProductService`, `ReviewService`, `AddressService`, and `ReceiptService`, all using managed identity to reach Azure SQL.
- **Durable Functions** orchestrate multi‑step AI workflows (embellishment, translations, embeddings) and expose simple HTTP entrypoints that the frontend and scripts can call.

For examples of how these Functions are exercised, see the test scripts in the repo root (e.g. `test-receipt-generation.sh`, `test-send-email.sh`, `test-ai-and-mcp-complete.sh`) and the utilities in [scripts/utilities/](../scripts/utilities/) (e.g. `seed-sales-order-status-queue.sh` for the sales order status pipeline).

## Related documentation

- Overall architecture and components: [README.md](../README.md)
- Azure deployment and azd hooks: [QUICKSTART.md](../QUICKSTART.md), [scripts/README.md](../scripts/README.md)
- Infrastructure and environment: [infra/README.md](../infra/README.md)
- MCP server and tools: [api-mcp/README.md](../api-mcp/README.md)
- Password hashing and reset flow: [docs/features/authentication/](../docs/features/authentication/)
- Receipts, PDFs, and email: [docs/features/email/](../docs/features/email/)
- AI agent and MCP integration: [docs/features/ai-agent/](../docs/features/ai-agent/)
- Translations and localization flows: [docs/features/internationalization/](../docs/features/internationalization/)
- Review generation and embeddings: [docs/features/reviews/](../docs/features/reviews/) and [docs/data-management/](../docs/data-management/)
- SEO endpoints and frontend usage: [docs/features/seo/](../docs/features/seo/)
- Manufacturing simulation: [MANUFACTURING_SIMULATION.md](./MANUFACTURING_SIMULATION.md)
- Bank simulator: [BANK_SIMULATOR.md](./BANK_SIMULATOR.md)
