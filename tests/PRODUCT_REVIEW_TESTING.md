# Product Review Testing

This document describes the test suite for the product review feature in the AdventureWorks e-commerce application.

## Overview

The product review feature allows authenticated users to:

- Add reviews with ratings (1-5 stars), title, and comments
- View existing reviews for products
- Mark reviews as helpful
- Sort reviews by different criteria (newest, most helpful, highest/lowest rating)

## Test Files

### 1. Playwright E2E Tests: `tests/specs/product-reviews.spec.ts`

Comprehensive end-to-end tests that simulate user interactions through the browser.

#### Test Cases

##### Test 1: Authenticated user can add a product review

- **Purpose**: Verify that logged-in users can successfully submit product reviews
- **Steps**:
  1. Create a test user and sign up
  2. Navigate to a product page
  3. Scroll to the reviews section
  4. Fill out the review form (rating, title, comment)
  5. Submit the review
  6. Verify the review appears in the list
- **Expected Result**: Review is successfully created and displayed

##### Test 2: Unauthenticated user sees login prompt

- **Purpose**: Verify that non-authenticated users cannot submit reviews
- **Steps**:
  1. Navigate to product page without logging in
  2. Scroll to reviews section
  3. Check for authentication prompt or disabled form
- **Expected Result**: User is prompted to sign in or form is disabled

##### Test 3: User cannot submit review with missing required fields

- **Purpose**: Validate form validation works correctly
- **Steps**:
  1. Create and authenticate test user
  2. Navigate to product page
  3. Attempt to submit form without filling fields
  4. Fill partial fields and attempt submission
- **Expected Result**: Validation errors are shown for missing required fields

##### Test 4: User can view existing reviews

- **Purpose**: Verify reviews are properly displayed
- **Steps**:
  1. Navigate to product page
  2. Scroll to reviews section
  3. Check for review cards or "no reviews" message
  4. Verify rating summary and stars are visible
- **Expected Result**: Reviews or appropriate messaging is displayed

##### Test 5: User can sort reviews

- **Purpose**: Verify sort functionality works
- **Steps**:
  1. Create authenticated user
  2. Navigate to product with reviews
  3. Test different sort options (newest, helpful, highest, lowest)
- **Expected Result**: Sort controls work and reviews are reordered

#### Running Playwright Tests

```bash
# Run all product review tests
npx playwright test tests/specs/product-reviews.spec.ts

# Run a specific test
npx playwright test tests/specs/product-reviews.spec.ts -g "authenticated user can add"

# Run with UI
npx playwright test tests/specs/product-reviews.spec.ts --ui

# Run in debug mode
npx playwright test tests/specs/product-reviews.spec.ts --debug

# Generate HTML report
npx playwright test tests/specs/product-reviews.spec.ts --reporter=html
npx playwright show-report
```

### 2. API Test Script: `test-product-reviews.sh`

Shell script for testing the REST and GraphQL APIs directly, useful for backend validation.

#### Test Cases

1. **GET existing reviews** - Fetches reviews for a specific product
2. **POST new review** - Creates a new product review
3. **Verify new review** - Confirms the review was created successfully
4. **PATCH review** - Updates helpful votes count
5. **GraphQL query** - Tests fetching reviews via GraphQL

#### Running the Shell Script

```bash
# Using API URL from azd environment
./test-product-reviews.sh

# Using a specific API URL
./test-product-reviews.sh https://your-api-url.azurecontainerapps.io
```

#### Sample Output

```
=========================================
Testing Product Review Functionality
=========================================
API URL: https://api.adventureworks.com

Test Configuration:
  Product ID: 680
  Reviewer: Test User 1738090123
  Email: test-1738090123@example.com
  Rating: 4/5
  User ID: 5432

Test 1: Fetching existing reviews for product 680
-------------------------------------------
✓ Successfully fetched reviews (Count: 15)

Test 2: Adding a new product review
-------------------------------------------
✓ Successfully added review (Review ID: 4567)

...
```

