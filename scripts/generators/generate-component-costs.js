#!/usr/bin/env node
/**
 * Generate Component Cost Data for COGS Calculations
 *
 * This script reads the seed-job CSV files and computes material + labor costs
 * for manufactured sub-assemblies that have StandardCost = 0 in the original
 * AdventureWorks data.
 *
 * Outputs:
 *   - seed-job/sql/Product-ai.csv          (full Product rows with updated StandardCost/ListPrice)
 *   - seed-job/sql/ProductCostHistory-generated.csv  (cost history records for sub-assemblies)
 */

const fs = require("fs");
const path = require("path");

const SQL_DIR = path.join(__dirname, "..", "..", "seed-job", "sql");

// --- CSV Parsing Helpers ---

function readTsvFile(filename) {
  const filepath = path.join(SQL_DIR, filename);
  const content = fs.readFileSync(filepath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split("\t"));
}

// --- Load Data ---

console.log("Loading CSV data...");

// Product: ProductID(0) | Name(1) | ProductNumber(2) | MakeFlag(3) | FinishedGoodsFlag(4) |
//          Color(5) | SafetyStockLevel(6) | ReorderPoint(7) | StandardCost(8) | ListPrice(9) |
//          Size(10) | SizeUnitMeasureCode(11) | WeightUnitMeasureCode(12) | Weight(13) |
//          DaysToManufacture(14) | ProductLine(15) | Class(16) | Style(17) |
//          ProductSubcategoryID(18) | ProductModelID(19) | SellStartDate(20) |
//          SellEndDate(21) | DiscontinuedDate(22) | rowguid(23) | ModifiedDate(24)
const productRows = readTsvFile("Product.csv");
const products = new Map();
for (const row of productRows) {
  const id = parseInt(row[0]);
  products.set(id, {
    id,
    name: row[1],
    row, // keep full row for output
    makeFlag: parseInt(row[3]),
    finishedGoodsFlag: parseInt(row[4]),
    standardCost: parseFloat(row[8]) || 0,
    listPrice: parseFloat(row[9]) || 0,
    daysToManufacture: parseInt(row[14]) || 0,
  });
}
console.log(`  Products: ${products.size}`);

// BillOfMaterials: BillOfMaterialsID(0) | ProductAssemblyID(1) | ComponentID(2) |
//                  StartDate(3) | EndDate(4) | UnitMeasureCode(5) | BOMLevel(6) |
//                  PerAssemblyQty(7) | ModifiedDate(8)
const bomRows = readTsvFile("BillOfMaterials.csv");
// Build map: ProductAssemblyID -> [{componentId, perAssemblyQty}]
// Only include active BOM entries (EndDate is empty)
const bomByAssembly = new Map();
for (const row of bomRows) {
  const assemblyId = row[1].trim() ? parseInt(row[1]) : null;
  const componentId = parseInt(row[2]);
  const endDate = row[4].trim();
  const perAssemblyQty = parseFloat(row[7]) || 0;

  if (assemblyId === null) continue; // BOMLevel 0 top-level markers
  if (endDate) continue; // Inactive/historical BOM entry

  if (!bomByAssembly.has(assemblyId)) {
    bomByAssembly.set(assemblyId, []);
  }
  bomByAssembly.get(assemblyId).push({ componentId, perAssemblyQty });
}
console.log(`  Active BOM assemblies: ${bomByAssembly.size}`);

// ProductVendor: ProductID(0) | BusinessEntityID(1) | AverageLeadTime(2) |
//               StandardPrice(3) | LastReceiptCost(4) | LastReceiptDate(5) |
//               MinOrderQty(6) | MaxOrderQty(7) | OnOrderQty(8) |
//               UnitMeasureCode(9) | ModifiedDate(10)
const vendorRows = readTsvFile("ProductVendor.csv");
// Use the minimum StandardPrice across vendors for each product (best available cost)
const vendorCosts = new Map();
for (const row of vendorRows) {
  const productId = parseInt(row[0]);
  const standardPrice = parseFloat(row[3]) || 0;
  if (
    !vendorCosts.has(productId) ||
    standardPrice < vendorCosts.get(productId)
  ) {
    vendorCosts.set(productId, standardPrice);
  }
}
console.log(`  Products with vendor pricing: ${vendorCosts.size}`);

