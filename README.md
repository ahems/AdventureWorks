# AdventureWorks E‑Commerce (Azure Reference Solution)

AdventureWorks is an end‑to‑end e‑commerce sample that demonstrates how to build a modern, AI‑powered, passwordless web application on Azure. It combines a React SPA frontend, GraphQL/REST data access, Azure Functions for business logic, and Azure OpenAI–powered experiences such as semantic search, AI agents, and automatic content generation.

---

## High‑Level Architecture

This repo implements a **3‑tier Azure application** with passwordless authentication and managed identities:

```text
User → Static Web App → GraphQL (DAB) → Azure SQL
                     ↘ Azure Functions → Azure SQL / Storage / Email / OpenAI
```

- **Frontend** (`app/`)
  - React + TypeScript + Vite single‑page application.
  - Deployed as an **Azure Static Web App**.
  - Talks to backend via GraphQL (Data API Builder) and HTTP APIs (Azure Functions).

- **Backend API** (`api/`)
  - **Microsoft Data API Builder (DAB)** exposes the AdventureWorks SQL schema as GraphQL + REST.
  - Runs in **Azure Container Apps**.
  - Enforces DAB naming conventions and pagination limits (100 items per query).

- **Serverless Functions** (`api-functions/`)
  - .NET 8 **Azure Functions (isolated worker)** in Container Apps.
  - Implements custom business logic not suited for DAB, including:
    - AI agent endpoints (via Model Context Protocol).
    - Password & password‑reset workflows.
    - Semantic search over embeddings.
    - Receipt PDF generation and email delivery.
    - Product image generation and thumbnailing.
    - Translation of product descriptions and language files.

- **Database**
  - **Azure SQL** with the AdventureWorks sample schema (`Production.*`, `Sales.*`, `Person.*`).
  - Accessed with **managed identity** / Entra ID authentication (no passwords or connection strings in code).

- **Infrastructure as Code** (`infra/`)
  - **Bicep** modules describe Azure resources (Container Apps, Static Web App, SQL, storage, monitoring, etc.).
  - Orchestrated by **Azure Developer CLI (azd)** using `azure.yaml` and lifecycle hooks.

All services authenticate using **Managed Identity** and the `Authentication=Active Directory Default` pattern; secrets are not baked into code.

---

## Key Capabilities

- **AI Agent & MCP Integration**
  - Chat endpoint that uses the Microsoft Agent Framework + Model Context Protocol (MCP) to orchestrate tools like order lookup, product search, and recommendations, backed by the `api-mcp` service.
  - Telemetry via Application Insights for tracing conversations and tool usage.

- **AI‑Generated Content**
  - Enhances product descriptions using Azure OpenAI.
  - Generates synthetic product reviews and corresponding embeddings for richer demo data.
  - Automatically translates content into multiple languages.

- **Semantic Search**
  - Uses vector embeddings for product descriptions and reviews.
  - Exposes a semantic search HTTP API that ranks products by similarity to a natural‑language query.

- **Receipts & Email**
  - Generates PDF order receipts with QuestPDF and stores them in Azure Blob Storage.
  - Sends order confirmation emails (with receipt links) via Azure Communication Services Email.

- **SEO & Sitemaps**
  - Generates an XML sitemap covering static pages, category pages, and product detail pages.
  - Frontend includes SEO‑friendly components and metadata (see docs).

- **Password & Reset Flows**
  - Demonstrates PBKDF2 password hashing and verification against the AdventureWorks schema.
  - Implements a full password‑reset workflow with short‑lived tokens and email links.

---

## Repository Layout

- `app/` – React + TypeScript + Vite frontend (Azure Static Web App).
- `api/` – Data API Builder (DAB) configuration, Dockerfile, and local start scripts.
- `api-functions/` – .NET 8 isolated Azure Functions with AI, email, receipts, passwords, SEO, and translation workflows.
  `scripts/` – Helper scripts for exporting embeddings, monitoring orchestrations, data seeding, and SQL/data utilities (see [scripts/sql/README.md](scripts/sql/README.md)).

