#!/usr/bin/env node

const https = require("https");
const fs = require("fs");
const path = require("path");

const API_URL = process.env.API_URL || process.env.VITE_API_URL;

if (!API_URL) {
  console.error("Error: API_URL environment variable not set");
  process.exit(1);
}

const graphqlEndpoint = API_URL.replace(/\/$/, "");

// First, let's query the schema to see what fields are available
const introspectionQuery = `
  query IntrospectProductReview {
    __type(name: "ProductReview") {
      name
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }
`;

function createQuery(afterCursor = null, pageSize = 100) {
  const afterClause = afterCursor ? `, after: "${afterCursor}"` : "";
  return `
    query GetProductReviews {
      productReviews(first: ${pageSize}${afterClause}) {
        items {
          ProductReviewID
          ProductID
          ReviewerName
          ReviewDate
          EmailAddress
          Rating
          Comments
          ModifiedDate
          CommentsEmbedding
          HelpfulVotes
          UserID
        }
        hasNextPage
        endCursor
      }
    }
  `;
}

function makeGraphQLRequest(query) {
  return new Promise((resolve, reject) => {
    const url = new URL(graphqlEndpoint);
    const postData = JSON.stringify({ query });

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", (e) => {
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

function escapeCSVField(field) {
  if (field === null || field === undefined) {
    return "";
  }

  const str = String(field);

  // If field contains comma, quote, newline, or tab, wrap in quotes and escape quotes
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r") ||
    str.includes("\t")
  ) {
    return '"' + str.replace(/"/g, '""') + '"';
  }

  return str;
}

async function exportProductReviews() {
  console.log("Fetching product reviews from:", graphqlEndpoint);

  try {
    // First, introspect the schema to see available fields
    console.log("Checking ProductReview schema...");
    const schemaResponse = await makeGraphQLRequest(introspectionQuery);

    if (schemaResponse.data?.__type?.fields) {
      console.log("Available fields:");
      schemaResponse.data.__type.fields.forEach((field) => {
        console.log(`  - ${field.name}: ${field.type.name || field.type.kind}`);
      });
    }

    // Fetch all reviews with pagination
    console.log("\nFetching reviews with pagination...");
    let allReviews = [];
    let hasNextPage = true;
    let afterCursor = null;
    let pageNum = 0;

    while (hasNextPage) {
      pageNum++;
      const query = createQuery(afterCursor);
      const response = await makeGraphQLRequest(query);

      if (response.errors) {
        console.error(
          "GraphQL errors:",
          JSON.stringify(response.errors, null, 2)
        );
        process.exit(1);
      }

      const pageData = response.data?.productReviews;
      if (!pageData) {
        console.error("No productReviews data in response");
        break;
      }

      const reviews = pageData.items || [];
      allReviews = allReviews.concat(reviews);

      hasNextPage = pageData.hasNextPage || false;
      afterCursor = pageData.endCursor;

      console.log(
        `  Page ${pageNum}: Retrieved ${reviews.length} reviews (total: ${allReviews.length})`
      );

      if (hasNextPage && !afterCursor) {
        console.warn(
          "  Warning: hasNextPage is true but no endCursor provided"
        );
        break;
      }
    }

    console.log(`\n✓ Retrieved ${allReviews.length} total product reviews`);

    if (allReviews.length === 0) {
      console.warn("No product reviews found in database");
      return;
    }

    const reviews = allReviews;

    // Create CSV content
    const csvLines = [];

    // Note: Original CSV format appears to be tab-delimited based on the sample
    // Using tabs to match the original format
    // Column order: ProductReviewID, ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, ModifiedDate, CommentsEmbedding, HelpfulVotes, UserID
    reviews.forEach((review) => {
      const row = [
        escapeCSVField(review.ProductReviewID),
        escapeCSVField(review.ProductID),
        escapeCSVField(review.ReviewerName),
        escapeCSVField(review.ReviewDate),
        escapeCSVField(review.EmailAddress),
        escapeCSVField(review.Rating),
        escapeCSVField(review.Comments),
        escapeCSVField(review.ModifiedDate),
        escapeCSVField(review.CommentsEmbedding || ""),
        escapeCSVField(review.HelpfulVotes || 0),
        escapeCSVField(review.UserID || ""),
      ];
      csvLines.push(row.join("\t"));
    });

    const csvContent = csvLines.join("\n");

    // Save to file
    const outputPath = path.join(__dirname, "sql", "ProductReview-ai.csv");
    fs.writeFileSync(outputPath, csvContent, "utf8");

    console.log(
      `✓ Successfully exported ${reviews.length} product reviews to ${outputPath}`
    );
    console.log(`File size: ${(csvContent.length / 1024).toFixed(2)} KB`);

    // Show sample of first review
    if (reviews.length > 0) {
      console.log("\nSample (first review):");
      console.log("  ProductReviewID:", reviews[0].ProductReviewID);
      console.log("  ProductID:", reviews[0].ProductID);
      console.log("  ReviewerName:", reviews[0].ReviewerName);
      console.log("  Rating:", reviews[0].Rating);
      console.log("  HelpfulVotes:", reviews[0].HelpfulVotes);
      console.log("  UserID:", reviews[0].UserID || "NULL");
      console.log("  Has Embedding:", !!reviews[0].CommentsEmbedding);
      if (reviews[0].CommentsEmbedding) {
        console.log(
          "  Embedding length:",
          reviews[0].CommentsEmbedding.length,
          "chars"
        );
      }
    }
  } catch (error) {
    console.error("Error exporting product reviews:", error.message);
    process.exit(1);
  }
}

exportProductReviews();
