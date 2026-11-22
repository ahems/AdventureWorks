---
title: Seed data generation
summary: Where the AI-augmented seed CSVs come from, which generator and export scripts produced them, how vector columns are encoded, and why regeneration is an offline, maintainer-only activity.
audience: [developer]
components: [seed-job, scripts, api-functions, api]
related:
  - docs/services/seed-job.md
  - docs/reference/scripts.md
  - docs/features/search/semantic-search.md
  - docs/features/i18n/localization.md
  - docs/features/manufacturing/manufacturing-content.md
  - docs/features/reviews/product-reviews.md
---

# Seed data generation

The seed job loads the AdventureWorks sample data and a set of checked-in **AI-augmented** CSV files from [`seed-job/sql/`](../../seed-job/sql/). These files contain translations, embeddings, generated reviews and manufacturing content. Deployments load the files as they are and never regenerate them. The scripts on this page show how the files were produced, and maintainers use them to refresh data offline.

## AI-augmented seed files

Files named `*-ai*.csv` are generated or augmented. The original AdventureWorks CSVs sit alongside them.

| Area | Files |
| --- | --- |
| Translations and cultures | `ProductDescription-ai-translations.csv`, `ProductModelProductDescriptionCulture-ai.csv`, `ProductNames-ai.csv`, `Culture-ai.csv`, `Currency-ai.csv`, `CountryRegionCurrency-ai.csv`, `StateProvince-ai.csv`, `SalesTaxRate-ai.csv` |
| Embeddings | `ProductDescription-ai-embeddings.csv`, `ProductReview-ai-Embeddings.csv` |
| Products and reviews | `Product-ai.csv`, `ProductDescription-ai.csv`, `ProductProductPhoto-ai.csv`, `ProductCostHistory-ai.csv`, `ProductReview-ai.csv`, `ProductReview-ai-UserID.csv` |
| Manufacturing content | `Illustration-ai.csv`, `ProductModelIllustration-ai.csv`, `ProductModelInstructions-ai.csv`, `Document-ai.csv`, `ProductDocument-ai.csv`, `BillOfMaterials-ai.csv` |
| Warehouse staff | `BusinessEntity-warehouse-ai.csv`, `Person-warehouse-ai.csv`, `Employee-warehouse-ai.csv`, `EmployeeDepartmentHistory-warehouse-ai.csv`, `EmployeePayHistory-warehouse-ai.csv` |

The load order, delimiters and per-file options are defined in the seed job. See [Seed job](../services/seed-job.md).

## Vector columns

Embedding columns are `VECTOR(1536)`. In the CSVs, each embedding is stored as a JSON array of floats, for example `"[0.0123,-0.0456,...]"`. The seed job casts the array into the vector column during import. A file with the wrong dimension or a non-JSON value fails to load for that table.

DAB GraphQL cannot serialize `VECTOR` columns. DAB REST returns them as arrays when the column is requested explicitly with `$select`. [`scripts/utilities/export-product-description-embeddings-from-source-api.sh`](../../scripts/utilities/export-product-description-embeddings-from-source-api.sh) uses that behavior to export description embeddings from a source DAB deployment.

## Generators

The generators live in [`scripts/generators/`](../../scripts/generators/).

| Script | Output | Notes |
| --- | --- | --- |
| `generate-category-translations.sh`, `generate-subcategory-translations.sh`, `generate-product-name-translations.sh`, `generate-special-offer-translations.sh` | Translation CSVs; some update non-`-ai` files such as `ProductCategory.csv` and `SpecialOffer.csv` | Call Azure OpenAI with an Entra token from `az account get-access-token --resource https://cognitiveservices.azure.com` |
| `generate-original-review-embeddings.sh` | Review embeddings | Uses Azure OpenAI in the same way |
| `generate-reviews-with-embeddings.sh` | Reviews generated through Functions | Posts to the Functions review endpoints. Protected routes need a Functions-audience token from [`azure-auth.py`](../testing/AZURE_AUTHENTICATED_SCRIPTS.md). |
| `generate-component-costs.js` | `Product-ai.csv` (updated costs and prices) and generated cost-history rows | Runs offline from the existing CSVs |

These scripts call Azure OpenAI or deployed APIs, which can incur cost. Run them only on purpose.

## Exporters

The exporters in [`scripts/data-management/`](../../scripts/data-management/) read a populated database and write CSVs to a `sql/` folder next to the script. You then copy reviewed files into `seed-job/sql/`.

| Script | Exports | Client |
| --- | --- | --- |
| `export-ai-translations.sh` | Translation tables | `sqlcmd` |
| `export-ai-product-descriptions.sh` | AI product descriptions | `sqlcmd` |
| `export-product-description-embeddings.js` | `ProductDescription` embeddings | `mssql` npm package |
| `export-product-review-embeddings.js` | Review embeddings | `mssql` npm package |
| `export-product-reviews.js` | Reviews (without vectors) | DAB GraphQL at `API_URL`, unauthenticated |
| `export-all-embeddings.sh` | Runs both embedding exporters | — |

The SQL-based exporters connect to SQL directly with credentials supplied through environment variables. Deployed SQL servers are private and use Entra-only authentication, so the exporters cannot reach a deployed demo database. They are kept for offline or historic maintenance against a database you control. `export-product-reviews.js` sends no token and relies on the `ProductReview` entity's anonymous read permission in `api/dab-config.json`. Never commit or print SQL credentials.

The related utility `scripts/utilities/generate-product-review-userids.js` builds `ProductReview-ai-UserID.csv`, which links reviews to seeded users. The manufacturing content pipeline (illustrations, instructions, documents and diagrams) has its own scripts and is documented in [Manufacturing content](../features/manufacturing/manufacturing-content.md).

## Refreshing seed data

1. Regenerate or export the files offline and review the diff, paying particular attention to row counts, delimiters and encoding.
2. Commit the CSVs. Large files are stored in Git LFS.
3. Ask the user to [recreate the environment](deployment.md#recreating-the-environment). The seed job runs only during provisioning and uses `SEED_SKIP_EXISTING=true`, so `azd deploy` does not reload data.

## Related

- [Seed job](../services/seed-job.md)
- [Scripts reference](../reference/scripts.md)
- [Semantic search](../features/search/semantic-search.md)
- [Localization](../features/i18n/localization.md)
- [Product reviews](../features/reviews/product-reviews.md)
