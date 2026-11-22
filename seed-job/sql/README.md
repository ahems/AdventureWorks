---
title: Seed SQL scripts and CSV data catalog (seed-job/sql/)
summary: Reference for the SQL scripts and original and AI-generated CSV files that the seed job loads into the AdventureWorks Azure SQL database, including which scripts are active, legacy or unused.
audience: [developer, operator, ai-agent]
components: [seed-job]
related: [seed-job/README.md, docs/services/seed-job.md, docs/operations/seed-data-generation.md, docs/architecture/data-stores.md]
---

# Seed SQL scripts and CSV data catalog (`seed-job/sql/`)

This folder contains the SQL scripts and CSV data used to build the AdventureWorks database for this demo. It combines the **original AdventureWorks data exports** with **AI-augmented datasets** that power the AI features. The files are packaged into the seed-job image and loaded by `seed-database.ps1`; see the [seed job README](../README.md) and the [seed job service guide](../../docs/services/seed-job.md). How the AI datasets were produced is covered in [seed data generation](../../docs/operations/seed-data-generation.md).

## Conventions

- `*.csv` files without an `-ai` suffix are **original AdventureWorks seed data**, exported from the sample database.
- `*-ai*.csv` files are **additional or modified datasets created for this project** (embellished descriptions, synthetic reviews, translations, embeddings, warehouse staff, manufacturing content and more).
- Most CSVs are tab-delimited UTF-8 with LF line endings; the delimiter per file is defined in `seed-database.ps1`. Large files are stored with Git LFS.

## SQL scripts

| Script | Status | Purpose |
|---|---|---|
| `AdventureWorks.sql` | Active | Core schema for the AdventureWorks sample database |
| `AdventureWorks-AI.sql` | Active | AI additions such as `VECTOR(1536)` embedding columns, search views and support tables |
| `date-shift-procedures.sql` | Active | `dbo.uspFindDateHighWatermark` and `dbo.uspShiftDatesForward`: moves seed-era dates forward so recent activity looks like yesterday, then re-anchors pending purchase orders and in-process work and sales orders to near-future dates |
| `realtime-notification-outbox.sql` | Active | `dbo.RealtimeNotificationOutbox` and the DML triggers that feed real-time push |
| `guest-cart-sessions.sql` | Active | Guest-cart session schema |
| `discount-codes.sql` | Active | Checkout discount codes (`Sales.DiscountCode`) validated by Functions |
| `password-reset-tokens.sql` | Active | Storefront password-reset token hashes (`Person.PasswordResetToken`) |
| `product-review-votes.sql` | Active | One helpful vote per signed-in shopper per review (`Production.ProductReviewVote`), written by Functions |
| `email-address-uniqueness.sql` | Active | `UQ_EmailAddress_EmailAddress`: each sign-in email address belongs to one person (DAB returns 409 for duplicates) |
| `assign-database-roles.sql` | Legacy | Run by `postprovision.sh` only for a legacy database with public network access; grants `db_owner`. Fresh, private deployments get runtime grants from the seed job (`RuntimeDatabaseAccess.psm1`) instead |

## CSV data files

Unless otherwise noted, a CSV without `-ai` in its name is the original AdventureWorks export; its `-ai` variant (if present) is an AI-augmented extension.

### Core Reference & People Data

- `AWBuildVersion.csv` – AdventureWorks build/version information.
- `Address.csv` – Address records.
- `AddressType.csv` – Types of addresses (billing, home, etc.).
- `BusinessEntity.csv` – Base entity records shared across people, vendors, and stores.
- `BusinessEntityAddress.csv` – Links business entities to addresses.
- `BusinessEntityContact.csv` – Links business entities to contacts.
- `ContactType.csv` – Types of contacts (e.g., sales, support).
- `CountryRegion.csv` – List of countries/regions.
- `CountryRegionCurrency.csv` – Maps countries/regions to their currencies.
- `CountryRegionCurrency-ai.csv` – AI-enriched country/currency data used for demos (for example, additional relationships or metadata).
- `Culture.csv` – Cultures (languages) used for localized descriptions.
- `Culture-ai.csv` – Additional cultures for the storefront's supported languages.
- `CreditCard.csv` – Credit card reference data.
- `Currency.csv` – Currency codes and names.
- `Currency-ai.csv` – AI-augmented currency data (e.g., descriptions, localized or enriched text).
- `CurrencyRate.csv` – Historical currency exchange rates.
- `Customer.csv` – Customer records for sales scenarios.
- `Department.csv` – Departments for HR/employee scenarios.
- `Document.csv` – Document metadata.
- `EmailAddress.csv` – Email addresses linked to people.
- `Employee.csv` – Employee records.
- `EmployeeDepartmentHistory.csv` – Employee department assignments over time.
- `EmployeePayHistory.csv` – Employee pay rate history.
- `JobCandidate.csv` – Job candidate résumés (original sample data).
- `Location.csv` – Manufacturing locations.
- `Password.csv` – Password hashes used in the sample database.
- `Person.csv` – Person records (customers, employees, etc.).
- `PersonCreditCard.csv` – Links people to credit cards.
- `PersonPhone.csv` – Phone numbers for people.
- `PhoneNumberType.csv` – Types of phone numbers (home, work, etc.).
- `StateProvince.csv` – State/province reference data.
- `StateProvince-ai.csv` – AI-augmented state/province data (e.g., enriched descriptions, localized names).
- `BusinessEntity-warehouse-ai.csv`, `Person-warehouse-ai.csv`, `Employee-warehouse-ai.csv`, `EmployeeDepartmentHistory-warehouse-ai.csv`, `EmployeePayHistory-warehouse-ai.csv` – Generated warehouse staff (`+|` field and `&|` record delimiters).

### Product Catalog & Inventory

