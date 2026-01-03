#!/usr/bin/env node
/**
 * Export Product Description embeddings from Azure SQL to CSV format compatible with VECTOR columns
 * Output format: ProductDescriptionID, Description, rowguid, ModifiedDate, DescriptionEmbedding (JSON array)
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

const outputFile = path.join(__dirname, "sql", "ProductDescription-ai.csv");

async function exportEmbeddings() {
  let pool;

  try {
    console.log("Connecting to database...");
    pool = await sql.connect(config);

    console.log("Querying product descriptions with embeddings...");
    const result = await pool.request().query(`
            SELECT 
                ProductDescriptionID,
                Description,
                rowguid,
                ModifiedDate,
                DescriptionEmbedding
            FROM Production.ProductDescription
            WHERE DescriptionEmbedding IS NOT NULL
            ORDER BY ProductDescriptionID
        `);

    console.log(
      `Found ${result.recordset.length} product descriptions with embeddings`
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
      const embedding = row.DescriptionEmbedding;

      // Format: tab-separated values
      return [
        row.ProductDescriptionID,
        row.Description.replace(/\t/g, " ")
          .replace(/\n/g, " ")
          .replace(/\r/g, ""), // Remove tabs/newlines
        row.rowguid,
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