## API Integration

The product review feature integrates with:

### GraphQL API (DAB)

- **Entity**: `ProductReview`
- **Source**: `Production.ProductReview` table
- **Endpoints**: Available through Data API Builder

### REST API

- `GET /api/ProductReview` - List all reviews
- `GET /api/ProductReview?$filter=ProductID eq {id}` - Get reviews for a product
- `POST /api/ProductReview` - Create new review
- `PATCH /api/ProductReview/{id}` - Update review (e.g., helpful votes)
- `DELETE /api/ProductReview/{id}` - Delete review

### GraphQL Queries

```graphql
query GetProductReviews($productId: Int!) {
  productReviews(filter: { ProductID: { eq: $productId } }) {
    items {
      ProductReviewID
      ProductID
      ReviewerName
      Rating
      Comments
      ReviewDate
      HelpfulVotes
      UserID
    }
  }
}
```

## Database Schema

The `Production.ProductReview` table includes:

| Column          | Type           | Description               |
| --------------- | -------------- | ------------------------- |
| ProductReviewID | int            | Primary key               |
| ProductID       | int            | Foreign key to Product    |
| ReviewerName    | nvarchar(50)   | Name of reviewer          |
| ReviewDate      | datetime       | When review was submitted |
| EmailAddress    | nvarchar(50)   | Reviewer's email          |
| Rating          | int            | Rating from 1-5 stars     |
| Comments        | nvarchar(3850) | Review text               |
| HelpfulVotes    | int            | Number of helpful votes   |
| UserID          | int            | User identifier           |

## Component Architecture

### Frontend Components

1. **ProductReviews.tsx** - Main container component
   - Displays review summary with average rating
   - Shows rating distribution bars
   - Contains ReviewForm and list of ReviewCard components
   - Handles sorting and filtering

2. **ReviewForm.tsx** - Review submission form
   - Star rating selector (1-5 stars)
   - Title input field
   - Comment textarea
   - Form validation
   - Submit button

3. **ReviewCard.tsx** - Individual review display
   - Reviewer name and date
   - Star rating display
   - Review title and comment
   - Helpful vote button

### Hooks

- **useReviews.ts** - Custom hook for review management
  - Fetches reviews from API
  - Manages localStorage for user-submitted reviews
  - Handles adding new reviews
  - Tracks helpful vote marks
  - Provides review statistics (average rating, count)

## Testing Best Practices

1. **Service Warmup**: Tests include warmup calls to prevent Azure cold start delays
2. **Wait Times**: Adequate timeouts for Azure services to respond
3. **User Authentication**: Tests create unique users to avoid conflicts
4. **Cleanup**: Shell script provides commands to remove test data
5. **Error Handling**: Tests verify both success and failure cases

## Common Issues and Solutions

### Cold Start Delays

**Issue**: Tests timeout waiting for services
**Solution**: Increase warmup timeouts or add longer waits after navigation

### Authentication Required

**Issue**: API returns 401 when creating reviews
**Solution**: Ensure user is properly authenticated and tokens are valid

### Review Not Appearing

**Issue**: Submitted review doesn't show in list
**Solution**: Check API response, verify database permissions, ensure proper refresh logic

### Validation Errors

**Issue**: Form submission fails with validation errors
**Solution**: Ensure all required fields (rating, title, comment) meet minimum requirements

## Future Enhancements

Potential improvements to the test suite:

1. Test review editing functionality
2. Test review deletion
3. Test image upload with reviews
4. Test review moderation/flagging
5. Test pagination for products with many reviews
6. Test review filtering by rating
7. Performance testing with large datasets
8. Load testing for concurrent review submissions

## Related Documentation

- [AdventureWorks E-Commerce Instructions](.github/copilot-instructions.md)
- [DAB Naming Conventions](docs/DAB_NAMING_CONVENTIONS.md)
- [Test Requirements](tests/Test%20Requirements.md)
- [Playwright Configuration](tests/playwright.config.ts)
