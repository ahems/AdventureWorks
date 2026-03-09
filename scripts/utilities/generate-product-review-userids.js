#!/usr/bin/env node
/**
 * Fetches all PersonType IN (Individual) BusinessEntityIDs from the DAB API,
 * collects all ProductReviewIDs from ProductReview.csv and ProductReview-ai.csv,
 * and writes ProductReview-ai-UserID.csv with ProductReviewID and a random UserID
 * for each. The seed-job uses this CSV to update Production.ProductReview.UserID
 * after loading the other review CSVs.
 *
 * Usage: API_URL=https://your-dab-api/graphql node generate-product-review-userids.js
 *        Or set VITE_API_URL; script uses API_URL or VITE_API_URL (with /graphql stripped if present).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const graphqlEndpoint =
  process.env.API_URL || process.env.VITE_API_URL || "";
const baseUrl = graphqlEndpoint.replace(/\/graphql\/?$/i, "") || "https://av-api-pdnyzls7xb2ye.yellowdesert-d26d8c44.eastus2.azurecontainerapps.io";
const endpoint = baseUrl + (baseUrl.endsWith("/graphql") ? "" : "/graphql");

const repoRoot = path.resolve(__dirname, "../..");
const sqlDir = path.join(repoRoot, "seed-job", "sql");
const productReviewCsv = path.join(sqlDir, "ProductReview.csv");
const productReviewAiCsv = path.join(sqlDir, "ProductReview-ai.csv");
const outputCsv = path.join(sqlDir, "ProductReview-ai-UserID.csv");

function makeGraphQLRequest(query) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
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
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) {
            reject(new Error(JSON.stringify(parsed.errors)));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error("Parse response: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function fetchAllINBusinessEntityIDs() {
  const ids = [];
  let cursor = null;
  let page = 0;
  while (true) {
    page++;
    const afterClause = cursor ? `, after: "${cursor.replace(/"/g, '\\"')}"` : "";
    const query = `
      query {
        people(first: 1000, filter: { PersonType: { eq: "IN" } }, orderBy: { BusinessEntityID: ASC }${afterClause}) {
          items { BusinessEntityID }
          hasNextPage
          endCursor
        }
      }
    `;
    const resp = await makeGraphQLRequest(query);
    const people = resp.data?.people;
    if (!people?.items?.length) break;
    for (const p of people.items) {
      if (p.BusinessEntityID != null) ids.push(p.BusinessEntityID);
    }
    if (!people.hasNextPage || !people.endCursor) break;
    cursor = people.endCursor;
  }
  return ids;
}

function getProductReviewIdsFromCsv(filePath, delimiter = "\t") {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(delimiter);
    const id = parseInt(cols[0], 10);
    if (!Number.isNaN(id)) ids.push(id);
  }
  return ids;
}

function main() {
  (async () => {
    console.log("DAB endpoint:", endpoint);
    console.log("Fetching all PersonType IN (Individual) BusinessEntityIDs...");
    const inIds = await fetchAllINBusinessEntityIDs();
    console.log("  Found", inIds.length, "IN BusinessEntityIDs");

    const fromBase = getProductReviewIdsFromCsv(productReviewCsv);
    const fromAi = getProductReviewIdsFromCsv(productReviewAiCsv);
    const allReviewIds = [...new Set([...fromBase, ...fromAi])].sort(
      (a, b) => a - b
    );
    console.log(
      "  ProductReviewIDs:",
      fromBase.length,
      "from ProductReview.csv +",
      fromAi.length,
      "from ProductReview-ai.csv =>",
      allReviewIds.length,
      "unique"
    );

    if (inIds.length === 0) {
      console.error("No IN IDs; cannot assign UserIDs.");
      process.exit(1);
    }

    const lines = ["ProductReviewID\tUserID"];
    for (const reviewId of allReviewIds) {
      const userID =
        inIds[Math.floor(Math.random() * inIds.length)];
      lines.push(`${reviewId}\t${userID}`);
    }
    fs.writeFileSync(outputCsv, lines.join("\n") + "\n", "utf8");
    console.log("Wrote", outputCsv, "with", allReviewIds.length, "rows.");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

main();
