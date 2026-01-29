#!/usr/bin/env node
/**
 * Export Product Review embeddings from Azure SQL to CSV format compatible with VECTOR columns
 * Output format: ProductReviewID, ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, ModifiedDate, CommentsEmbedding (JSON array)
 */

const sql = require("mssql");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Get SQL connection details from azd environment
function getSqlConfig() {
  try {
    const output = execSync("azd env get-values", { encoding: "utf8" });
    const config = {};

    const serverMatch = output.match(/SQL_SERVER_NAME="([^"]+)"/);
    const dbMatch = output.match(/SQL_DATABASE_NAME="([^"]+)"/);
    const userMatch = output.match(/SQL_ADMIN_USER="([^"]+)"/);
    const passMatch = output.match(/SQL_ADMIN_PASSWORD="([^"]+)"/);

    if (serverMatch) config.server = serverMatch[1] + ".database.windows.net";
    if (dbMatch) config.database = dbMatch[1];
    if (userMatch) config.user = userMatch[1];
    if (passMatch) config.password = passMatch[1];

    config.options = {
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 30000,
      requestTimeout: 120000,
    };

    return config;
  } catch (error) {
    console.error("Could not get SQL config from azd:", error.message);
    process.exit(1);
  }
}

const config = getSqlConfig();
const outputFile = path.join(__dirname, "sql", "ProductReview-ai.csv");

async function exportEmbeddings() {
  let pool;
  const startTime = Date.now();

  try {
    console.log(`Connecting to SQL Server: ${config.server}`);
    console.log(`Database: ${config.database}`);
    console.log("");

    pool = await sql.connect(config);

    console.log("✓ Connected to database");
    console.log("Querying product reviews with embeddings...");
    console.log("");

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

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✓ Query completed in ${elapsed}s`);
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

    console.log("📝 Writing CSV file...");

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

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("");
    console.log(
      `✓ Successfully exported ${rows.length} embeddings to ${outputFile}`
    );
    console.log(
      `  File size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(
        2
      )} MB`
    );
    console.log(`  Total time: ${totalTime}s`);
    console.log(
      `  Average rate: ${(rows.length / totalTime).toFixed(1)} items/sec`
    );
  } catch (err) {
    console.error("Error:", err.message);
    console.error(err.stack);
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