For function‑level details (routes, triggers, and responsibilities), see:

- [api-functions/README.md](api-functions/README.md)

If you want to understand the AI agent's tool surface area, see:

- [api-mcp/README.md](api-mcp/README.md)

---

## Local Development (Overview)

A detailed step‑by‑step guide is provided in the repository documentation, but the rough flow is:

1. **Bootstrap Azure environment** (if needed)
   - Use `azd up` to provision infrastructure and deploy containers:
     - Runs azd lifecycle hooks (`preup`, `postprovision`, `postdeploy`).
     - Discovers Azure OpenAI models and configures environment values.

2. **Run Data API Builder locally**
   - Use the helper script and VS Code task to start DAB:
     - `cd api && ./start-local-api.sh`

3. **Run the frontend locally**
   - `cd app && npm install`
   - `npm run dev`
   - Ensure `VITE_API_URL` points to your local DAB GraphQL endpoint (for example, `http://localhost:5000/graphql`).

4. **Run Azure Functions locally (optional)**
   - Use the `func: host start` VS Code task (depends on the build task).
   - Configure `MCP_SERVICE_URL` in `api-functions/local.settings.json` to point at the Azure‑hosted MCP service if you want the AI agent to function locally.

The project is wired for **remote container builds** for APIs and Functions via Azure Container Registry, as defined in `azure.yaml`.

---

## Documentation Map

The `docs/` folder contains focused deep dives on important parts of the solution:

- **AI agent & MCP**
  - [docs/AGENT_FRAMEWORK_MIGRATION.md](docs/AGENT_FRAMEWORK_MIGRATION.md)
  - [docs/AI_AGENT_AUTOMATION.md](docs/AI_AGENT_AUTOMATION.md)
  - [docs/AI_AGENT_DEPLOYMENT_SUMMARY.md](docs/AI_AGENT_DEPLOYMENT_SUMMARY.md)
  - [docs/AI_AGENT_TELEMETRY_IMPLEMENTATION.md](docs/AI_AGENT_TELEMETRY_IMPLEMENTATION.md)
  - [docs/AI_AND_MCP_TESTING_GUIDE.md](docs/AI_AND_MCP_TESTING_GUIDE.md)
  - [docs/AI_CHAT_MCP_TESTING.md](docs/AI_CHAT_MCP_TESTING.md)

- **Data API Builder & GraphQL**
  - [docs/DAB_NAMING_CONVENTIONS.md](docs/DAB_NAMING_CONVENTIONS.md)

- **Passwords & Security**
  - [docs/PASSWORD_IMPLEMENTATION.md](docs/PASSWORD_IMPLEMENTATION.md)
  - [docs/PASSWORD_RESET_FLOW.md](docs/PASSWORD_RESET_FLOW.md)
  - Quick test: `./test-password-reset-flow.sh`

- **Receipts & Email**
  - [docs/RECEIPT_GENERATION.md](docs/RECEIPT_GENERATION.md)
  - [docs/RECEIPT_GENERATION_FLOW.md](docs/RECEIPT_GENERATION_FLOW.md)
  - [docs/SEND_EMAIL_FUNCTION.md](docs/SEND_EMAIL_FUNCTION.md)

- **SEO**
  - [docs/SEO_IMPLEMENTATION.md](docs/SEO_IMPLEMENTATION.md)
  - [docs/SEO_COMPONENTS_IMPLEMENTATION.md](docs/SEO_COMPONENTS_IMPLEMENTATION.md)

- **Translations & Localization**
  - [docs/LANGUAGE_FILE_TRANSLATION.md](docs/LANGUAGE_FILE_TRANSLATION.md)
  - [docs/LANGUAGE_TRANSLATION_DURABLE_FUNCTIONS.md](docs/LANGUAGE_TRANSLATION_DURABLE_FUNCTIONS.md)
  - [docs/TRANSLATION_BLOB_STORAGE.md](docs/TRANSLATION_BLOB_STORAGE.md)
  - [docs/EMOJI_IN_TRANSLATIONS.md](docs/EMOJI_IN_TRANSLATIONS.md)