- `Product.csv` – Core product catalog.
- `Product-ai.csv` – Additional and updated product rows (upserted over the base catalog).
- `ProductNames-ai.csv` – Localized product names with `ProductNameEmbedding` vectors (`Production.ProductName`; stored with Git LFS).
- `ProductCategory.csv` – High-level product categories.
- `ProductCostHistory.csv` – Historical cost data for products.
- `ProductCostHistory-ai.csv` – Additional cost history for generated products.
- `ProductDescription.csv` – Base product descriptions.
- `ProductDescription-ai.csv` – AI-generated/enhanced product descriptions used for content and embeddings demos.
- `ProductDescription-ai-embeddings.csv` – Optional embedding updates for base descriptions, applied after import.
- `ProductDescription-ai-translations.csv` – AI-generated translations of product descriptions for multi-language scenarios.
- `ProductDocument.csv` – Links products to documents.
- `ProductInventory.csv` – Current inventory levels per product/location.
- `ProductListPriceHistory.csv` – Historical list price changes.
- `ProductModel.csv` – Product model definitions.
- `ProductModelIllustration.csv` – Links product models to illustrations.
- `ProductModelInstructions-ai.csv`, `Illustration-ai.csv`, `ProductModelIllustration-ai.csv` – Approved generated manufacturing instructions, diagrams and model mappings (imported by `ManufacturingOverlays.psm1`).
- `Document-ai.csv`, `ProductDocument-ai.csv` – Optional generated part sheets and product links (imported together by `ManufacturingOverlays.psm1`).
- `ProductModelProductDescriptionCulture.csv` – Maps product models to descriptions per culture.
- `ProductModelProductDescriptionCulture-ai.csv` – AI-augmented mappings (e.g., additional cultures or AI translations).
- `ProductPhoto.csv` – Product photo metadata (base AdventureWorks; typically **ProductPhotoID** below 1000).
- `ProductProductPhoto.csv` – Links products to photos (base mappings).
- `ProductProductPhoto-ai.csv` – **Generated at seed time** from the image file list (filesystem is source of truth). See below.

**ProductPhoto and image files (source of truth: filesystem):** The seed job (1) **scans** `seed-job/images/` for files matching `product_<ProductID>_photo_<2|3|4>_small.png` (or `_thumb.png`) with a matching large `.png`; (2) **generates** `ProductProductPhoto-ai.csv` from that list (sorted by ProductID, photo number) and assigns **ProductPhotoID** 1000, 1001, 1002, … in that order; (3) loads the base **ProductPhoto.csv** and **ProductProductPhoto.csv**; (4) loads the generated **ProductProductPhoto-ai.csv**; (5) **PNG upload** inserts each image into `[Production].[ProductPhoto]` with the same ProductPhotoID from the generated CSV. So the list of image files is the source of truth; the CSV is derived from it each run. **Note:** Image filenames in the repo only include product IDs **680–999** (e.g. `product_877_photo_2.png`). Products 1–679 have no AI-generated images in the filesystem unless you add them or pull them from another deployment (e.g. via `scripts/utilities/download-large-images.ps1`).

- `ProductReview.csv` – Base product reviews.
- `ProductReview-ai.csv` – AI-generated product reviews used to demonstrate review generation and embeddings.
- `ProductReview-ai-Embeddings.csv` – Review embedding updates applied after the review CSVs load.
- `ProductReview-ai-UserID.csv` – ProductReviewID and UserID (Person.BusinessEntityID, PersonType IN) per row; used by the seed-job to update `Production.ProductReview.UserID` after the other review CSVs are loaded. Generate with `node scripts/utilities/generate-product-review-userids.js` (requires `API_URL` or `VITE_API_URL` pointing at the DAB API).
- `ProductSubcategory.csv` – Product subcategories.
- `ProductVendor.csv` – Links products to vendors.

### Purchasing, Sales & Orders

- `BillOfMaterials.csv` – Bill of materials entries.
- `BillOfMaterials-ai.csv` – Additional bill of materials entries for generated products.
- `PurchaseOrderDetail.csv` – Details of purchase orders.
- `PurchaseOrderHeader.csv` – Purchase order headers.
- `SalesOrderDetail.csv` – Sales order line items.
- `SalesOrderHeader.csv` – Sales order headers.
- `SalesOrderHeaderSalesReason.csv` – Links sales orders to sales reasons.
- `SalesPerson.csv` – Salesperson data.
- `SalesPersonQuotaHistory.csv` – Sales quota history per salesperson.
- `SalesReason.csv` – Reasons for sales decisions.
- `SalesTaxRate.csv` – Sales tax rates.
- `SalesTaxRate-ai.csv` – AI-augmented tax rate data (e.g., additional descriptive/contextual fields).
- `SalesTerritory.csv` – Sales territories.
- `SalesTerritoryHistory.csv` – Territory assignments over time.
- `ScrapReason.csv` – Reasons for scrapping products.
- `ShipMethod.csv` – Shipping methods.
- `ShoppingCartItem.csv` – Items in shopping carts.
- `SpecialOffer.csv` – Special offers and promotions (one row per offer per culture; generated by `scripts/generators/generate-special-offer-translations.sh` with translated descriptions for all cultures).
- `SpecialOfferProduct.csv` – Links special offers to products.
- `Store.csv` – Store data.
- `TransactionHistory.csv` – Transaction history.
- `TransactionHistoryArchive.csv` – Archived transaction history.

### Manufacturing & Operations

- `Illustration.csv` – Illustration metadata.
- `Shift.csv` – Work shifts.
- `UnitMeasure.csv` – Units of measure.
- `Vendor.csv` – Vendor records.
- `WorkOrder.csv` – Work orders.
- `WorkOrderRouting.csv` – Work order routing steps.
