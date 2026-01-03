#!/usr/bin/env node
/**
 * Export Product Review embeddings from Azure SQL to CSV format compatible with VECTOR columns
 * Output format: ProductReviewID, ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, ModifiedDate, CommentsEmbedding (JSON array), Approved
 */

const sql = require("mssql");
const fs = require("fs");
const path = require("path");

const config = {
  server: process.env.SQL_SERVER || "av-sql-ewphuc52etkbc.database.windows.net",
  database: process.env.SQL_DATABASE || "AdventureWorks",
  user: process.env.SQL_USER || "CloudSA7d3784da",
  password: process.env.SQL_PASSWORD || "TempP@ssw0rd123!",
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000,
    requestTimeout: 60000,
  },
};

const outputFile = path.join(__dirname, "sql", "ProductReview-ai.csv");

async function exportEmbeddings() {
  let pool;

  try {
    console.log("Connecting to database...");
    pool = await sql.connect(config);

    console.log("Querying product reviews with embeddings...");
    const result = await pool.request().query(`
            SELECT 
                ProductReviewID,
                ProductID,
                ReviewerName,
                ReviewDate,
                EmailAddress,
                Rating,
                Comments,
                ModifiedDate,
                CommentsEmbedding
            FROM Production.ProductReview
            WHERE CommentsEmbedding IS NOT NULL
            ORDER BY ProductReviewID
        `);

    console.log(
      `Found ${result.recordset.length} product reviews with embeddings`
    );

    if (result.recordset.length === 0) {
      console.log("No embeddings found. Exiting.");
      return;
    }

    // Create output directory if needed
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write CSV file
    const rows = result.recordset.map((row) => {
      // VECTOR column is already returned as JSON string by SQL Server
      const embedding = row.CommentsEmbedding;

      // Escape quotes in comments
      const comments = row.Comments.replace(/\t/g, " ")
        .replace(/\r/g, "")
        .replace(/\n/g, " ")
        .replace(/"/g, '""');

      // Format: tab-separated values with quoted Comments field
      return [
        row.ProductReviewID,
        row.ProductID,
        row.ReviewerName,
        row.ReviewDate.toISOString(),
        row.EmailAddress,
        row.Rating,
        `"${comments}"`, // Quote the comments field
        row.ModifiedDate.toISOString(),
        embedding, // Already JSON format: "[0.1,0.2,...]"
      ].join("\t");
    });

    fs.writeFileSync(outputFile, rows.join("\n"), "utf8");

    console.log(
      `✓ Successfully exported ${rows.length} embeddings to ${outputFile}`
    );
    console.log(
      `  File size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(
        2
      )} MB`
    );
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  } finally {
    if (pool) {
      await pool.close();
    }
  }
}

// Run the export
exportEmbeddings()
  .then(() => {
    console.log("Export complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