- **Review generation & embeddings**
  - [docs/REVIEW_GENERATION.md](docs/REVIEW_GENERATION.md)
  - [docs/REVIEW_GENERATION_WORKFLOW.md](docs/REVIEW_GENERATION_WORKFLOW.md)
  - [docs/REVIEW_GENERATION_SCRIPTS.md](docs/REVIEW_GENERATION_SCRIPTS.md)
  - [scripts/EMBEDDING_EXPORT.md](scripts/EMBEDDING_EXPORT.md)
  - [scripts/EMBEDDING_EXPORT_LIMITATION.md](scripts/EMBEDDING_EXPORT_LIMITATION.md)

- **Observability & App Insights**
  - [docs/APP_INSIGHTS_INTEGRATION.md](docs/APP_INSIGHTS_INTEGRATION.md)
  - [docs/APP_INSIGHTS_CONNECTION_STRING_FLOW.md](docs/APP_INSIGHTS_CONNECTION_STRING_FLOW.md)

- **Testing & Telemetry Generation**
  - [tests/README.md](tests/README.md) - Playwright E2E tests
  - [tests/TELEMETRY_TESTING.md](tests/TELEMETRY_TESTING.md) - Validating Application Insights telemetry
  - [docs/TELEMETRY_GENERATION.md](docs/TELEMETRY_GENERATION.md) - Generating demo telemetry data
  - [docs/TEST_DATA_RANDOMIZATION_ANALYSIS.md](docs/TEST_DATA_RANDOMIZATION_ANALYSIS.md) - Test data randomization patterns
  - [docs/TEST_DATA_RANDOMIZATION_SUMMARY.md](docs/TEST_DATA_RANDOMIZATION_SUMMARY.md) - Implementation summary
  - Quick commands:
    ```bash
    ./test-telemetry.sh        # Validate telemetry is working
    ./generate-telemetry.sh    # Generate demo browsing data
    ./test-product-comparison.sh  # Test product comparison with anonymous users
    npx playwright test        # Run all E2E tests
    ```

### Testing Best Practices

The test suite uses **dynamic product selection** to ensure comprehensive coverage across the entire product catalog:

**Product Helper Utility** (`tests/utils/productHelper.ts`):

- Fetches all products from the database (handles DAB's 100-item pagination)
- Provides random product selection functions with optional filtering
- Caches results for 5 minutes to optimize performance

**Usage in tests:**

```typescript
import {
  getRandomProductIds,
  getInStockProductIds,
} from "../utils/productHelper";

// Get any random products
const productIds = await getRandomProductIds(5);

// Get products likely to be in stock
const inStockIds = await getInStockProductIds(10);

// Navigate to a random product
await page.goto(`${testEnv.webBaseUrl}/product/${productIds[0]}`);
```

**Benefits:**

- Tests exercise 100% of product catalog over multiple runs (vs. 1-2% with hardcoded IDs)
- Automatically adapts to product database changes
- Catches edge cases with different product characteristics
- More realistic simulation of user behavior

See [docs/TEST_DATA_RANDOMIZATION_ANALYSIS.md](docs/TEST_DATA_RANDOMIZATION_ANALYSIS.md) for detailed analysis and implementation details.

If you are exploring the AI and agent pieces specifically, start with the AI Agent docs above and then dive into [api-functions/README.md](api-functions/README.md) for the concrete Functions and endpoints.

---

## Who Is This Repo For?

- Developers looking for a **realistic reference implementation** of an AI‑enhanced e‑commerce app on Azure.
- Teams evaluating **Data API Builder + Azure Functions + Static Web Apps** as a pattern for line‑of‑business apps.
- Practitioners who want to see how to wire **Azure OpenAI**, **MCP**, **durable workflows**, and **managed identity** together in a production‑style architecture.

You can clone this repo, deploy it with `azd up`, and then explore or extend individual components (frontend, Functions, MCP server, or infra) depending on your interests.
