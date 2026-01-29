# Embedding Export Limitation

## Issue

The embedding export scripts (`export-product-description-embeddings.js` and `export-product-review-embeddings.js`) **cannot use the DAB GraphQL API** to export embedding data.

## Root Cause

- The database stores embeddings in **VECTOR columns** (binary data type)
- The DAB GraphQL API is configured with `DescriptionEmbedding` and `CommentsEmbedding` as `String` types
- GraphQL **cannot serialize VECTOR binary data** to strings, resulting in errors:
  ```
  "The DescriptionEmbedding value could not be parsed for configured GraphQL data type String"
  ```

## Current State

When querying the API with embeddings included:

```graphql
query {
  productDescriptions {
    items {
      ProductDescriptionID
      Description
      DescriptionEmbedding # ❌ This field causes errors
    }
  }
}
```

The API returns errors for every record that has embeddings, even though the data exists in the database.

## Solution Options

### Option 1: Keep SQL Server Direct Access (Recommended)

The original scripts used SQL Server direct connections, which can properly read VECTOR columns. This is the **correct approach** for embedding exports.

**Pros:**

- VECTOR columns can be read directly from SQL
- Proven to work with existing deployment scripts
- No API limitations

**Cons:**

- Requires SQL credentials or Azure AD authentication
- Direct database access from dev environment

### Option 2: Create Custom Azure Function

Create a dedicated Azure Function endpoint that:

- Queries SQL directly with proper VECTOR handling
- Returns embeddings in JSON format
- Provides REST API access to embeddings

**Pros:**

- API-based access
- No direct SQL connection needed from clients

**Cons:**

- Requires new Function implementation
- Additional maintenance overhead

### Option 3: Modify DAB Configuration

Remove `DescriptionEmbedding` and `CommentsEmbedding` from DAB exposed fields, since they can't be properly serialized anyway.

## Recommendation

**Revert the scripts to use SQL Server direct connection** for embedding exports. The DAB API is excellent for structured data queries but is not designed for binary/vector data export scenarios.

The embeddings export is a specialized operation that happens during deployment/data migration, not a regular application feature, so direct SQL access is appropriate here.
