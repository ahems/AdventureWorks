# AdventureWorks E‑Commerce (Azure Reference Solution)

AdventureWorks is an end‑to‑end e‑commerce sample that demonstrates how to build a modern, AI‑powered, passwordless web application on Azure. It combines a React SPA frontend, GraphQL/REST data access, Azure Functions for business logic, and Azure OpenAI–powered experiences such as semantic search, AI agents, and automatic content generation.

## Demo Video

See the deployed application in action:

![AdventureWorks Demo](docs/adventureworks-demo.gif)

_[Watch full video](docs/adventureworks-demo.webm) (25 seconds)_

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
- `api-mcp/` – Model Context Protocol server providing AI agent tool capabilities.
- `infra/` – Bicep infrastructure as code for Azure resource provisioning.
- `scripts/` – Automation and utility scripts organized by category:
  - `scripts/hooks/` – Azure Developer CLI (azd) lifecycle hooks (preup, postprovision, postdeploy, etc.)
  - `scripts/data-management/` – Data export and orchestration monitoring scripts
  - `scripts/generators/` – Content generation scripts (reviews, telemetry)
  - `scripts/utilities/` – Helper tools (translations, image downloads, duplicate checking)
- `tests/` – Playwright E2E tests and test scripts (see [tests/README.md](tests/README.md))
- `docs/` – Comprehensive documentation organized by feature area (see [docs/README.md](docs/README.md))

For function‑level details (routes, triggers, and responsibilities), see:

- [api-functions/README.md](api-functions/README.md)

If you want to understand the AI agent's tool surface area, see:

- [api-mcp/README.md](api-mcp/README.md)

For all automation scripts and their usage, see:

- [scripts/README.md](scripts/README.md)

For testing and test scripts, see:

- [tests/scripts/README.md](tests/scripts/README.md)

---

## Getting Started

Deploy the complete solution to Azure using:

```bash
azd up
```

This command will:

- Provision all Azure infrastructure (Container Apps, Static Web App, SQL Database, Storage, etc.)
- Run lifecycle hooks (`preup`, `postprovision`, `postdeploy`)
- Discover Azure OpenAI models and configure environment values
- Build and deploy containers via Azure Container Registry
- Configure database schema and load sample data
- Set up managed identity authentication across all services

Once deployed, you can access the application via the Static Web App URL shown in the deployment output.

---

## Documentation Map

The `docs/` folder contains comprehensive documentation organized by feature area. For a complete index, see [docs/README.md](docs/README.md).

**Quick Links:**

- **Architecture & Deployment**
  - [docs/architecture/MIGRATION_SUMMARY.md](docs/architecture/MIGRATION_SUMMARY.md) – GraphQL migration history

- **AI Agent & MCP**
  - [docs/features/ai-agent/](docs/features/ai-agent/) – AI agent implementation and deployment guides
  - [api-mcp/README.md](api-mcp/README.md) – MCP server tool surface area

- **Authentication & Security**
  - [docs/features/authentication/](docs/features/authentication/) – Password implementation and reset flows

- **Email & Receipts**
  - [docs/features/email/](docs/features/email/) – Email and PDF receipt generation

- **Testing**
  - [tests/README.md](tests/README.md) – Playwright E2E tests
  - [tests/scripts/README.md](tests/scripts/README.md) – API and integration test scripts
  - [docs/testing/](docs/testing/) – Testing guides and telemetry validation

- **Other Features**
  - [docs/features/internationalization/](docs/features/internationalization/) – Translation workflows
  - [docs/features/reviews/](docs/features/reviews/) – Review generation and embeddings
  - [docs/features/search/](docs/features/search/) – AI search troubleshooting
  - [docs/features/seo/](docs/features/seo/) – SEO implementation
  - [docs/features/monitoring/](docs/features/monitoring/) – Application Insights integration

### Testing Best Practices

The test suite uses **dynamic product selection** to ensure comprehensive coverage across the entire product catalog. For complete testing documentation, see:

- [tests/scripts/README.md](tests/scripts/README.md) – All test scripts with usage examples
- [docs/testing/](docs/testing/) – Testing guides and analysis

**Quick Commands:**

```bash
# Run E2E tests
npx playwright test

# API and integration tests (see tests/scripts/README.md for all available tests)
cd tests/scripts
./test-telemetry.sh              # Validate telemetry
./test-product-comparison.sh     # Test product comparison
./test-password-reset-flow.sh    # Test password reset flow
./test-ai-and-mcp-complete.sh    # Test AI agent and MCP integration
```

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

See [docs/testing/TEST_DATA_RANDOMIZATION_ANALYSIS.md](docs/testing/TEST_DATA_RANDOMIZATION_ANALYSIS.md) for detailed analysis and implementation details.

---

## Who Is This Repo For?

- Developers looking for a **realistic reference implementation** of an AI‑enhanced e‑commerce app on Azure.
- Teams evaluating **Data API Builder + Azure Functions + Static Web Apps** as a pattern for line‑of‑business apps.
- Practitioners who want to see how to wire **Azure OpenAI**, **MCP**, **durable workflows**, and **managed identity** together in a production‑style architecture.

You can clone this repo, deploy it with `azd up`, and then explore or extend individual components (frontend, Functions, MCP server, or infra) depending on your interests.
