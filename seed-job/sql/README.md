# AdventureWorks SQL & Data Seed Files

This folder contains the SQL scripts and CSV data used to provision the AdventureWorks database for this sample. It combines the **original AdventureWorks data exports** with **AI-augmented datasets** used to showcase the AI features in this project.

These files are containerized and deployed as part of the **seed-job** Azure Container App Job, which runs during `azd up` and takes approximately **8 minutes** to populate the database with schema, data, and product images.

**For complete seed-job documentation (architecture, deployment, monitoring), see [../README.md](../README.md).**

## Conventions

- `*.csv` files without an `-ai` suffix are **original AdventureWorks seed data**, exported from the sample database.
- `*-ai*.csv` files are **additional or modified datasets created for this project** to demonstrate AI-driven capabilities (embellished descriptions, synthetic reviews, translations, enriched relationships, etc.).
- `AdventureWorks.sql` is the primary schema + data load script.
- `AdventureWorks-AI.sql` and `assign-database-roles.sql` add AI-specific data and security roles used by this solution.

## SQL Scripts

- `AdventureWorks.sql` – Core schema and data load script for the AdventureWorks sample database. Creates tables and imports the base CSVs.
- `AdventureWorks-AI.sql` – Additional schema and data for AI scenarios (e.g., review/description embeddings, AI-specific support tables, and references to the AI CSV files).
- `assign-database-roles.sql` – Grants the appropriate database roles/permissions (for example, to managed identities used by the app) so that the app can read/write as required.

## CSV Data Files

Below is a quick reference for the CSVs in this folder. Unless otherwise noted, a CSV without `-ai` in its name is the original AdventureWorks export; its corresponding `-ai` variant (if present) is an AI-augmented extension.

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
- `Location.csv` – Manufacturing locations.
- `Password.csv` – Password hashes used in the sample database.
- `Person.csv` – Person records (customers, employees, etc.).
- `PersonCreditCard.csv` – Links people to credit cards.
- `PersonPhone.csv` – Phone numbers for people.
- `PhoneNumberType.csv` – Types of phone numbers (home, work, etc.).
- `StateProvince.csv` – State/province reference data.
- `StateProvince-ai.csv` – AI-augmented state/province data (e.g., enriched descriptions, localized names).

### Product Catalog & Inventory

- `Product.csv` – Core product catalog.
- `ProductCategory.csv` – High-level product categories.
- `ProductCostHistory.csv` – Historical cost data for products.
- `ProductDescription.csv` – Base product descriptions.
- `ProductDescription-ai.csv` – AI-generated/enhanced product descriptions used for content and embeddings demos.
- `ProductDescription-ai-translations.csv` – AI-generated translations of product descriptions for multi-language scenarios.
- `ProductDocument.csv` – Links products to documents.
- `ProductInventory.csv` – Current inventory levels per product/location.
- `ProductListPriceHistory.csv` – Historical list price changes.
- `ProductModel.csv` – Product model definitions.
- `ProductModelIllustration.csv` – Links product models to illustrations.
- `ProductModelProductDescriptionCulture.csv` – Maps product models to descriptions per culture.
- `ProductModelProductDescriptionCulture-ai.csv` – AI-augmented mappings (e.g., additional cultures or AI translations).
- `ProductPhoto.csv` – Product photo metadata.
- `ProductProductPhoto.csv` – Links products to photos.
- `ProductProductPhoto-ai.csv` – AI-related product-photo mappings (e.g., synthetic or AI-generated images used for demos).
- `ProductReview.csv` – Base product reviews.
- `ProductReview-ai.csv` – AI-generated product reviews used to demonstrate review generation and embeddings.
- `ProductSubcategory.csv` – Product subcategories.
- `ProductVendor.csv` – Links products to vendors.

### Purchasing, Sales & Orders

- `BillOfMaterials.csv` – Bill of materials entries.
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
- `SpecialOffer.csv` – Special offers and promotions.
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

---

In summary:

- **Original AdventureWorks CSVs** (`*.csv` without `-ai`) provide the canonical sample dataset.
- **AI-specific CSVs** (`*-ai*.csv`) add synthetic or enriched data used by this project to demonstrate AI features such as:
  - AI-generated product descriptions and reviews.
  - Translated content for multiple locales.
  - Enriched reference data for more realistic demos.

These files are consumed by the SQL scripts and deployment automation to populate the Azure SQL database used by the application.

## Deployment Process

During `azd up`, the `postprovision.sh` hook:
1. Builds the seed-job container image with these files using Azure Container Registry
2. Deploys and starts the seed-job as an Azure Container App Job
3. The job executes `seed-database.ps1` which loads all SQL scripts and CSV files
4. **Total seed-job execution time: ~8 minutes**

You can monitor the seed-job progress with:
```bash
az containerapp job execution list --name <seed-job-name> --resource-group <resource-group>
```
