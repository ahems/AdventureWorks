# AI-Powered Product Review Generation

This feature generates creative, fun product reviews using Azure OpenAI to make the demo site more engaging and realistic.

## Overview

The `GenerateProductReviewsUsingAI` function creates between 0 and 10 reviews per product with varied sentiment and creative commentary that matches the playful tone of the AdventureWorks demo site.

## Features

### Random Review Generation

- **0-10 reviews per product**: Randomly determined for each product
- **Varied reviewer names**: Mix of different names, some appearing multiple times
- **Realistic email addresses**: Generated to match reviewer names
- **Creative commentary**: Fun, amusing reasons users might love or hate products

### Sentiment Control

Each product is randomly assigned a sentiment ratio:

1. **Ratio 1 - Mostly Positive** (70-80% positive)

   - Most reviews: 4-5 stars
   - Some reviews: 3 stars (mixed)
   - Few reviews: 1-2 stars

2. **Ratio 2 - Mixed** (50/50 split)

   - Evenly distributed between positive (4-5 stars) and negative (1-2 stars)
   - Some 3-star reviews for balance

3. **Ratio 3 - Mostly Negative** (70-80% negative)
   - Most reviews: 1-2 stars
   - Some reviews: 3 stars (mixed)
   - Few reviews: 4-5 stars

### Review Content

Reviews are generated to:

- Reference specific product features from enhanced descriptions
- Include funny, creative reasons for liking/disliking products
- Match the playful tone of AI-enhanced product descriptions
- Sound authentic with personality and varied writing styles
- Range from short quips to detailed commentary

## Usage

### Option 1: Generate Reviews Only

```bash
./generate-reviews.sh
```

This script:

1. Triggers the review generation function
2. Polls for completion
3. Reports the total number of reviews generated

### Option 2: Complete Workflow (Recommended)

```bash
./generate-reviews-with-embeddings.sh
```

This script runs the complete workflow:

1. Generates AI-powered reviews for all products
2. Creates embeddings for the reviews (enables semantic search)

### Option 3: Manual API Calls

**Generate Reviews:**

```bash
curl -X POST http://localhost:7071/api/GenerateProductReviewsUsingAI_HttpStart
```

**Generate Review Embeddings:**

```bash
curl -X POST http://localhost:7071/api/GenerateProductReviewEmbeddings_HttpStart
```

## Architecture

### Function: GenerateProductReviewsUsingAI

- **Type**: Durable Function Orchestration
- **Pattern**: Fan-out/fan-in with batching
- **Batch Size**: 5 products at a time

### Activities

1. **FetchProductsActivity**

   - Retrieves all finished goods products
   - Includes product name and English description
   - Counts existing reviews per product

2. **GenerateReviewsWithAIActivity**

   - Uses Azure OpenAI (GPT model) for generation
   - High temperature (0.9) for creative variety
   - Processes each product individually for better control

3. **SaveReviewsActivity**
   - Inserts generated reviews into Production.ProductReview table
   - Sets ReviewDate to current timestamp
   - Links reviews to products

### Function: GenerateProductReviewEmbeddings

- **Purpose**: Creates vector embeddings for semantic search
- **Target**: Reviews with comments (not null)
- **Embedding Model**: text-embedding-3-small (1536 dimensions)
- **Storage**: VARBINARY(MAX) in CommentsEmbedding column

## Database Schema

### Production.ProductReview Table

```sql
ProductReviewID       INT            -- Auto-generated
ProductID             INT            -- Links to Product
ReviewerName          NVARCHAR(50)   -- Randomly generated name
ReviewDate            DATETIME       -- Auto-set to GETDATE()
EmailAddress          NVARCHAR(50)   -- Generated email
Rating                INT            -- 1-5 stars
Comments              NVARCHAR(3850) -- AI-generated review text
CommentsEmbedding     VARBINARY(MAX) -- Vector embedding (generated separately)
ModifiedDate          DATETIME       -- Auto-set to GETDATE()
```

### Production.vReviewSearch View

Combines review data with product information for semantic search:

- ProductReviewID
- ProductID, ProductName, ProductNumber
- ReviewerName, ReviewDate, Rating
- Comments and CommentsEmbedding

## Example Review Output

For a mountain bike with enhanced description about "ultra-shiny frame" and "turbo-charged gears":

**Positive Review (5 stars):**

> "This bike is absolutely incredible! The ultra-shiny frame made me feel like I was riding a disco ball down the mountain trail. My friends couldn't stop staring, and neither could I! The turbo-charged gears shifted so smoothly I barely had to think about it. Best purchase ever! 🚴‍♂️✨"

**Mixed Review (3 stars):**

> "The shine is definitely there - maybe too much shine? I had to wear sunglasses even on cloudy days. Gears work well, but I was expecting actual turbo speeds from the description. Still a decent bike, just manage your expectations."

**Negative Review (1 star):**

> "I bought this expecting a magical experience based on the description, but all I got was a very shiny bike and sore legs. The 'turbo-charged' gears are just... regular gears? And the shine attracted so many birds thinking it was water. Would not recommend unless you like bird encounters."

## Performance Considerations

- **Processing Time**: ~30-60 minutes for all products (depends on product count)
- **API Costs**: Uses Azure OpenAI tokens for each review
- **Batch Processing**: 5 products at a time to manage API rate limits
- **Embedding Generation**: Separate function, processes 10 reviews at a time

## Integration with Frontend

Reviews are displayed on product detail pages via:

1. DAB GraphQL API exposing Production.ProductReview
2. React component: `ProductReviews.tsx`
3. Sorting options: newest, most helpful, highest/lowest rating
4. Star ratings and review statistics

## Tips

- Run review generation before demos to populate realistic content
- Sentiment ratios ensure varied product perceptions
- Same reviewer names across products create realistic user profiles
- Embeddings enable "find similar reviews" features
- Reviews complement AI-enhanced product descriptions

## Future Enhancements

Potential improvements:

- User voting on review helpfulness
- Review response from "store"
- Verified purchase badges
- Image uploads in reviews
- Review filtering by rating
- Sentiment analysis display
