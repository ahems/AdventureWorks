# Product Reviews Export Summary

**Date:** January 3, 2026  
**File:** `scripts/sql/ProductReview-ai.csv`  
**Purpose:** Preserve AI-generated product reviews and embeddings for future redeployment

## Export Details

- **Total reviews exported:** 1,397 (ProductReviewID 1-1397)
- **Reviews with embeddings:** 1,397 (100% coverage)
- **Original reviews with embeddings:** 4 (IDs 1-4)
- **AI-generated embeddings:** 1,393 (IDs 5-1397)
- **File size:** 12 MB (increased from 565 KB after embedding generation)
- **Source:** Azure SQL Database via GraphQL API
- **API Endpoint:** Production Container Apps instance
- **Pagination:** Fetched in 14 pages (100 reviews per page)
- **Embedding Generation:** Azure Durable Functions orchestration completed 2026-01-03 17:57:54 UTC (ID: 6ac7ac8589ef4c43a5ffeffe0227a52f)

> **Note:** The file contains 1,396 lines (last line has no trailing newline), but all 1,397 reviews are present.

## Data Schema

The exported CSV contains the following columns (tab-delimited):

1. **ProductReviewID** - Unique identifier
2. **ProductID** - Product reference
3. **ReviewerName** - Name of reviewer
4. **ReviewDate** - Original review date
5. **EmailAddress** - Reviewer email
6. **Rating** - Rating (1-5)
7. **Comments** - Review text (AI-generated for new reviews)
8. **ModifiedDate** - Last modification timestamp
9. **CommentsEmbedding** - Vector embeddings for semantic search (base64 encoded)
10. **HelpfulVotes** - Count of helpful votes (default: 0)
11. **UserID** - Optional user reference (nullable)

## Embedding Coverage

Based on the export:

- **Total reviews:** 1,397 (ProductReviewID 1-1397)
- **Reviews with embeddings:** 4 reviews (IDs: 1, 2, 3, 4 - the original seed data)
- **Reviews without embeddings:** 1,393 reviews (IDs: 5-1397 - AI-generated reviews)
- **Embedding format:** Base64 encoded binary data (ByteArray)
- **Embedding length:** 8192 characters per embedding when encoded

> **Note:** The AI-generated reviews (IDs 5-1397) do not currently have embeddings in the database. If semantic search is needed for these reviews, embeddings should be generated using the embedding generation function before or after import.

## Sample Review (First Entry)

```
ProductReviewID: 1
ProductID: 709
ReviewerName: John Smith
Rating: 5
Comments: "I can't believe I'm singing the praises of a pair of socks, but..."
ModifiedDate: 2026-01-01T21:29:48.360Z
Has Embedding: Yes
```

## Usage for Redeployment

To restore this data in a new deployment:

1. **Import to database:** Use the SQL import script in `postprovision.ps1`
2. **Update script reference:** Change `ProductReview.csv` to `ProductReview-ai.csv` in the provisioning scripts
3. **Preserve embeddings:** The CommentsEmbedding column maintains semantic search capabilities

## Export Script

The data was exported using `scripts/export-product-reviews.js` which:

- Queries the GraphQL API for all product reviews using pagination
- Handles cursor-based pagination to retrieve all records (100 per page)
- Retrieves all fields including embeddings
- Formats as tab-delimited CSV matching the original schema
- Preserves binary embedding data in the output
- Automatically detects when more pages are available via `hasNextPage` and `endCursor`

## Notes

- Original seed file: `scripts/sql/ProductReview.csv` (1.4 KB, 4 reviews with embeddings)
- New export includes 1,393 additional AI-generated reviews (without embeddings)
- Only the first 4 reviews (original seed data) have embeddings for semantic search
- To enable semantic search for all reviews, run the embedding generation function after import
- ModifiedDate for AI-generated reviews reflects the generation timestamp (January 1-2, 2026)
- All 1,397 reviews are successfully exported and ready for redeployment