// Location: LocationID(0) | Name(1) | CostRate(2) | Availability(3) | ModifiedDate(4)
const locationRows = readTsvFile("Location.csv");
const locationCostRates = new Map();
for (const row of locationRows) {
  locationCostRates.set(parseInt(row[0]), parseFloat(row[2]) || 0);
}
console.log(`  Locations: ${locationCostRates.size}`);

// WorkOrder: WorkOrderID(0) | ProductID(1) | OrderQty(2) | StockedQty(3) |
//            ScrappedQty(4) | StartDate(5) | EndDate(6) | DueDate(7) |
//            ScrapReasonID(8) | ModifiedDate(9)
const workOrderRows = readTsvFile("WorkOrder.csv");
const workOrderProductMap = new Map(); // WorkOrderID -> ProductID
for (const row of workOrderRows) {
  workOrderProductMap.set(parseInt(row[0]), parseInt(row[1]));
}

// WorkOrderRouting: WorkOrderID(0) | ProductID(1) | OperationSequence(2) |
//                   LocationID(3) | ScheduledStartDate(4) | ScheduledEndDate(5) |
//                   ActualStartDate(6) | ActualEndDate(7) | ActualResourceHrs(8) |
//                   PlannedCost(9) | ActualCost(10) | ModifiedDate(11)
const routingRows = readTsvFile("WorkOrderRouting.csv");
// Compute average labor cost per product from actual routing data
// Group by ProductID, sum ActualCost per work order, then average across work orders
const laborByProduct = new Map(); // ProductID -> { totalCost, orderCount }
for (const row of routingRows) {
  const productId = parseInt(row[1]);
  const actualCost = parseFloat(row[10]) || 0;
  const workOrderId = parseInt(row[0]);

  if (!laborByProduct.has(productId)) {
    laborByProduct.set(productId, { totalCost: 0, workOrders: new Set() });
  }
  const entry = laborByProduct.get(productId);
  entry.totalCost += actualCost;
  entry.workOrders.add(workOrderId);
}
// Convert to average labor cost per unit
const avgLaborCostPerProduct = new Map();
for (const [productId, data] of laborByProduct) {
  // Average cost per work order (which typically produces OrderQty units)
  // For simplicity, use total cost / number of work orders as average cost per production run
  const avgPerRun = data.totalCost / data.workOrders.size;
  avgLaborCostPerProduct.set(productId, avgPerRun);
}
console.log(
  `  Products with routing labor data: ${avgLaborCostPerProduct.size}`,
);

// --- Identify Target Products ---

// Manufactured sub-assemblies with zero StandardCost
const targetProducts = [];
for (const [id, prod] of products) {
  if (prod.makeFlag === 1 && prod.standardCost === 0) {
    targetProducts.push(prod);
  }
}
console.log(`\nTarget sub-assemblies with zero cost: ${targetProducts.length}`);
targetProducts.forEach((p) => console.log(`  ${p.id}: ${p.name}`));

// --- Recursive BOM Cost Calculation ---

const costCache = new Map(); // ProductID -> computed material cost

function computeMaterialCost(productId, visited = new Set()) {
  // Avoid infinite recursion
  if (visited.has(productId)) return 0;
  visited.add(productId);

  // Check cache
  if (costCache.has(productId)) return costCache.get(productId);

  const product = products.get(productId);
  if (!product) return 0;

  // If product already has a non-zero StandardCost, use it
  if (product.standardCost > 0) {
    costCache.set(productId, product.standardCost);
    return product.standardCost;
  }

  // If purchased (MakeFlag=0) with vendor pricing, use vendor cost
  if (product.makeFlag === 0 && vendorCosts.has(productId)) {
    const cost = vendorCosts.get(productId);
    costCache.set(productId, cost);
    return cost;
  }

  // If manufactured, recurse through BOM
  const components = bomByAssembly.get(productId);
  if (!components || components.length === 0) {
    // Manufactured with no BOM components - check vendor as fallback
    if (vendorCosts.has(productId)) {
      const cost = vendorCosts.get(productId);
      costCache.set(productId, cost);
      return cost;
    }
    // Truly zero-cost raw material
    costCache.set(productId, 0);
    return 0;
  }

  let totalMaterialCost = 0;
  for (const { componentId, perAssemblyQty } of components) {
    const componentCost = computeMaterialCost(componentId, new Set(visited));
    totalMaterialCost += componentCost * perAssemblyQty;
  }

  costCache.set(productId, totalMaterialCost);
  return totalMaterialCost;
}

// --- Compute Costs ---

