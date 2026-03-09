/**
 * Check if sale/discount data exists in the database via DAB (same queries as the app).
 * Run: npx tsx tests/scripts/check-sale-discounts-dab.ts
 */
import { testEnv } from "../utils/env";

const graphqlUrl = testEnv.restApiBaseUrl.replace(/\/api\/?$/, "/graphql");

async function queryGraphQL(query: string, variables?: Record<string, unknown>): Promise<any> {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`DAB request failed: ${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function main() {
  console.log("DAB URL:", graphqlUrl);
  console.log("");

  // 1. Customer special offers (same filter as app: Category = "Customer")
  const offersQuery = `
    query {
      specialOffers(filter: { Category: { eq: "Customer" } }) {
        items {
          SpecialOfferID
          Description
          DiscountPct
          Type
          Category
        }
      }
    }
  `;
  const offersData = await queryGraphQL(offersQuery);
  const offers = offersData.specialOffers?.items ?? [];
  console.log(`SpecialOffer (Category = "Customer"): ${offers.length} offer(s)`);
  if (offers.length === 0) {
    console.log("");
    console.log("Result: No customer special offers in database.");
    console.log("Sale page will show no sale products. Seed Sales.SpecialOffer and Sales.SpecialOfferProduct with Category='Customer'.");
    process.exit(1);
  }
  offers.slice(0, 5).forEach((o: any) => {
    console.log(`  - ID ${o.SpecialOfferID}: ${o.Description} (${o.DiscountPct}% off)`);
  });
  if (offers.length > 5) console.log(`  ... and ${offers.length - 5} more`);
  console.log("");

  const offerIds = offers.map((o: any) => o.SpecialOfferID);

  // 2. Product–offer mappings (same as app)
  const mappingsQuery = `
    query GetSpecialOfferProducts($offerIds: [Int!]!) {
      specialOfferProducts(filter: { SpecialOfferID: { in: $offerIds } }) {
        items {
          SpecialOfferID
          ProductID
        }
      }
    }
  `;
  const mappingsData = await queryGraphQL(mappingsQuery, { offerIds });
  const mappings = mappingsData.specialOfferProducts?.items ?? [];
  console.log(`SpecialOfferProduct (for these offers): ${mappings.length} product link(s)`);
  if (mappings.length === 0) {
    console.log("");
    console.log("Result: Customer offers exist but no products are linked.");
    console.log("Seed Sales.SpecialOfferProduct with ProductID and SpecialOfferID to show sale products.");
    process.exit(1);
  }
  const productIds = [...new Set(mappings.map((m: any) => m.ProductID))];
  console.log(`  Unique product IDs with sale: ${productIds.length}`);
  console.log(`  Sample product IDs: ${productIds.slice(0, 10).join(", ")}${productIds.length > 10 ? "..." : ""}`);
  console.log("");
  console.log("Result: Sale/discount data is present. Sale page should show products.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
