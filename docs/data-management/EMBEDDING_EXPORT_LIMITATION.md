# Embedding Export Limitation

## Issue

The embedding export scripts (`export-product-description-embeddings.js` and `export-product-review-embeddings.js`) **cannot use the DAB GraphQL API** to export embedding data.

## Root Cause

- The database stores embeddings in **VECTOR columns** (e.g. `VECTOR(1536)`)
- The DAB **GraphQL** layer maps/serializes these as strings and fails:
  ```
  "The DescriptionEmbedding value could not be parsed for configured GraphQL data type String"
  ```
- GraphQL queries that request `DescriptionEmbedding` or `CommentsEmbedding` return errors or `null` for those fields even when the database has valid data.

## Use REST for VECTOR columns

The DAB **REST API** (`/api`) returns VECTOR columns correctly as JSON arrays. Prefer REST when you need to read embedding data via DAB.

**Example (ProductDescription with embeddings):**

```http
GET /api/ProductDescription?$first=10&$select=ProductDescriptionID,Description,DescriptionEmbedding
```

Response includes `DescriptionEmbedding` as a numeric array, e.g.:

```json
{
  "value": [
    {
      "ProductDescriptionID": 3,
      "Description": "...",
      "DescriptionEmbedding": [0.032786481, -0.012520245, ...]
    }
  ]
}
```

For validation or tools that query DAB (and need embeddings), use the REST endpoint with `$select` rather than the GraphQL endpoint.

## GraphQL (what not to do)

When querying the API with embeddings included over **GraphQL**:

```graphql
query {
  productDescriptions {
    items {
      ProductDescriptionID
      Description
      DescriptionEmbedding # ❌ Causes errors or null
    }
  }
}
```

The API returns errors or null for embedding fields even though the data exists in the database.

## Solution Options

### Option 1: Keep SQL Server Direct Access (Recommended for export scripts)

The original scripts used SQL Server direct connections, which can properly read VECTOR columns. This is the **correct approach** for embedding exports (e.g. generating CSVs for the seed job).

**Pros:**

- VECTOR columns can be read directly from SQL
- Proven to work with existing deployment scripts
- No API limitations

**Cons:**

- Requires SQL credentials or Azure AD authentication
- Direct database access from dev environment

### Option 2: Use DAB REST API for read-only embedding access

When you need to read embeddings via DAB (e.g. validation, one-off checks), use the REST API:

- `GET /api/ProductDescription?$select=ProductDescriptionID,Description,DescriptionEmbedding&$first=...`
- Paginate with `$after` / `nextLink` if needed

**Pros:**

- No GraphQL serialization issues; VECTOR returned as JSON array
- No direct SQL required

**Cons:**

- Pagination and filtering are REST-style (`$filter`, `$first`, `$after`)

### Option 3: Create Custom Azure Function

Create a dedicated Azure Function endpoint that queries SQL directly and returns embeddings. Use when you need server-side logic, not for simple reads (REST is enough).

### Option 4: Modify DAB Configuration

Remove `DescriptionEmbedding` and `CommentsEmbedding` from DAB exposed fields if you never need them via the API. Not recommended if you want to validate or read embeddings via DAB REST.

## Recommendation

- **Export scripts (CSV generation):** Use **SQL Server direct connection** for embedding exports.
- **Reading/validating embeddings via DAB:** Use the **REST API** (`/api/ProductDescription?$select=...,DescriptionEmbedding`) instead of GraphQL; REST returns VECTOR columns reliably as JSON arrays.