console.log("\nComputing costs...");
const results = [];

for (const prod of targetProducts) {
  const materialCost = computeMaterialCost(prod.id);

  // Get labor cost from routing data
  // For sub-assemblies, labor may not have direct routing data.
  // Use a standard estimate based on DaysToManufacture and typical subassembly rates.
  let laborCost = 0;
  if (avgLaborCostPerProduct.has(prod.id)) {
    laborCost = avgLaborCostPerProduct.get(prod.id);
  } else {
    // Estimate: DaysToManufacture × 8 hrs × average subassembly cost rate ($12.25/hr)
    const subassemblyCostRate = 12.25;
    const estimatedHours = Math.max(prod.daysToManufacture, 1) * 2; // 2 hrs per day for sub-assemblies
    laborCost = estimatedHours * subassemblyCostRate;
  }

  // Apply scrap factor (3% based on typical AdventureWorks scrap rates)
  const scrapFactor = 1.03;

  const totalCost = (materialCost + laborCost) * scrapFactor;
  // Round to 4 decimal places (SQL money type)
  const standardCost = Math.round(totalCost * 10000) / 10000;
  // ListPrice = StandardCost × 1.35 markup (consistent with other products)
  const listPrice = Math.round(standardCost * 1.35 * 10000) / 10000;

  results.push({
    productId: prod.id,
    name: prod.name,
    materialCost: Math.round(materialCost * 10000) / 10000,
    laborCost: Math.round(laborCost * 10000) / 10000,
    standardCost,
    listPrice,
    originalRow: prod.row,
  });

  console.log(
    `  ${prod.id} (${prod.name}): material=$${materialCost.toFixed(4)}, labor=$${laborCost.toFixed(4)}, total=$${standardCost.toFixed(4)}, list=$${listPrice.toFixed(4)}`,
  );
}

// --- Generate Product-ai.csv ---

console.log("\nGenerating Product-ai.csv...");
const productAiLines = [];
for (const result of results) {
  const row = [...result.originalRow]; // clone
  row[8] = result.standardCost.toFixed(4); // StandardCost
  row[9] = result.listPrice.toFixed(4); // ListPrice
  // Update ModifiedDate to current generation date
  row[24] = "2025-02-07 10:01:36.827"; // Keep same as original to avoid conflicts
  productAiLines.push(row.join("\t"));
}
const productAiPath = path.join(SQL_DIR, "Product-ai.csv");
fs.writeFileSync(productAiPath, productAiLines.join("\n") + "\n");
console.log(`  Written ${productAiLines.length} rows to ${productAiPath}`);

// --- Generate ProductCostHistory-generated.csv ---

console.log("Generating ProductCostHistory-generated.csv...");
// Format: ProductID | StartDate | EndDate | StandardCost | ModifiedDate
// Use StartDate = 2024-05-29 to match other current records, EndDate = empty (current)
const costHistoryLines = [];
for (const result of results) {
  const line = [
    result.productId,
    "2024-05-29 00:00:00.000", // StartDate
    "", // EndDate (null = current)
    result.standardCost.toFixed(4),
    "2024-05-15 00:00:00.000", // ModifiedDate
  ].join("\t");
  costHistoryLines.push(line);
}
const costHistoryPath = path.join(SQL_DIR, "ProductCostHistory-ai.csv");
fs.writeFileSync(costHistoryPath, costHistoryLines.join("\n") + "\n");
console.log(`  Written ${costHistoryLines.length} rows to ${costHistoryPath}`);

// --- Validation ---

console.log("\n--- Validation ---");
// Check: HL Road Frame (ProductID 680) has StandardCost = $1059.31
// Let's compute what BOM rollup gives us for a bike frame and compare
const hlRoadFrame = products.get(680);
if (hlRoadFrame) {
  const computedCost = computeMaterialCost(680);
  console.log(
    `HL Road Frame (680): existing StandardCost=$${hlRoadFrame.standardCost}, computed material cost=$${computedCost.toFixed(4)}`,
  );
  console.log(`  (Difference is labor + overhead, which is expected)`);
}

// Summary
console.log("\n--- Summary ---");
console.log(
  `Generated cost data for ${results.length} manufactured sub-assemblies`,
);
console.log(
  `Cost range: $${Math.min(...results.map((r) => r.standardCost)).toFixed(2)} - $${Math.max(...results.map((r) => r.standardCost)).toFixed(2)}`,
);
console.log("Done!");
