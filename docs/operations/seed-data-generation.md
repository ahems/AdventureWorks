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

DAB GraphQL cannot serialize `VECTOR` columns. DAB REST returns them as arrays when the column is requested explicitly with `$select`. [`scripts/data-management/export-ai-seed-data.py`](../../scripts/data-management/export-ai-seed-data.py) uses that behavior to export description and review embeddings.

## Generators

The generators live in [`scripts/generators/`](../../scripts/generators/).

| Script | Output | Notes |
| --- | --- | --- |
| `generate-category-translations.sh`, `generate-subcategory-translations.sh`, `generate-product-name-translations.sh`, `generate-special-offer-translations.sh` | Translation CSVs; some update non-`-ai` files such as `ProductCategory.csv` and `SpecialOffer.csv` | Call Azure OpenAI with an Entra token from `az account get-access-token --resource https://cognitiveservices.azure.com` |
| `generate-original-review-embeddings.sh` | Review embeddings | Uses Azure OpenAI in the same way |
| `generate-reviews-with-embeddings.sh` | Reviews generated through Functions | Queues review generation as the seeded admin with a Functions-audience token from [`azure-auth.py`](../testing/AZURE_AUTHENTICATED_SCRIPTS.md); review embeddings are queued automatically when generation finishes. |
| `generate-component-costs.js` | `Product-ai.csv` (updated costs and prices) and generated cost-history rows | Runs offline from the existing CSVs |

These scripts call Azure OpenAI or deployed APIs, which can incur cost. Run them only on purpose.

## Exporters

[`scripts/data-management/export-ai-seed-data.py`](../../scripts/data-management/export-ai-seed-data.py) reads the deployed database through authenticated DAB REST. It signs in as the seeded admin with [`azure-auth.py`](../testing/AZURE_AUTHENTICATED_SCRIPTS.md), sends `X-MS-API-ROLE: executive-admin`, follows every `nextLink` page and writes CSVs in the seed-job formats (to `seed-job/sql/` by default, or `--output-dir`). Review the diff before keeping the files.

| Target | File | Contents |
| --- | --- | --- |
| `translations` | `ProductModelProductDescriptionCulture-ai.csv` | Model/description/culture mappings for non-base cultures |
| `descriptions` | `ProductDescription-ai-translations.csv` | AI-only (translated) description text |
| `description-embeddings` | `ProductDescription-ai-embeddings.csv` | Description embeddings |
| `review-embeddings` | `ProductReview-ai.csv` | Reviews with embeddings |

```bash
python3 scripts/data-management/export-ai-seed-data.py --output-dir seed-export translations review-embeddings
```

Deployed SQL is private, so no exporter connects to SQL directly.

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
