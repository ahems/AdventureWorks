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
- **Purpose**: Front‑door chat endpoint for the AI support agent. Accepts a message plus optional conversation history and customer metadata, forwards to the `AIAgentService` (which talks to the external MCP server), and returns the agents reply plus suggested follow‑up questions. Emits rich Application Insights telemetry for observability.

### `AIAgentStatus`

- **Trigger / Route**: HTTP `GET /api/agent/status`
- **Purpose**: Lightweight health/config endpoint for the AI agent. Returns static metadata such as agent status, framework version, and enabled capabilities (MCP tools, durable threads, etc.). Useful for smoke tests and diagnostics.

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
- **Purpose**: Returns the status of the database seed job by reading the newest log file from the `seed-job-logs` Azure File Share. Response includes `status` (running / completed / failed / unknown), and when the job is running, a human-readable duration (e.g. `runningForHuman: "9m 42s"`) derived from the `Start Time:` line in the log. Used by the frontend Health page (`/health`) to show a Seed Job status card. Requires the Functions app’s managed identity to have **Storage File Data Reader** on the storage account (see [infra/modules/storage.bicep](../infra/modules/storage.bicep)).

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
