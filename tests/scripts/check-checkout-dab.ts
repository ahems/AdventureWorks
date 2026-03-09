/**
 * Check if checkout-related data exists in the database via DAB (products, ship methods, state provinces for tax).
 * Run: npx tsx tests/scripts/check-checkout-dab.ts
 */
import { testEnv } from "../utils/env";

const graphqlUrl = testEnv.restApiBaseUrl.replace(/\/api\/?$/, "/graphql");

async function queryGraphQL(
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
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

  let hasError = false;

  // 1. Products (finished goods) - needed to add to cart
  const productsQuery = `
    query {
      products(filter: { FinishedGoodsFlag: { eq: true } }, first: 20) {
        items {
          ProductID
          Name
          SellStartDate
          DiscontinuedDate
        }
      }
    }
  `;
  const productsData = await queryGraphQL(productsQuery);
  const products = productsData.products?.items ?? [];
  console.log(`Products (FinishedGoodsFlag = true): ${products.length}`);
  if (products.length === 0) {
    console.log("   ❌ No finished-goods products. Check seed job.");
    hasError = true;
  } else {
    const withSellDate = products.filter((p: any) => p.SellStartDate && !p.DiscontinuedDate);
    console.log(`   (with SellStartDate and not discontinued: ${withSellDate.length})`);
  }
  console.log("");

  // 2. ShipMethod - checkout uses shipMethodId (default 5)
  const shipMethodsQuery = `
    query {
      shipMethods(first: 10) {
        items {
          ShipMethodID
          Name
        }
      }
    }
  `;
  const shipData = await queryGraphQL(shipMethodsQuery);
  const shipMethods = shipData.shipMethods?.items ?? [];
  console.log(`ShipMethod: ${shipMethods.length}`);
  if (shipMethods.length === 0) {
    console.log("   ❌ No ship methods. Checkout will fail. Seed Purchasing.ShipMethod.");
    hasError = true;
  } else {
    const has5 = shipMethods.some((s: any) => s.ShipMethodID === 5);
    console.log(`   (ShipMethodID 5 used as fallback: ${has5 ? "yes" : "no"})`);
  }
  console.log("");

  // 3. StateProvince - for address and tax (US states e.g. WA, CA, TX)
  const stateQuery = `
    query {
      stateProvinces(first: 100) {
        items {
          StateProvinceID
          StateProvinceCode
          CountryRegionCode
        }
      }
    }
  `;
  const stateData = await queryGraphQL(stateQuery);
  const stateProvinces = stateData.stateProvinces?.items ?? [];
  const usStates = stateProvinces.filter((s: any) => s.CountryRegionCode === "US");
  console.log(`StateProvince: ${stateProvinces.length} total, ${usStates.length} US`);
  if (usStates.length === 0) {
    console.log("   ❌ No US state provinces. Address/tax may fail. Seed Person.StateProvince.");
    hasError = true;
  } else {
    const codes = usStates.slice(0, 5).map((s: any) => s.StateProvinceCode).join(", ");
    console.log(`   Sample US codes: ${codes}`);
  }
  console.log("");

  // 4. SalesTaxRate - checkout fetches tax by StateProvinceID
  const taxQuery = `
    query {
      salesTaxRates(first: 10) {
        items {
          SalesTaxRateID
          StateProvinceID
          TaxRate
        }
      }
    }
  `;
  const taxData = await queryGraphQL(taxQuery);
  const taxRates = taxData.salesTaxRates?.items ?? [];
  console.log(`SalesTaxRate: ${taxRates.length}`);
  if (taxRates.length === 0) {
    console.log("   ⚠️  No tax rates (checkout may use default 8%). Seed Sales.SalesTaxRate if needed.");
  }
  console.log("");

  if (hasError) {
    console.log("Result: Checkout backend data is missing. Fix seed job and re-run.");
    process.exit(1);
  }
  console.log("Result: Checkout-related data is present. Cart/checkout failures are likely runtime (cart API, auth, or UI).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
