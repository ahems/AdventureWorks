import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  MapPin,
  Package,
  ChevronRight,
  ArrowLeft,
  Activity,
  AlertTriangle,
  RefreshCw,
  Plus,
  Factory,
  Calculator,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ShoppingCart,
  Loader2,
  Check,
  FileText,
  ChevronDown,
  ChevronUp,
  Clock,
  Truck,
  CheckCircle,
  XCircle,
  Search,
  Filter,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import {
  fetchProductInventory,
  fetchLocations,
  fetchAllProducts,
  fetchActiveBOM,
  fetchManufacturingStatus,
  fetchWorkOrders,
  updateProductInventory,
  fetchProductCategories,
  fetchProductSubcategories,
  beginManufacturingRun,
  fetchPurchaseOrderHeaders,
  fetchAllPurchaseOrderDetails,
  fetchVendors,
} from "@/services/api";
import {
  fetchCatalog,
  placeOrder,
  fetchOrders,
  type PurchaseOrder,
} from "@/services/supplyChainApi";
import type {
  Product,
  BillOfMaterials,
  ProductInventory,
  Location,
  PurchaseOrderHeader,
  PurchaseOrderDetail,
  Vendor,
} from "@/types/production";
import { TableSkeleton } from "@/components/LoadingSkeletons";
import { Badge } from "@/components/ui/badge";

// ── helpers ──
function collectComponentIds(
  assemblyId: number,
  bom: BillOfMaterials[],
  visited = new Set<number>(),
): Map<number, number> {
  const parts = new Map<number, number>();
  if (visited.has(assemblyId)) return parts;
  visited.add(assemblyId);
  for (const b of bom) {
    if (b.ProductAssemblyID === assemblyId) {
      parts.set(
        b.ComponentID,
        (parts.get(b.ComponentID) || 0) + b.PerAssemblyQty,
      );
      const sub = collectComponentIds(b.ComponentID, bom, visited);
      sub.forEach((qty, id) => parts.set(id, (parts.get(id) || 0) + qty));
    }
  }
  return parts;
}

/** Calculate max number of a finished good that can be built from current inventory */
function calcBuildable(
  productId: number,
  bom: BillOfMaterials[],
  inventoryByProduct: Map<number, number>,
): number {
  const parts = collectComponentIds(productId, bom);
  if (parts.size === 0) return 0;
  let min = Infinity;
  for (const [compId, qtyPer] of parts) {
    if (qtyPer <= 0) continue;
    const available = inventoryByProduct.get(compId) || 0;
    min = Math.min(min, Math.floor(available / qtyPer));
  }
  return min === Infinity ? 0 : min;
}

// ── Reorder Dialog ──
// ── Multi-vendor order splitting helper ──
async function placeMultiVendorOrders(
  vendors: Awaited<ReturnType<typeof fetchCatalog>>,
  productId: number,
  totalQty: number,
): Promise<PurchaseOrder[]> {
  // Sort vendors by unit cost (cheapest first), only those with stock
  const available = vendors
    .filter((v) => v.stockAvailable > 0)
    .sort((a, b) => a.unitCost - b.unitCost);

  if (available.length === 0)
    throw new Error("No vendors have stock for this product");

  const orders: PurchaseOrder[] = [];
  let remaining = totalQty;

  for (const vendor of available) {
    if (remaining <= 0) break;
    // Respect vendor min/max order qty constraints
    const minQty = vendor.minOrderQty || 1;
    const maxQty = vendor.maxOrderQty || vendor.stockAvailable;
    const desired = Math.min(remaining, vendor.stockAvailable, maxQty);
    const orderQty = Math.max(desired, minQty);
    // Don't exceed vendor stock even if minOrderQty is higher
    if (orderQty > vendor.stockAvailable) {
      console.warn(
        `Vendor ${vendor.vendorName}: min order ${minQty} exceeds stock ${vendor.stockAvailable}, skipping`,
      );
      continue;
    }
    try {
      const order = await placeOrder(vendor.vendorId, productId, orderQty);
      orders.push(order);
      remaining -= orderQty;
    } catch (e: unknown) {
      // If vendor rejects (422), try next vendor
      if (
        e instanceof Error &&
        (e.message?.includes("422") ||
          e.message?.includes("Insufficient stock"))
      ) {
        console.warn(
          `Vendor ${vendor.vendorName} rejected order, trying next…`,
        );
        continue;
      }
      throw e;
    }
  }

  if (orders.length === 0)
    throw new Error(
      "All vendors are out of stock or cannot fulfill minimum order requirements",
    );
  return orders;
}

const ReorderDialog = ({
  product,
  inventory,
  locations,
  pendingOrdersByProduct,
  onClose,
}: {
  product: Product;
  inventory: ProductInventory[];
  locations: Location[];
  pendingOrdersByProduct: Map<number, { qty: number; orders: PurchaseOrder[] }>;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const productInv = inventory.filter((i) => i.ProductID === product.ProductID);
  const currentStock = productInv.reduce((s, i) => s + i.Quantity, 0);
  const pending = pendingOrdersByProduct.get(product.ProductID);
  const pendingQty = pending?.qty || 0;
  const effectiveStock = currentStock + pendingQty;
  const deficit = Math.max(0, product.SafetyStockLevel - effectiveStock);
  const suggestedQty =
    deficit > 0 ? deficit : Math.max(product.ReorderPoint, 100);

  const [reorderQty, setReorderQty] = useState(suggestedQty);

  // Fetch vendor catalog for this product
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ["supply-catalog", product.ProductID],
    queryFn: () => fetchCatalog(product.ProductID),
    staleTime: 0,
  });

  // Build the order plan showing how qty will be split across vendors
  const orderPlan = useMemo(() => {
    if (!catalog || catalog.length === 0) return [];
    const available = catalog
      .filter((v) => v.stockAvailable > 0)
      .sort((a, b) => a.unitCost - b.unitCost);
    const plan: {
      vendor: (typeof available)[0];
      qty: number;
      belowMin: boolean;
    }[] = [];
    let remaining = reorderQty;
    for (const vendor of available) {
      if (remaining <= 0) break;
      const minQty = vendor.minOrderQty || 1;
      const maxQty = vendor.maxOrderQty || vendor.stockAvailable;
      const desired = Math.min(remaining, vendor.stockAvailable, maxQty);
      const qty = Math.max(desired, minQty);
      if (qty > vendor.stockAvailable) continue; // min exceeds stock, skip
      plan.push({ vendor, qty, belowMin: desired < minQty });
      remaining -= qty;
    }
    return plan;
  }, [catalog, reorderQty]);

  const totalAvailable = useMemo(() => {
    if (!catalog) return 0;
    return catalog
      .filter((v) => v.stockAvailable > 0)
      .reduce((s, v) => s + v.stockAvailable, 0);
  }, [catalog]);

  const exceedsSupply = reorderQty > totalAvailable;
  const needsMultiVendor = orderPlan.length > 1;

  const orderMutation = useMutation({
    mutationFn: async () => {
      if (!catalog || catalog.length === 0)
        throw new Error("No vendor available");
      return placeMultiVendorOrders(catalog, product.ProductID, reorderQty);
    },
    onSuccess: (orders) => {
      const totalOrdered = orders.reduce(
        (s, o) =>
          s +
          ((o as { quantity?: number }).quantity ?? reorderQty / orders.length),
        0,
      );
      const label =
        totalOrdered > 0
          ? totalOrdered.toLocaleString()
          : reorderQty.toLocaleString();
      if (orders.length === 1) {
        toast.success(
          `Purchase order placed — ${orders[0].orderId.slice(0, 8)}`,
          {
            description: `${label} × ${product.Name} from ${orders[0].vendorName}`,
          },
        );
      } else {
        toast.success(`${orders.length} purchase orders placed`, {
          description: `${label} × ${product.Name} split across ${orders.length} vendors`,
        });
      }
      qc.invalidateQueries({ queryKey: ["product-inventory"] });
      qc.invalidateQueries({ queryKey: ["supply-orders"] });
      qc.invalidateQueries({ queryKey: ["supply-catalog", product.ProductID] });
      onClose();
    },
    onError: (e: Error) =>
      toast.error("Order failed", { description: e.message }),
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="doodle-card-static p-6 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-doodle text-lg font-bold text-doodle-text">
          Reorder — {product.Name}
        </h3>
        <p className="font-doodle text-xs text-muted-foreground">
          Places purchase orders through the supply chain
        </p>

        {/* Stock summary */}
        <div className="doodle-card p-3 space-y-1">
          <div className="flex justify-between font-doodle text-xs">
            <span className="text-muted-foreground">Current stock</span>
            <span className="font-bold">{currentStock.toLocaleString()}</span>
          </div>
          {pendingQty > 0 && (
            <div className="flex justify-between font-doodle text-xs">
              <span className="text-muted-foreground">
                On order ({pending!.orders.length} PO
                {pending!.orders.length !== 1 ? "s" : ""})
              </span>
              <span className="font-bold text-doodle-blue">
                +{pendingQty.toLocaleString()}
              </span>
            </div>
          )}
          <div className="flex justify-between font-doodle text-xs">
            <span className="text-muted-foreground">Safety stock target</span>
            <span className="font-bold">
              {product.SafetyStockLevel.toLocaleString()}
            </span>
          </div>
          {deficit > 0 ? (
            <div className="flex justify-between font-doodle text-xs">
              <span className="text-doodle-accent font-bold">
                Remaining deficit
              </span>
              <span className="text-doodle-accent font-bold">
                {deficit.toLocaleString()}
              </span>
            </div>
          ) : (
            <div className="flex justify-between font-doodle text-xs">
              <span className="text-doodle-blue font-bold">
                Stock + orders meets target
              </span>
              <span className="text-doodle-blue font-bold">✓</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {catalogLoading ? (
            <p className="font-doodle text-xs text-muted-foreground">
              Loading vendors…
            </p>
          ) : !catalog || catalog.length === 0 ? (
            <p className="font-doodle text-xs text-doodle-accent">
              No vendors found for this product
            </p>
          ) : (
            <>
              {/* Order plan - show how it will be split */}
              <div className="doodle-card p-3 space-y-2">
                <div className="flex justify-between font-doodle text-xs">
                  <span className="text-muted-foreground">
                    Total vendor supply
                  </span>
                  <span className="font-bold">
                    {totalAvailable.toLocaleString()} available
                  </span>
                </div>
                {needsMultiVendor && (
                  <p className="font-doodle text-xs text-doodle-blue font-bold">
                    ⚡ Will split across {orderPlan.length} vendors (no single
                    vendor has enough)
                  </p>
                )}
                {orderPlan.map((p, i) => (
                  <div
                    key={p.vendor.vendorId}
                    className="flex justify-between font-doodle text-xs"
                  >
                    <span className="text-muted-foreground">
                      {orderPlan.length > 1 ? `${i + 1}. ` : ""}
                      {p.vendor.vendorName}
                      <span className="ml-1 opacity-60">
                        (stock: {p.vendor.stockAvailable.toLocaleString()}
                        {p.vendor.minOrderQty > 1
                          ? `, min: ${p.vendor.minOrderQty}`
                          : ""}
                        )
                      </span>
                    </span>
                    <span className="font-bold">
                      {p.qty.toLocaleString()} × ${p.vendor.unitCost.toFixed(2)}
                      {p.belowMin && (
                        <span className="text-doodle-blue ml-1">
                          (min order)
                        </span>
                      )}
                    </span>
                  </div>
                ))}
                {orderPlan.length > 0 && (
                  <div className="flex justify-between font-doodle text-xs border-t border-doodle-text/10 pt-1">
                    <span className="font-bold">Est. total</span>
                    <span className="font-bold">
                      $
                      {orderPlan
                        .reduce(
                          (s, p) =>
                            s +
                            p.qty * p.vendor.unitCost +
                            (p.vendor.shippingCost || 0),
                          0,
                        )
                        .toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            </>
          )}

          <div>
            <label className="font-doodle text-xs text-muted-foreground block mb-1">
              Quantity to order
            </label>
            <input
              type="number"
              min={1}
              value={reorderQty}
              onChange={(e) => setReorderQty(Number(e.target.value))}
              className="w-full doodle-button text-sm font-bold text-center"
            />
            {exceedsSupply && (
              <p className="font-doodle text-xs text-doodle-accent mt-1 font-bold">
                ⚠ Exceeds total vendor supply ({totalAvailable.toLocaleString()}
                ). Max orderable: {totalAvailable.toLocaleString()}
              </p>
            )}
            {deficit > 0 && !exceedsSupply && (
              <p className="font-doodle text-xs text-muted-foreground mt-1">
                Suggested: {suggestedQty} (deficit after pending orders)
              </p>
            )}
            {deficit === 0 && pendingQty > 0 && (
              <p className="font-doodle text-xs text-doodle-blue mt-1">
                Existing orders already cover the safety stock target
              </p>
            )}
          </div>

          <div className="font-doodle text-xs text-muted-foreground">
            Reorder point: {product.ReorderPoint} · Safety stock:{" "}
            {product.SafetyStockLevel}
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="doodle-button text-sm">
            Cancel
          </button>
          <button
            onClick={() => orderMutation.mutate()}
            disabled={
              orderMutation.isPending ||
              !catalog ||
              catalog.length === 0 ||
              orderPlan.length === 0 ||
              totalAvailable === 0
            }
            className="doodle-button doodle-button-primary text-sm disabled:opacity-50"
          >
            {orderMutation.isPending
              ? "Placing orders…"
              : orderPlan.length === 0 || totalAvailable === 0
                ? "No vendor stock available"
                : `Order ${orderPlan.reduce((s, p) => s + p.qty, 0)} units${needsMultiVendor ? ` (${orderPlan.length} vendors)` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Schedule Manufacture Dialog ──
const ScheduleManufactureDialog = ({
  product,
  buildable,
  onClose,
}: {
  product: Product;
  buildable: number;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [qty, setQty] = useState(
    Math.min(buildable, Math.max(1, product.SafetyStockLevel)),
  );
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await beginManufacturingRun({
        productId: product.ProductID,
        orderQty: qty,
      });
      toast.success(`Production started — ${res.totalWorkOrders} work orders`, {
        description: `Run #${res.runId} for ${qty}× ${product.Name}`,
        duration: 8000,
      });
      qc.invalidateQueries({ queryKey: ["work-orders"] });
      qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
      onClose();
    } catch (e) {
      toast.error("Failed to start production", { description: String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="doodle-card-static p-6 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-doodle text-lg font-bold text-doodle-text flex items-center gap-2">
          <Factory className="w-5 h-5 text-doodle-blue" /> Manufacture —{" "}
          {product.Name}
        </h3>
        <p className="font-doodle text-xs text-muted-foreground">
          Schedule a production run on the shop floor
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="font-doodle text-xs text-muted-foreground block mb-1">
                Quantity to manufacture
              </label>
              <input
                type="number"
                min={1}
                max={buildable > 0 ? buildable : undefined}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                className="w-full doodle-button text-sm font-bold text-center"
              />
            </div>
            <div className="text-center">
              <p className="font-doodle text-xs text-muted-foreground">
                Buildable
              </p>
              <p className="font-doodle text-lg font-bold text-doodle-blue">
                {buildable}
              </p>
            </div>
          </div>

          {qty > buildable && buildable > 0 && (
            <p className="font-doodle text-xs text-doodle-accent flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Exceeds available components
              — shortages will occur
            </p>
          )}
          {buildable === 0 && (
            <p className="font-doodle text-xs text-doodle-accent flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> No components available —
              production will stall until restocked
            </p>
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="doodle-button text-sm">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || qty < 1}
            className="doodle-button doodle-button-primary text-sm"
          >
            {submitting ? "Starting…" : `Manufacture ${qty} units`}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Reorder Components Dialog ──
const ReorderComponentsDialog = ({
  product,
  bom,
  inventoryByProduct,
  pendingOrdersByProduct,
  productMap,
  onClose,
  onManufacture,
}: {
  product: Product;
  bom: BillOfMaterials[];
  inventoryByProduct: Map<number, number>;
  pendingOrdersByProduct: Map<number, { qty: number; orders: PurchaseOrder[] }>;
  productMap: Map<number, Product>;
  onClose: () => void;
  onManufacture: (p: Product) => void;
}) => {
  const qc = useQueryClient();
  const deficit = Math.max(
    0,
    product.SafetyStockLevel - (inventoryByProduct.get(product.ProductID) || 0),
  );
  const [targetQty, setTargetQty] = useState(
    deficit || product.ReorderPoint || 10,
  );

  // Calculate component shortfalls for the target build quantity
  const parts = useMemo(
    () => collectComponentIds(product.ProductID, bom),
    [product.ProductID, bom],
  );

  const shortfalls = useMemo(() => {
    const result: {
      compId: number;
      name: string;
      needed: number;
      have: number;
      pendingQty: number;
      shortfall: number;
    }[] = [];
    for (const [compId, qtyPer] of parts) {
      const needed = qtyPer * targetQty;
      const have = inventoryByProduct.get(compId) || 0;
      const pendingQty = pendingOrdersByProduct.get(compId)?.qty || 0;
      const shortfall = Math.max(0, needed - have - pendingQty);
      if (shortfall > 0) {
        result.push({
          compId,
          name: productMap.get(compId)?.Name || `#${compId}`,
          needed,
          have,
          pendingQty,
          shortfall,
        });
      }
    }
    return result;
  }, [parts, targetQty, inventoryByProduct, pendingOrdersByProduct]);

  // Fetch catalog for all short components
  const { data: catalogs } = useQuery({
    queryKey: ["supply-catalogs-bulk", shortfalls.map((s) => s.compId)],
    queryFn: async () => {
      const results = await Promise.all(
        shortfalls.map((s) => fetchCatalog(s.compId).catch(() => [])),
      );
      const map = new Map<number, Awaited<ReturnType<typeof fetchCatalog>>>();
      shortfalls.forEach((s, i) => map.set(s.compId, results[i]));
      return map;
    },
    enabled: shortfalls.length > 0,
  });

  const [ordering, setOrdering] = useState<Set<number>>(new Set());
  const [ordered, setOrdered] = useState<Set<number>>(new Set());
  const [manufacturing, setManufacturing] = useState<Set<number>>(new Set());
  const [manufactured, setManufactured] = useState<Set<number>>(new Set());

  const manufactureComponent = async (
    compId: number,
    qty: number,
    silent = false,
  ): Promise<{ ok: boolean; workOrders?: number }> => {
    if (qty < 1) return { ok: false };
    setManufacturing((s) => new Set(s).add(compId));
    try {
      const res = await beginManufacturingRun({
        productId: compId,
        orderQty: qty,
      });
      setManufactured((s) => new Set(s).add(compId));
      if (!silent) {
        toast.success(
          `Production started — ${res.totalWorkOrders} work orders`,
          {
            description: `Run #${res.runId} for ${qty}× ${productMap.get(compId)?.Name || `#${compId}`}`,
          },
        );
      }
      qc.invalidateQueries({ queryKey: ["work-orders"] });
      qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
      return { ok: true, workOrders: res.totalWorkOrders };
    } catch (e: unknown) {
      if (!silent)
        toast.error("Failed to start production", { description: String(e) });
      return { ok: false };
    } finally {
      setManufacturing((s) => {
        const n = new Set(s);
        n.delete(compId);
        return n;
      });
    }
  };

  const manufactureAllBuildable = async () => {
    const toBuild = shortfalls.filter(
      (s) => productMap.get(s.compId)?.MakeFlag && !manufactured.has(s.compId),
    );
    if (toBuild.length === 0) {
      toast.error("No buildable components to manufacture");
      return;
    }
    let runs = 0,
      totalWO = 0,
      failed = 0;
    for (const s of toBuild) {
      const result = await manufactureComponent(s.compId, s.shortfall, true);
      if (result.ok) {
        runs++;
        totalWO += result.workOrders || 0;
      } else {
        failed++;
      }
    }
    if (runs > 0 && failed === 0) {
      toast.success(
        `Started ${runs} production run${runs !== 1 ? "s" : ""} — ${totalWO} work orders created`,
        {
          description:
            "Sub-assembly shortages will cascade into nested work orders automatically",
        },
      );
    } else if (runs > 0) {
      toast.success(
        `Started ${runs} production runs — ${totalWO} work orders`,
        { description: `${failed} run(s) failed` },
      );
    } else {
      toast.error("Failed to start any production runs");
    }
  };

  const orderComponent = async (
    compId: number,
    qty: number,
    silent = false,
  ): Promise<{ ordered: number; requested: number }> => {
    const vendors = catalogs?.get(compId);
    if (!vendors || vendors.length === 0) {
      if (!silent) toast.error("No vendor available for this component");
      return { ordered: 0, requested: qty };
    }
    const totalAvail = vendors
      .filter((v) => v.stockAvailable > 0)
      .reduce((s, v) => s + v.stockAvailable, 0);
    if (totalAvail === 0) {
      if (!silent) toast.error("All vendors out of stock for this component");
      return { ordered: 0, requested: qty };
    }
    const actualQty = Math.min(qty, totalAvail);
    setOrdering((s) => new Set(s).add(compId));
    try {
      const orders = await placeMultiVendorOrders(vendors, compId, actualQty);
      setOrdered((s) => new Set(s).add(compId));
      if (!silent) {
        const partial =
          actualQty < qty ? ` (${qty - actualQty} unavailable)` : "";
        if (orders.length === 1) {
          toast.success(
            `Ordered ${actualQty} × component from ${orders[0].vendorName}${partial}`,
          );
        } else {
          toast.success(
            `Ordered ${actualQty} × component across ${orders.length} vendors${partial}`,
          );
        }
      }
      qc.invalidateQueries({ queryKey: ["supply-orders"] });
      qc.invalidateQueries({ queryKey: ["supply-catalogs-bulk"] });
      return { ordered: actualQty, requested: qty };
    } catch (e: unknown) {
      if (!silent)
        toast.error("Order failed", {
          description: e instanceof Error ? e.message : String(e),
        });
      return { ordered: 0, requested: qty };
    } finally {
      setOrdering((s) => {
        const n = new Set(s);
        n.delete(compId);
        return n;
      });
    }
  };

  const orderAll = async () => {
    const toOrder = shortfalls.filter((s) => !ordered.has(s.compId));
    let totalOrdered = 0,
      totalShort = 0,
      skipped = 0;
    for (const s of toOrder) {
      const vendors = catalogs?.get(s.compId);
      const totalAvail =
        vendors
          ?.filter((v) => v.stockAvailable > 0)
          .reduce((sum, v) => sum + v.stockAvailable, 0) || 0;
      if (totalAvail === 0) {
        skipped++;
        continue;
      }
      const actualQty = Math.min(s.shortfall, totalAvail);
      const result = await orderComponent(s.compId, actualQty, true);
      totalOrdered += result.ordered;
      if (result.ordered < s.shortfall)
        totalShort += s.shortfall - result.ordered;
    }
    if (totalOrdered > 0 && totalShort === 0 && skipped === 0) {
      toast.success(
        `All missing components ordered successfully (${totalOrdered} total units)`,
      );
    } else if (totalOrdered > 0) {
      toast.success(`Ordered ${totalOrdered} units across available vendors`, {
        description:
          totalShort > 0 || skipped > 0
            ? `${totalShort + (skipped > 0 ? skipped : 0)} components partially or fully unavailable`
            : undefined,
      });
    } else {
      toast.error("No vendor stock available for any components");
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="doodle-card-static p-6 max-w-lg w-full space-y-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-doodle text-lg font-bold text-doodle-text">
          Reorder Components — {product.Name}
        </h3>
        <p className="font-doodle text-xs text-muted-foreground">
          Order missing components to build enough units to reach safety stock (
          {product.SafetyStockLevel})
        </p>

        <div>
          <label className="font-doodle text-xs text-muted-foreground block mb-1">
            Units to build
          </label>
          <input
            type="number"
            min={1}
            value={targetQty}
            onChange={(e) => {
              setTargetQty(Number(e.target.value));
              setOrdered(new Set());
            }}
            className="w-full doodle-button text-sm font-bold text-center"
          />
          <p className="font-doodle text-xs text-muted-foreground mt-1">
            Current stock:{" "}
            {(inventoryByProduct.get(product.ProductID) || 0).toLocaleString()}{" "}
            · Safety: {product.SafetyStockLevel}
          </p>
        </div>

        {shortfalls.length === 0 ? (
          <div className="doodle-card p-4 text-center">
            <p className="font-doodle text-sm text-doodle-blue font-bold">
              ✓ All components available
            </p>
            <p className="font-doodle text-xs text-muted-foreground mt-1">
              You have enough stock (including pending orders) to build{" "}
              {targetQty} units
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {(() => {
              const anyOrderable = shortfalls.some((s) => {
                if (ordered.has(s.compId)) return false;
                if (productMap.get(s.compId)?.MakeFlag) return false;
                const vendors = catalogs?.get(s.compId);
                const totalAvail =
                  vendors
                    ?.filter((v) => v.stockAvailable > 0)
                    .reduce((sum, v) => sum + v.stockAvailable, 0) || 0;
                return totalAvail > 0;
              });
              const buildableShortfalls = shortfalls.filter(
                (s) =>
                  productMap.get(s.compId)?.MakeFlag &&
                  !manufactured.has(s.compId),
              );
              const anyBuildable = buildableShortfalls.length > 0;
              return (
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="font-doodle text-xs font-bold text-doodle-accent">
                    {shortfalls.length} component
                    {shortfalls.length !== 1 ? "s" : ""} short
                  </p>
                  <div className="flex items-center gap-2">
                    {anyBuildable && (
                      <button
                        onClick={manufactureAllBuildable}
                        disabled={manufacturing.size > 0}
                        title={`Start production runs for ${buildableShortfalls.length} buildable sub-assembl${buildableShortfalls.length !== 1 ? "ies" : "y"} — nested shortages cascade into child work orders automatically`}
                        className="doodle-button doodle-button-primary text-xs py-1 px-3 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {manufacturing.size > 0 ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Wrench className="w-3 h-3" />
                        )}
                        Manufacture All Buildable ({buildableShortfalls.length})
                      </button>
                    )}
                    <button
                      onClick={orderAll}
                      disabled={!anyOrderable || ordering.size > 0}
                      title={
                        !anyOrderable
                          ? "No purchasable components missing (buildable items must be manufactured)"
                          : undefined
                      }
                      className="doodle-button doodle-button-primary text-xs py-1 px-3 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ShoppingCart className="w-3 h-3" /> Order All Missing
                    </button>
                  </div>
                </div>
              );
            })()}

            {shortfalls.map((s) => {
              const compProduct = productMap.get(s.compId);
              const isBuildable = !!compProduct?.MakeFlag;
              const compBuildable = isBuildable
                ? calcBuildable(s.compId, bom, inventoryByProduct)
                : 0;
              const vendors = catalogs?.get(s.compId);
              const availableVendors =
                vendors
                  ?.filter((v) => v.stockAvailable > 0)
                  .sort((a, b) => a.unitCost - b.unitCost) || [];
              const totalVendorStock = availableVendors.reduce(
                (sum, v) => sum + v.stockAvailable,
                0,
              );
              const exceedsSupply = s.shortfall > totalVendorStock;
              const needsMulti =
                availableVendors.length > 0 &&
                availableVendors[0].stockAvailable < s.shortfall &&
                totalVendorStock >= s.shortfall;
              const isOrdered = ordered.has(s.compId);
              const isOrdering = ordering.has(s.compId);
              const isManufactured = manufactured.has(s.compId);
              const isManufacturing = manufacturing.has(s.compId);

              return (
                <div
                  key={s.compId}
                  className={`doodle-card p-3 space-y-1 ${isOrdered || isManufactured ? "opacity-60" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-doodle text-xs font-bold text-doodle-text">
                      {s.name}
                      {isBuildable && (
                        <span className="ml-2 font-doodle text-[10px] text-doodle-blue font-bold">
                          BUILT
                        </span>
                      )}
                    </span>
                    {isBuildable ? (
                      isManufactured ? (
                        <span className="font-doodle text-xs text-doodle-blue flex items-center gap-1">
                          <Check className="w-3 h-3" /> Production started
                        </span>
                      ) : (
                        <button
                          onClick={() =>
                            manufactureComponent(s.compId, s.shortfall)
                          }
                          disabled={isManufacturing}
                          title="Start a production run for this sub-assembly — missing sub-components will cascade into child work orders"
                          className="doodle-button doodle-button-primary text-xs py-0.5 px-2 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isManufacturing ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Wrench className="w-3 h-3" />
                          )}
                          Manufacture {s.shortfall}
                        </button>
                      )
                    ) : isOrdered ? (
                      <span className="font-doodle text-xs text-doodle-blue flex items-center gap-1">
                        <Check className="w-3 h-3" /> Ordered
                      </span>
                    ) : (
                      <button
                        onClick={() =>
                          orderComponent(
                            s.compId,
                            exceedsSupply ? totalVendorStock : s.shortfall,
                          )
                        }
                        disabled={isOrdering || availableVendors.length === 0}
                        className="doodle-button doodle-button-primary text-xs py-0.5 px-2 flex items-center gap-1 disabled:opacity-50"
                      >
                        {isOrdering ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <ShoppingCart className="w-3 h-3" />
                        )}
                        Order {exceedsSupply ? totalVendorStock : s.shortfall}
                        {needsMulti && ` (${availableVendors.length} vendors)`}
                      </button>
                    )}
                  </div>
                  <div className="flex gap-4 font-doodle text-xs text-muted-foreground flex-wrap">
                    <span>Need: {s.needed}</span>
                    <span>Have: {s.have}</span>
                    {s.pendingQty > 0 && (
                      <span className="text-doodle-blue">
                        +{s.pendingQty} on order
                      </span>
                    )}
                    <span className="text-doodle-accent font-bold">
                      Short: {s.shortfall}
                    </span>
                    {isBuildable ? (
                      <span
                        className={compBuildable > 0 ? "text-doodle-blue" : ""}
                      >
                        Buildable now: {compBuildable.toLocaleString()}
                      </span>
                    ) : (
                      <span>
                        Vendor supply: {totalVendorStock.toLocaleString()}
                      </span>
                    )}
                  </div>
                  {isBuildable && !isManufactured && compBuildable === 0 && (
                    <p className="font-doodle text-xs text-doodle-blue">
                      Sub-components also short — nested work orders will be
                      created automatically
                    </p>
                  )}
                  {isBuildable &&
                    !isManufactured &&
                    compBuildable > 0 &&
                    compBuildable < s.shortfall && (
                      <p className="font-doodle text-xs text-doodle-blue">
                        Can build {compBuildable} of {s.shortfall} immediately;
                        remaining cascades to child work orders
                      </p>
                    )}
                  {!isBuildable && exceedsSupply && (
                    <p className="font-doodle text-xs text-doodle-accent font-bold">
                      ⚠ Only {totalVendorStock} available across all vendors
                      (need {s.shortfall})
                    </p>
                  )}
                  {!isBuildable && needsMulti && (
                    <p className="font-doodle text-xs text-doodle-blue">
                      Will split across {availableVendors.length} vendors
                    </p>
                  )}
                  {!isBuildable &&
                    availableVendors.length > 0 &&
                    !needsMulti && (
                      <p className="font-doodle text-xs text-muted-foreground">
                        Best: {availableVendors[0].vendorName} · $
                        {availableVendors[0].unitCost.toFixed(2)}/ea ·{" "}
                        {availableVendors[0].leadTimeDays}d lead
                      </p>
                    )}
                  {!isBuildable &&
                    availableVendors.length === 0 &&
                    vendors &&
                    vendors.length === 0 && (
                      <p className="font-doodle text-xs text-doodle-accent">
                        No vendors available
                      </p>
                    )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="doodle-button text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

const ReceiveInventory = () => {
  const [mode, setMode] = useState<"location" | "product" | "orders">(
    "location",
  );
  // Location drill-down
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(
    null,
  );
  const [selectedShelf, setSelectedShelf] = useState<string | null>(null);
  // Product drill-down: category → subcategory → product → parts → part detail
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(
    null,
  );
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<
    number | null
  >(null);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(
    null,
  );
  const [selectedPartId, setSelectedPartId] = useState<number | null>(null);
  const [reorderProduct, setReorderProduct] = useState<Product | null>(null);
  const [manufactureProduct, setManufactureProduct] = useState<Product | null>(
    null,
  );
  const [reorderComponentsProduct, setReorderComponentsProduct] =
    useState<Product | null>(null);
  const [expandedShortages, setExpandedShortages] = useState<Set<number>>(
    new Set(),
  );
  const [partSort, setPartSort] = useState<{
    col: "name" | "stock" | "demand" | "status";
    dir: "asc" | "desc";
  }>({ col: "name", dir: "asc" });

  // Location mode filters
  const [locSearch, setLocSearch] = useState("");
  const [locShelfSearch, setLocShelfSearch] = useState("");
  const [locProductSearch, setLocProductSearch] = useState("");
  const [locHideZero, setLocHideZero] = useState(true);
  const [locProductPage, setLocProductPage] = useState(0);

  // Product mode filters
  const [fgSearch, setFgSearch] = useState("");
  const [fgShowLowOnly, setFgShowLowOnly] = useState(false);
  const [fgPage, setFgPage] = useState(0);
  const [partSearch, setPartSearch] = useState("");
  const [partPage, setPartPage] = useState(0);
  const ITEMS_PER_PAGE = 20;

  const { data: inventory, isLoading } = useQuery({
    queryKey: ["product-inventory"],
    queryFn: () => fetchProductInventory(),
    refetchInterval: 15000,
  });
  const { data: locations } = useQuery({
    queryKey: ["locations"],
    queryFn: fetchLocations,
  });
  const { data: allProducts } = useQuery({
    queryKey: ["all-products"],
    queryFn: () => fetchAllProducts(),
  });
  const { data: bom } = useQuery({
    queryKey: ["active-bom"],
    queryFn: fetchActiveBOM,
  });
  const { data: mfgStatus } = useQuery({
    queryKey: ["manufacturing-status"],
    queryFn: fetchManufacturingStatus,
    refetchInterval: 10000,
  });
  const { data: workOrders } = useQuery({
    queryKey: ["work-orders"],
    queryFn: fetchWorkOrders,
    refetchInterval: 15000,
  });
  const { data: categories } = useQuery({
    queryKey: ["product-categories"],
    queryFn: fetchProductCategories,
  });
  const { data: subcategories } = useQuery({
    queryKey: ["product-subcategories"],
    queryFn: fetchProductSubcategories,
  });
  const { data: supplyOrders } = useQuery({
    queryKey: ["supply-orders"],
    queryFn: fetchOrders,
    refetchInterval: 15000,
  });
  const { data: poHeaders } = useQuery({
    queryKey: ["po-headers-all"],
    queryFn: () => fetchPurchaseOrderHeaders(),
    refetchInterval: 30000,
  });
  const { data: vendors } = useQuery({
    queryKey: ["vendors"],
    queryFn: fetchVendors,
  });
  const [expandedPO, setExpandedPO] = useState<number | null>(null);
  const [poStatusFilter, setPoStatusFilter] = useState<Set<number>>(
    new Set([1, 2, 3]),
  ); // hide Complete (4) by default
  const [poSearch, setPoSearch] = useState("");
  const [poPage, setPoPage] = useState(0);
  const PO_PAGE_SIZE = 25;

  // Pending supply chain orders by productId
  const pendingOrdersByProduct = useMemo(() => {
    const map = new Map<number, { qty: number; orders: PurchaseOrder[] }>();
    if (!supplyOrders) return map;
    const activeStatuses = new Set(["pending", "approved"]);
    for (const o of supplyOrders) {
      if (activeStatuses.has(o.status)) {
        const existing = map.get(o.productId) || { qty: 0, orders: [] };
        existing.qty += o.qty;
        existing.orders.push(o);
        map.set(o.productId, existing);
      }
    }
    return map;
  }, [supplyOrders]);

  const productMap = useMemo(() => {
    const map = new Map<number, Product>();
    allProducts?.forEach((p) => map.set(p.ProductID, p));
    return map;
  }, [allProducts]);

  const vendorMap = useMemo(() => {
    const map = new Map<number, Vendor>();
    vendors?.forEach((v) => map.set(v.BusinessEntityID, v));
    return map;
  }, [vendors]);

  const locationMap = useMemo(() => {
    const map = new Map<number, Location>();
    locations?.forEach((l) => map.set(l.LocationID, l));
    return map;
  }, [locations]);

  // PO detail query for expanded row
  const { data: expandedPODetails } = useQuery({
    queryKey: ["po-details", expandedPO],
    queryFn: () =>
      import("@/services/api").then((m) =>
        m.fetchPurchaseOrderDetails(expandedPO!),
      ),
    enabled: expandedPO != null,
  });

  const items = inventory || [];

  // Inventory totals per product
  const inventoryByProduct = useMemo(() => {
    const map = new Map<number, number>();
    items.forEach((i) =>
      map.set(i.ProductID, (map.get(i.ProductID) || 0) + i.Quantity),
    );
    return map;
  }, [items]);

  // ── Location drill-down data ──
  const locationSummaries = useMemo(() => {
    const map = new Map<number, { qty: number; products: number }>();
    items.forEach((i) => {
      const cur = map.get(i.LocationID) || { qty: 0, products: 0 };
      cur.qty += i.Quantity;
      cur.products += 1;
      map.set(i.LocationID, cur);
    });
    return Array.from(map.entries())
      .map(([id, d]) => ({
        id,
        name: locationMap.get(id)?.Name || `Location #${id}`,
        ...d,
      }))
      .sort((a, b) => b.qty - a.qty);
  }, [items, locationMap]);

  const shelvesAtLocation = useMemo(() => {
    if (!selectedLocationId) return [];
    const shelves = new Map<string, { qty: number; count: number }>();
    items
      .filter((i) => i.LocationID === selectedLocationId)
      .forEach((i) => {
        const cur = shelves.get(i.Shelf) || { qty: 0, count: 0 };
        cur.qty += i.Quantity;
        cur.count += 1;
        shelves.set(i.Shelf, cur);
      });
    return Array.from(shelves.entries())
      .map(([shelf, d]) => ({ shelf, ...d }))
      .sort((a, b) => a.shelf.localeCompare(b.shelf));
  }, [items, selectedLocationId]);

  const productsOnShelf = useMemo(() => {
    if (!selectedLocationId || !selectedShelf) return [];
    return items
      .filter(
        (i) => i.LocationID === selectedLocationId && i.Shelf === selectedShelf,
      )
      .sort((a, b) => a.Bin - b.Bin);
  }, [items, selectedLocationId, selectedShelf]);

  // ── Product mode: Category/Subcategory grouping ──
  const finishedGoods = useMemo(() => {
    return (allProducts || [])
      .filter((p) => p.FinishedGoodsFlag && p.MakeFlag)
      .sort((a, b) => a.Name.localeCompare(b.Name));
  }, [allProducts]);

  // Categories that have finished goods
  const categoriesWithFG = useMemo(() => {
    if (!categories || !subcategories) return [];
    const subcatToCategory = new Map<number, number>();
    subcategories.forEach((sc) =>
      subcatToCategory.set(sc.ProductSubcategoryID, sc.ProductCategoryID),
    );

    const catCounts = new Map<number, number>();
    finishedGoods.forEach((fg) => {
      if (fg.ProductSubcategoryID != null) {
        const catId = subcatToCategory.get(fg.ProductSubcategoryID);
        if (catId != null)
          catCounts.set(catId, (catCounts.get(catId) || 0) + 1);
      }
    });

    return categories
      .filter((c) => catCounts.has(c.ProductCategoryID))
      .map((c) => ({ ...c, fgCount: catCounts.get(c.ProductCategoryID) || 0 }))
      .sort((a, b) => a.Name.localeCompare(b.Name));
  }, [categories, subcategories, finishedGoods]);

  // Subcategories within selected category that have FGs
  const subcatsInCategory = useMemo(() => {
    if (!selectedCategoryId || !subcategories) return [];
    const relevant = subcategories.filter(
      (sc) => sc.ProductCategoryID === selectedCategoryId,
    );
    return relevant
      .map((sc) => {
        const fgs = finishedGoods.filter(
          (fg) => fg.ProductSubcategoryID === sc.ProductSubcategoryID,
        );
        return { ...sc, fgCount: fgs.length };
      })
      .filter((sc) => sc.fgCount > 0)
      .sort((a, b) => a.Name.localeCompare(b.Name));
  }, [selectedCategoryId, subcategories, finishedGoods]);

  // FGs in selected subcategory with buildable count
  const fgsInSubcategory = useMemo(() => {
    if (!selectedSubcategoryId || !bom) return [];
    return finishedGoods
      .filter((fg) => fg.ProductSubcategoryID === selectedSubcategoryId)
      .map((fg) => {
        const stock = inventoryByProduct.get(fg.ProductID) || 0;
        const buildable = calcBuildable(fg.ProductID, bom, inventoryByProduct);
        const isLow = stock < fg.SafetyStockLevel;
        return { ...fg, stock, buildable, isLow };
      });
  }, [selectedSubcategoryId, finishedGoods, bom, inventoryByProduct]);

  // BOM parts for selected product
  const bomParts = useMemo(() => {
    if (!selectedProductId || !bom) return [];
    const parts = collectComponentIds(selectedProductId, bom);
    return Array.from(parts.entries())
      .map(([compId, qtyPer]) => {
        const prod = productMap.get(compId);
        const invItems = items.filter((i) => i.ProductID === compId);
        const totalQty = invItems.reduce((s, i) => s + i.Quantity, 0);
        return {
          compId,
          name: prod?.Name || `#${compId}`,
          qtyPer,
          totalQty,
          product: prod,
          invItems,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedProductId, bom, productMap, items]);

  // ── Active consumption tracking ──
  const consumedComponents = useMemo(() => {
    if (!workOrders || !bom) return new Map<number, number>();
    const activeWos = workOrders.filter((wo) => wo.EndDate == null);
    const consumption = new Map<number, number>();
    for (const wo of activeWos) {
      const parts = collectComponentIds(wo.ProductID, bom);
      parts.forEach((qtyPer, compId) => {
        consumption.set(
          compId,
          (consumption.get(compId) || 0) + qtyPer * wo.OrderQty,
        );
      });
    }
    return consumption;
  }, [workOrders, bom]);

  const shortageProducts = useMemo(() => {
    // API returns one shortage row per work order — dedupe by productId, summing needs.
    type Merged = (typeof mfgStatus.shortages)[number] & {
      sources: { workOrderId: number; needed: number }[];
    };
    const grouped = new Map<number, Merged>();
    for (const s of mfgStatus?.shortages || []) {
      const existing = grouped.get(s.productId);
      if (existing) {
        existing.needed += s.needed;
        existing.shortfall = Math.max(0, existing.needed - existing.available);
        existing.sources.push({ workOrderId: s.workOrderId, needed: s.needed });
      } else {
        grouped.set(s.productId, {
          ...s,
          sources: [{ workOrderId: s.workOrderId, needed: s.needed }],
        });
      }
    }
    return Array.from(grouped.values())
      .sort((a, b) => b.shortfall - a.shortfall)
      .map((s) => ({
        ...s,
        sources: [...s.sources].sort((a, b) => b.needed - a.needed),
        product: productMap.get(s.productId),
      }));
  }, [mfgStatus, productMap]);

  // ── navigation helpers ──
  const goBackLocation = useCallback(() => {
    if (selectedShelf) setSelectedShelf(null);
    else if (selectedLocationId) {
      setSelectedLocationId(null);
      setSelectedShelf(null);
    }
  }, [selectedShelf, selectedLocationId]);

  const goBackProduct = useCallback(() => {
    if (selectedPartId) setSelectedPartId(null);
    else if (selectedProductId) {
      setSelectedProductId(null);
      setSelectedPartId(null);
    } else if (selectedSubcategoryId) {
      setSelectedSubcategoryId(null);
      setSelectedProductId(null);
    } else if (selectedCategoryId) {
      setSelectedCategoryId(null);
      setSelectedSubcategoryId(null);
    }
  }, [
    selectedPartId,
    selectedProductId,
    selectedSubcategoryId,
    selectedCategoryId,
  ]);

  const selectedPartInventory = useMemo(() => {
    if (!selectedPartId) return [];
    return items.filter((i) => i.ProductID === selectedPartId);
  }, [items, selectedPartId]);

  // Breadcrumb label helpers
  const catName = categories?.find(
    (c) => c.ProductCategoryID === selectedCategoryId,
  )?.Name;
  const subcatName = subcategories?.find(
    (sc) => sc.ProductSubcategoryID === selectedSubcategoryId,
  )?.Name;
  const productName = productMap.get(selectedProductId || 0)?.Name;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">
            5. Receive — Inventory
          </h1>
          <p className="font-doodle text-sm text-muted-foreground">
            Browse inventory and track component consumption
          </p>
        </div>
        <Link
          to="/receive/costing"
          className="doodle-button doodle-button-accent text-sm"
        >
          Cost Analysis →
        </Link>
      </div>

      {/* Shortages Banner */}
      {shortageProducts.length > 0 && (
        <div className="doodle-card-static p-4 border-l-4 border-doodle-accent">
          <h3 className="font-doodle text-sm font-bold text-doodle-accent flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Material Shortages — Reorder
            Needed
          </h3>
          <div className="mt-2 space-y-1">
            {shortageProducts.map((s) => {
              const pending = pendingOrdersByProduct.get(s.productId);
              const pendingQty = pending?.qty || 0;
              const adjustedShortfall = Math.max(0, s.shortfall - pendingQty);
              const isExpanded = expandedShortages.has(s.productId);
              const hasMultiple = s.sources.length > 1;
              return (
                <div key={s.productId} className="font-doodle text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (!hasMultiple) return;
                        setExpandedShortages((prev) => {
                          const next = new Set(prev);
                          if (next.has(s.productId)) {
                            next.delete(s.productId);
                          } else {
                            next.add(s.productId);
                          }
                          return next;
                        });
                      }}
                      className={`flex items-start gap-1 flex-1 text-left ${hasMultiple ? "hover:underline cursor-pointer" : "cursor-default"}`}
                    >
                      {hasMultiple ? (
                        isExpanded ? (
                          <ChevronDown className="w-3 h-3 mt-0.5 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3 h-3 mt-0.5 shrink-0" />
                        )
                      ) : (
                        <span className="w-3 h-3 shrink-0" />
                      )}
                      <span className="text-doodle-text flex-1">
                        {s.productName} — need {s.needed}, have {s.available}
                        {hasMultiple && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {s.sources.length} work orders
                          </span>
                        )}
                        {pendingQty > 0 ? (
                          <span className="text-green-600">
                            {" "}
                            (+{pendingQty} on order)
                          </span>
                        ) : null}
                        {adjustedShortfall > 0 ? (
                          <span className="text-doodle-accent">
                            {" "}
                            · short {adjustedShortfall}
                          </span>
                        ) : (
                          <span className="text-green-600">
                            {" "}
                            · covered by orders
                          </span>
                        )}
                      </span>
                    </button>
                    {adjustedShortfall > 0 ? (
                      <button
                        onClick={() =>
                          s.product && setReorderProduct(s.product)
                        }
                        className="doodle-button doodle-button-primary text-xs py-1 px-2 shrink-0"
                      >
                        <Plus className="w-3 h-3 inline mr-1" />
                        Reorder
                      </button>
                    ) : (
                      <span className="font-doodle text-xs text-green-600 shrink-0">
                        ✓ Ordered
                      </span>
                    )}
                  </div>
                  {isExpanded && hasMultiple && (
                    <div className="ml-4 mt-1 mb-2 pl-3 border-l-2 border-dashed border-doodle-text/20 space-y-0.5">
                      {s.sources.map((src) => (
                        <div
                          key={src.workOrderId}
                          className="flex justify-between gap-3 text-muted-foreground"
                        >
                          <Link
                            to={`/plan/work-orders/${src.workOrderId}`}
                            className="hover:text-doodle-blue hover:underline"
                          >
                            WO #{src.workOrderId}
                          </Link>
                          <span>need {src.needed.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Mode tabs */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => {
            setMode("location");
            setSelectedCategoryId(null);
            setSelectedSubcategoryId(null);
            setSelectedProductId(null);
            setSelectedPartId(null);
          }}
          className={`doodle-button text-sm flex items-center gap-2 ${mode === "location" ? "doodle-button-primary" : ""}`}
        >
          <MapPin className="w-4 h-4" /> By Location
        </button>
        <button
          onClick={() => {
            setMode("product");
            setSelectedLocationId(null);
            setSelectedShelf(null);
          }}
          className={`doodle-button text-sm flex items-center gap-2 ${mode === "product" ? "doodle-button-primary" : ""}`}
        >
          <Package className="w-4 h-4" /> By Product
        </button>
        <button
          onClick={() => {
            setMode("orders");
            setSelectedLocationId(null);
            setSelectedShelf(null);
            setSelectedCategoryId(null);
            setSelectedSubcategoryId(null);
            setSelectedProductId(null);
            setSelectedPartId(null);
          }}
          className={`doodle-button text-sm flex items-center gap-2 ${mode === "orders" ? "doodle-button-primary" : ""}`}
        >
          <FileText className="w-4 h-4" /> Purchase Orders
          {poHeaders && poHeaders.filter((po) => po.Status < 4).length > 0 && (
            <Badge variant="secondary" className="ml-1 text-xs">
              {poHeaders.filter((po) => po.Status < 4).length}
            </Badge>
          )}
        </button>
      </div>

      {isLoading ? (
        <TableSkeleton rows={8} cols={4} />
      ) : (
        <>
          {/* ═══ LOCATION MODE ═══ */}
          {mode === "location" && (
            <div className="space-y-4">
              {selectedLocationId && (
                <button
                  onClick={goBackLocation}
                  className="font-doodle text-sm text-doodle-blue hover:underline flex items-center gap-1"
                >
                  <ArrowLeft className="w-4 h-4" />
                  {selectedShelf
                    ? `${locationMap.get(selectedLocationId)?.Name} → Shelves`
                    : "All Locations"}
                </button>
              )}

              {/* Level 1: Location cards */}
              {!selectedLocationId &&
                (() => {
                  const filteredLocs = locationSummaries.filter(
                    (loc) =>
                      !locSearch ||
                      loc.name.toLowerCase().includes(locSearch.toLowerCase()),
                  );
                  return (
                    <>
                      <div className="relative max-w-xs">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <input
                          type="text"
                          placeholder="Search locations…"
                          value={locSearch}
                          onChange={(e) => setLocSearch(e.target.value)}
                          className="w-full pl-9 pr-3 py-2 doodle-button text-sm text-left"
                        />
                      </div>
                      <p className="font-doodle text-xs text-muted-foreground">
                        {filteredLocs.length} locations
                      </p>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {filteredLocs.map((loc) => (
                          <button
                            key={loc.id}
                            onClick={() => {
                              setSelectedLocationId(loc.id);
                              setLocSearch("");
                            }}
                            className="doodle-card p-4 text-left hover:border-doodle-blue transition-colors group"
                          >
                            <div className="flex items-center justify-between">
                              <p className="font-doodle text-sm font-bold text-doodle-text group-hover:text-doodle-blue">
                                {loc.name}
                              </p>
                              <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-doodle-blue" />
                            </div>
                            <p className="font-doodle text-2xl font-bold text-doodle-text mt-1">
                              {loc.qty.toLocaleString()}
                              <span className="text-sm font-normal text-muted-foreground ml-1">
                                total qty
                              </span>
                            </p>
                            <p className="font-doodle text-xs text-muted-foreground">
                              {loc.products} products
                            </p>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}

              {/* Level 2: Shelves */}
              {selectedLocationId &&
                !selectedShelf &&
                (() => {
                  const filteredShelves = shelvesAtLocation.filter(
                    (s) =>
                      !locShelfSearch ||
                      s.shelf
                        .toLowerCase()
                        .includes(locShelfSearch.toLowerCase()),
                  );
                  return (
                    <>
                      <h2 className="font-doodle text-lg font-bold text-doodle-text">
                        {locationMap.get(selectedLocationId)?.Name} — Shelves
                      </h2>
                      {shelvesAtLocation.length > 8 && (
                        <div className="relative max-w-xs">
                          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                          <input
                            type="text"
                            placeholder="Search shelves…"
                            value={locShelfSearch}
                            onChange={(e) => setLocShelfSearch(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 doodle-button text-sm text-left"
                          />
                        </div>
                      )}
                      <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-8 gap-3">
                        {filteredShelves.map((s) => (
                          <button
                            key={s.shelf}
                            onClick={() => {
                              setSelectedShelf(s.shelf);
                              setLocShelfSearch("");
                            }}
                            className="doodle-card p-3 text-center hover:border-doodle-blue transition-colors group"
                          >
                            <p className="font-doodle text-xl font-bold text-doodle-text group-hover:text-doodle-blue">
                              {s.shelf}
                            </p>
                            <p className="font-doodle text-xs text-muted-foreground">
                              {s.count} products · {s.qty.toLocaleString()}{" "}
                              total qty
                            </p>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}

              {/* Level 3: Products on shelf */}
              {selectedLocationId &&
                selectedShelf &&
                (() => {
                  const searchLower = locProductSearch.toLowerCase();
                  const filtered = productsOnShelf.filter((inv) => {
                    if (locHideZero && inv.Quantity === 0) return false;
                    if (locProductSearch) {
                      const prod = productMap.get(inv.ProductID);
                      return (
                        prod?.Name?.toLowerCase().includes(searchLower) ||
                        String(inv.ProductID).includes(searchLower)
                      );
                    }
                    return true;
                  });
                  const totalPages = Math.ceil(
                    filtered.length / ITEMS_PER_PAGE,
                  );
                  const paginated = filtered.slice(
                    locProductPage * ITEMS_PER_PAGE,
                    (locProductPage + 1) * ITEMS_PER_PAGE,
                  );

                  return (
                    <>
                      <h2 className="font-doodle text-lg font-bold text-doodle-text">
                        {locationMap.get(selectedLocationId)?.Name} → Shelf{" "}
                        {selectedShelf}
                      </h2>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="relative flex-1 min-w-[200px] max-w-xs">
                          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                          <input
                            type="text"
                            placeholder="Search products…"
                            value={locProductSearch}
                            onChange={(e) => {
                              setLocProductSearch(e.target.value);
                              setLocProductPage(0);
                            }}
                            className="w-full pl-9 pr-3 py-2 doodle-button text-sm text-left"
                          />
                        </div>
                        <button
                          onClick={() => {
                            setLocHideZero(!locHideZero);
                            setLocProductPage(0);
                          }}
                          className={`doodle-button text-xs py-1.5 px-3 flex items-center gap-1 ${locHideZero ? "doodle-button-primary" : ""}`}
                        >
                          <Filter className="w-3 h-3" />{" "}
                          {locHideZero ? "Hiding zero-qty" : "Show all"}
                        </button>
                      </div>
                      <p className="font-doodle text-xs text-muted-foreground">
                        Showing {paginated.length} of {filtered.length} products
                        {filtered.length < productsOnShelf.length &&
                          ` (${productsOnShelf.length} total)`}
                      </p>
                      <div className="doodle-card-static overflow-x-auto">
                        <table className="w-full font-doodle text-sm">
                          <thead>
                            <tr className="border-b-2 border-doodle-text/20">
                              <th className="text-left py-3 px-4">Bin</th>
                              <th className="text-left py-3 px-4">Product</th>
                              <th className="text-right py-3 px-4">Quantity</th>
                              <th className="text-right py-3 px-4">
                                Active Demand
                              </th>
                              <th className="text-right py-3 px-4"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {paginated.map((inv, idx) => {
                              const prod = productMap.get(inv.ProductID);
                              const demand =
                                consumedComponents.get(inv.ProductID) || 0;
                              return (
                                <tr
                                  key={idx}
                                  className="border-b border-doodle-text/10 hover:bg-secondary/30"
                                >
                                  <td className="py-3 px-4 font-bold">
                                    {inv.Bin}
                                  </td>
                                  <td className="py-3 px-4">
                                    <Link
                                      to={`/receive/inventory/${inv.ProductID}`}
                                      className="text-doodle-blue hover:underline font-bold"
                                    >
                                      {prod?.Name || `#${inv.ProductID}`}
                                    </Link>
                                  </td>
                                  <td className="text-right py-3 px-4 font-bold">
                                    {inv.Quantity.toLocaleString()}
                                  </td>
                                  <td className="text-right py-3 px-4">
                                    {demand > 0 && (
                                      <span className="text-doodle-accent font-bold flex items-center justify-end gap-1">
                                        <Activity className="w-3 h-3" />{" "}
                                        {demand.toLocaleString()}
                                      </span>
                                    )}
                                  </td>
                                  <td className="text-right py-3 px-4">
                                    {prod && !prod.MakeFlag && (
                                      <button
                                        onClick={() => setReorderProduct(prod)}
                                        className="doodle-button text-xs py-1 px-2"
                                      >
                                        <RefreshCw className="w-3 h-3 inline mr-1" />
                                        Reorder
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 font-doodle text-sm">
                          <button
                            onClick={() =>
                              setLocProductPage((p) => Math.max(0, p - 1))
                            }
                            disabled={locProductPage === 0}
                            className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                          >
                            ← Prev
                          </button>
                          <span className="text-muted-foreground">
                            Page {locProductPage + 1} of {totalPages}
                          </span>
                          <button
                            onClick={() =>
                              setLocProductPage((p) =>
                                Math.min(totalPages - 1, p + 1),
                              )
                            }
                            disabled={locProductPage >= totalPages - 1}
                            className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                          >
                            Next →
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}
            </div>
          )}

          {/* ═══ PRODUCT MODE ═══ */}
          {mode === "product" && (
            <div className="space-y-4">
              {/* Breadcrumb */}
              {selectedCategoryId && (
                <div className="flex items-center gap-1 text-sm font-doodle text-muted-foreground flex-wrap">
                  <button
                    onClick={() => {
                      setSelectedCategoryId(null);
                      setSelectedSubcategoryId(null);
                      setSelectedProductId(null);
                      setSelectedPartId(null);
                    }}
                    className="hover:text-doodle-blue"
                  >
                    Categories
                  </button>
                  {catName && (
                    <>
                      <ChevronRight className="w-3 h-3" />
                      <button
                        onClick={() => {
                          setSelectedSubcategoryId(null);
                          setSelectedProductId(null);
                          setSelectedPartId(null);
                        }}
                        className={`hover:text-doodle-blue ${!selectedSubcategoryId ? "text-doodle-text font-bold" : ""}`}
                      >
                        {catName}
                      </button>
                    </>
                  )}
                  {subcatName && (
                    <>
                      <ChevronRight className="w-3 h-3" />
                      <button
                        onClick={() => {
                          setSelectedProductId(null);
                          setSelectedPartId(null);
                        }}
                        className={`hover:text-doodle-blue ${!selectedProductId ? "text-doodle-text font-bold" : ""}`}
                      >
                        {subcatName}
                      </button>
                    </>
                  )}
                  {productName && (
                    <>
                      <ChevronRight className="w-3 h-3" />
                      <button
                        onClick={() => setSelectedPartId(null)}
                        className={`hover:text-doodle-blue ${!selectedPartId ? "text-doodle-text font-bold" : ""}`}
                      >
                        {productName}
                      </button>
                    </>
                  )}
                  {selectedPartId && (
                    <>
                      <ChevronRight className="w-3 h-3" />
                      <span className="text-doodle-text font-bold">
                        {productMap.get(selectedPartId)?.Name}
                      </span>
                    </>
                  )}
                </div>
              )}

              {/* Level 1: Categories */}
              {!selectedCategoryId && (
                <>
                  <h2 className="font-doodle text-lg font-bold text-doodle-text">
                    Select a Category
                  </h2>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {categoriesWithFG.map((cat) => (
                      <button
                        key={cat.ProductCategoryID}
                        onClick={() =>
                          setSelectedCategoryId(cat.ProductCategoryID)
                        }
                        className="doodle-card p-4 text-left hover:border-doodle-blue transition-colors group"
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-doodle text-sm font-bold text-doodle-text group-hover:text-doodle-blue">
                            {cat.Name}
                          </p>
                          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-doodle-blue" />
                        </div>
                        <p className="font-doodle text-xs text-muted-foreground mt-1">
                          {cat.fgCount} finished product
                          {cat.fgCount !== 1 ? "s" : ""}
                        </p>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Level 2: Subcategories */}
              {selectedCategoryId && !selectedSubcategoryId && (
                <>
                  <h2 className="font-doodle text-lg font-bold text-doodle-text">
                    {catName} — Subcategories
                  </h2>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {subcatsInCategory.map((sc) => (
                      <button
                        key={sc.ProductSubcategoryID}
                        onClick={() =>
                          setSelectedSubcategoryId(sc.ProductSubcategoryID)
                        }
                        className="doodle-card p-4 text-left hover:border-doodle-blue transition-colors group"
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-doodle text-sm font-bold text-doodle-text group-hover:text-doodle-blue">
                            {sc.Name}
                          </p>
                          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-doodle-blue" />
                        </div>
                        <p className="font-doodle text-xs text-muted-foreground mt-1">
                          {sc.fgCount} product{sc.fgCount !== 1 ? "s" : ""}
                        </p>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Level 3: Finished goods with buildable count */}
              {selectedSubcategoryId &&
                !selectedProductId &&
                (() => {
                  const searchLower = fgSearch.toLowerCase();
                  const filteredFGs = fgsInSubcategory.filter((fg) => {
                    if (fgShowLowOnly && !fg.isLow) return false;
                    if (fgSearch) {
                      return (
                        fg.Name.toLowerCase().includes(searchLower) ||
                        fg.ProductNumber.toLowerCase().includes(searchLower)
                      );
                    }
                    return true;
                  });
                  const totalPages = Math.ceil(
                    filteredFGs.length / ITEMS_PER_PAGE,
                  );
                  const paginated = filteredFGs.slice(
                    fgPage * ITEMS_PER_PAGE,
                    (fgPage + 1) * ITEMS_PER_PAGE,
                  );

                  return (
                    <>
                      <h2 className="font-doodle text-lg font-bold text-doodle-text">
                        {subcatName} — Finished Goods
                      </h2>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="relative flex-1 min-w-[200px] max-w-xs">
                          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                          <input
                            type="text"
                            placeholder="Search products…"
                            value={fgSearch}
                            onChange={(e) => {
                              setFgSearch(e.target.value);
                              setFgPage(0);
                            }}
                            className="w-full pl-9 pr-3 py-2 doodle-button text-sm text-left"
                          />
                        </div>
                        <button
                          onClick={() => {
                            setFgShowLowOnly(!fgShowLowOnly);
                            setFgPage(0);
                          }}
                          className={`doodle-button text-xs py-1.5 px-3 flex items-center gap-1 ${fgShowLowOnly ? "doodle-button-primary" : ""}`}
                        >
                          <AlertTriangle className="w-3 h-3" />{" "}
                          {fgShowLowOnly
                            ? "Low stock only"
                            : "All stock levels"}
                        </button>
                      </div>
                      <p className="font-doodle text-xs text-muted-foreground">
                        Showing {paginated.length} of {filteredFGs.length}{" "}
                        products
                        {filteredFGs.length < fgsInSubcategory.length &&
                          ` (${fgsInSubcategory.length} total)`}
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {paginated.map((fg) => (
                          <div
                            key={fg.ProductID}
                            className={`doodle-card p-4 hover:border-doodle-blue transition-colors group ${fg.isLow ? "border-l-4 border-l-doodle-accent" : ""}`}
                          >
                            <button
                              onClick={() => {
                                setSelectedProductId(fg.ProductID);
                                setFgSearch("");
                                setFgPage(0);
                              }}
                              className="w-full text-left"
                            >
                              <div className="flex items-center justify-between">
                                <p className="font-doodle text-sm font-bold text-doodle-text group-hover:text-doodle-blue truncate">
                                  {fg.Name}
                                </p>
                                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                              </div>
                              <p className="font-doodle text-xs text-muted-foreground mt-1">
                                {fg.ProductNumber}
                              </p>
                            </button>
                            <div className="mt-3 pt-3 border-t border-doodle-text/10 space-y-3">
                              <div className="flex gap-6">
                                <div>
                                  <p className="font-doodle text-xs text-muted-foreground">
                                    In Stock
                                  </p>
                                  <p
                                    className={`font-doodle text-sm font-bold ${fg.isLow ? "text-doodle-accent" : "text-doodle-text"}`}
                                  >
                                    {fg.stock.toLocaleString()}
                                  </p>
                                </div>
                                <div>
                                  <p className="font-doodle text-xs text-muted-foreground flex items-center gap-1">
                                    <Calculator className="w-3 h-3" /> Buildable
                                  </p>
                                  <p className="font-doodle text-sm font-bold text-doodle-blue">
                                    {fg.buildable.toLocaleString()}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                {fg.buildable > 0 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setManufactureProduct(fg);
                                    }}
                                    className={`doodle-button text-xs py-1 px-2 flex items-center gap-1 ${fg.isLow ? "doodle-button-primary" : ""}`}
                                  >
                                    <Factory className="w-3 h-3" /> Manufacture
                                  </button>
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setReorderComponentsProduct(fg);
                                  }}
                                  className="doodle-button text-xs py-1 px-2 flex items-center gap-1"
                                  title="Order missing components from supply chain"
                                >
                                  <ShoppingCart className="w-3 h-3" /> Reorder
                                  Parts
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                        {filteredFGs.length === 0 && (
                          <p className="col-span-full font-doodle text-sm text-muted-foreground text-center py-4">
                            {fgsInSubcategory.length === 0
                              ? "No finished goods in this subcategory"
                              : "No products match the current filters"}
                          </p>
                        )}
                      </div>
                      {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 font-doodle text-sm">
                          <button
                            onClick={() => setFgPage((p) => Math.max(0, p - 1))}
                            disabled={fgPage === 0}
                            className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                          >
                            ← Prev
                          </button>
                          <span className="text-muted-foreground">
                            Page {fgPage + 1} of {totalPages}
                          </span>
                          <button
                            onClick={() =>
                              setFgPage((p) => Math.min(totalPages - 1, p + 1))
                            }
                            disabled={fgPage >= totalPages - 1}
                            className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                          >
                            Next →
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}

              {/* Level 4: BOM explosion — component parts */}
              {selectedProductId &&
                !selectedPartId &&
                (() => {
                  const searchLower = partSearch.toLowerCase();
                  const allParts = [...bomParts]
                    .map((part) => ({
                      ...part,
                      _demand: consumedComponents.get(part.compId) || 0,
                      _isLow: part.product
                        ? part.totalQty < (part.product.SafetyStockLevel || 0)
                        : false,
                    }))
                    .filter(
                      (part) =>
                        !partSearch ||
                        part.name.toLowerCase().includes(searchLower),
                    )
                    .sort((a, b) => {
                      const dir = partSort.dir === "asc" ? 1 : -1;
                      switch (partSort.col) {
                        case "stock":
                          return (a.totalQty - b.totalQty) * dir;
                        case "demand":
                          return (a._demand - b._demand) * dir;
                        case "status":
                          return (
                            ((a._isLow ? 0 : 1) - (b._isLow ? 0 : 1)) * dir
                          );
                        default:
                          return a.name.localeCompare(b.name) * dir;
                      }
                    });
                  const totalPages = Math.ceil(
                    allParts.length / ITEMS_PER_PAGE,
                  );
                  const paginated = allParts.slice(
                    partPage * ITEMS_PER_PAGE,
                    (partPage + 1) * ITEMS_PER_PAGE,
                  );

                  return (
                    <>
                      <h2 className="font-doodle text-lg font-bold text-doodle-text">
                        {productName} — Component Parts ({bomParts.length})
                      </h2>
                      {bomParts.length === 0 ? (
                        <div className="doodle-card-static p-6 text-center font-doodle text-sm text-muted-foreground">
                          No BOM data for this product
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="relative flex-1 min-w-[200px] max-w-xs">
                              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                              <input
                                type="text"
                                placeholder="Search components…"
                                value={partSearch}
                                onChange={(e) => {
                                  setPartSearch(e.target.value);
                                  setPartPage(0);
                                }}
                                className="w-full pl-9 pr-3 py-2 doodle-button text-sm text-left"
                              />
                            </div>
                          </div>
                          <p className="font-doodle text-xs text-muted-foreground">
                            Showing {paginated.length} of {allParts.length}{" "}
                            components
                          </p>
                          <div className="doodle-card-static overflow-x-auto">
                            <table className="w-full font-doodle text-sm">
                              <thead>
                                <tr className="border-b-2 border-doodle-text/20">
                                  <th
                                    className="text-left py-3 px-4 cursor-pointer select-none hover:text-doodle-blue"
                                    onClick={() =>
                                      setPartSort((s) => ({
                                        col: "name",
                                        dir:
                                          s.col === "name" && s.dir === "asc"
                                            ? "desc"
                                            : "asc",
                                      }))
                                    }
                                  >
                                    <span className="inline-flex items-center gap-1">
                                      Component{" "}
                                      {partSort.col === "name" ? (
                                        partSort.dir === "asc" ? (
                                          <ArrowUp className="w-3 h-3" />
                                        ) : (
                                          <ArrowDown className="w-3 h-3" />
                                        )
                                      ) : (
                                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                                      )}
                                    </span>
                                  </th>
                                  <th className="text-right py-3 px-4">
                                    Qty / Assembly
                                  </th>
                                  <th
                                    className="text-right py-3 px-4 cursor-pointer select-none hover:text-doodle-blue"
                                    onClick={() =>
                                      setPartSort((s) => ({
                                        col: "stock",
                                        dir:
                                          s.col === "stock" && s.dir === "desc"
                                            ? "asc"
                                            : "desc",
                                      }))
                                    }
                                  >
                                    <span className="inline-flex items-center gap-1 justify-end">
                                      In Stock{" "}
                                      {partSort.col === "stock" ? (
                                        partSort.dir === "asc" ? (
                                          <ArrowUp className="w-3 h-3" />
                                        ) : (
                                          <ArrowDown className="w-3 h-3" />
                                        )
                                      ) : (
                                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                                      )}
                                    </span>
                                  </th>
                                  <th
                                    className="text-right py-3 px-4 cursor-pointer select-none hover:text-doodle-blue"
                                    onClick={() =>
                                      setPartSort((s) => ({
                                        col: "demand",
                                        dir:
                                          s.col === "demand" && s.dir === "desc"
                                            ? "asc"
                                            : "desc",
                                      }))
                                    }
                                  >
                                    <span className="inline-flex items-center gap-1 justify-end">
                                      Active Demand{" "}
                                      {partSort.col === "demand" ? (
                                        partSort.dir === "asc" ? (
                                          <ArrowUp className="w-3 h-3" />
                                        ) : (
                                          <ArrowDown className="w-3 h-3" />
                                        )
                                      ) : (
                                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                                      )}
                                    </span>
                                  </th>
                                  <th
                                    className="text-center py-3 px-4 cursor-pointer select-none hover:text-doodle-blue"
                                    onClick={() =>
                                      setPartSort((s) => ({
                                        col: "status",
                                        dir:
                                          s.col === "status" && s.dir === "asc"
                                            ? "desc"
                                            : "asc",
                                      }))
                                    }
                                  >
                                    <span className="inline-flex items-center gap-1">
                                      Status{" "}
                                      {partSort.col === "status" ? (
                                        partSort.dir === "asc" ? (
                                          <ArrowUp className="w-3 h-3" />
                                        ) : (
                                          <ArrowDown className="w-3 h-3" />
                                        )
                                      ) : (
                                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                                      )}
                                    </span>
                                  </th>
                                  <th className="text-right py-3 px-4"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {paginated.map((part) => {
                                  const demand = part._demand;
                                  const isLow = part._isLow;
                                  const isConsuming = demand > 0;
                                  return (
                                    <tr
                                      key={part.compId}
                                      className="border-b border-doodle-text/10 hover:bg-secondary/30"
                                    >
                                      <td className="py-3 px-4">
                                        <button
                                          onClick={() => {
                                            setSelectedPartId(part.compId);
                                            setPartSearch("");
                                            setPartPage(0);
                                          }}
                                          className="text-doodle-blue hover:underline font-bold text-left"
                                        >
                                          {part.name}
                                        </button>
                                      </td>
                                      <td className="text-right py-3 px-4">
                                        {part.qtyPer}
                                      </td>
                                      <td className="text-right py-3 px-4 font-bold">
                                        {part.totalQty.toLocaleString()}
                                      </td>
                                      <td className="text-right py-3 px-4">
                                        {isConsuming && (
                                          <span className="text-doodle-accent font-bold flex items-center justify-end gap-1">
                                            <Activity className="w-3 h-3 animate-pulse" />{" "}
                                            {demand.toLocaleString()}
                                          </span>
                                        )}
                                      </td>
                                      <td className="text-center py-3 px-4">
                                        {isLow ? (
                                          <span className="inline-flex items-center gap-1 text-doodle-accent text-xs font-bold">
                                            <AlertTriangle className="w-3 h-3" />{" "}
                                            Low
                                          </span>
                                        ) : (
                                          <span className="text-doodle-green text-xs font-bold">
                                            OK
                                          </span>
                                        )}
                                      </td>
                                      <td className="text-right py-3 px-4">
                                        {part.product &&
                                          !part.product.MakeFlag && (
                                            <button
                                              onClick={() =>
                                                part.product &&
                                                setReorderProduct(part.product)
                                              }
                                              className="doodle-button text-xs py-1 px-2"
                                            >
                                              <RefreshCw className="w-3 h-3 inline mr-1" />
                                              Reorder
                                            </button>
                                          )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          {totalPages > 1 && (
                            <div className="flex items-center justify-center gap-2 font-doodle text-sm">
                              <button
                                onClick={() =>
                                  setPartPage((p) => Math.max(0, p - 1))
                                }
                                disabled={partPage === 0}
                                className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                              >
                                ← Prev
                              </button>
                              <span className="text-muted-foreground">
                                Page {partPage + 1} of {totalPages}
                              </span>
                              <button
                                onClick={() =>
                                  setPartPage((p) =>
                                    Math.min(totalPages - 1, p + 1),
                                  )
                                }
                                disabled={partPage >= totalPages - 1}
                                className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                              >
                                Next →
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  );
                })()}

              {/* Level 5: Part inventory locations */}
              {selectedProductId && selectedPartId && (
                <>
                  <h2 className="font-doodle text-lg font-bold text-doodle-text">
                    {productMap.get(selectedPartId)?.Name} — Inventory Locations
                  </h2>
                  {selectedPartInventory.length === 0 ? (
                    <div className="doodle-card-static p-6 text-center font-doodle text-sm text-muted-foreground">
                      No inventory records for this part
                    </div>
                  ) : (
                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {selectedPartInventory.map((inv, idx) => (
                        <div key={idx} className="doodle-card p-4">
                          <h3 className="font-doodle text-sm font-bold text-doodle-text">
                            {locationMap.get(inv.LocationID)?.Name ||
                              `Location #${inv.LocationID}`}
                          </h3>
                          <div className="mt-2 space-y-1 font-doodle text-sm">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">
                                Shelf
                              </span>
                              <span className="font-bold">{inv.Shelf}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Bin</span>
                              <span className="font-bold">{inv.Bin}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">
                                Quantity
                              </span>
                              <span className="font-bold text-doodle-green">
                                {inv.Quantity.toLocaleString()}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {productMap.get(selectedPartId) &&
                    !productMap.get(selectedPartId)!.MakeFlag && (
                      <button
                        onClick={() =>
                          setReorderProduct(productMap.get(selectedPartId)!)
                        }
                        className="doodle-button doodle-button-primary text-sm"
                      >
                        <RefreshCw className="w-4 h-4 inline mr-1" /> Reorder
                        This Component
                      </button>
                    )}
                </>
              )}
            </div>
          )}

          {/* ═══ PURCHASE ORDERS MODE ═══ */}
          {mode === "orders" && (
            <div className="space-y-4">
              <h2 className="font-doodle text-lg font-bold text-doodle-text">
                Purchase Orders
              </h2>

              {/* Summary Dashboard */}
              {poHeaders &&
                poHeaders.length > 0 &&
                (() => {
                  const openPOs = poHeaders.filter((po) => po.Status < 4);
                  const pendingValue = openPOs.reduce(
                    (s, po) => s + po.TotalDue,
                    0,
                  );
                  const completedPOs = poHeaders.filter(
                    (po) => po.Status === 4,
                  );
                  const recentPOs = poHeaders.filter(
                    (po) => new Date(po.OrderDate).getFullYear() >= 2026,
                  );
                  const avgLeadDays =
                    completedPOs.length > 0
                      ? completedPOs
                          .filter((po) => po.ShipDate)
                          .reduce((s, po) => {
                            const order = new Date(po.OrderDate).getTime();
                            const ship = new Date(po.ShipDate!).getTime();
                            return s + (ship - order) / (1000 * 60 * 60 * 24);
                          }, 0) /
                        completedPOs.filter((po) => po.ShipDate).length
                      : null;
                  return (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="doodle-card p-4">
                        <p className="font-doodle text-xs text-muted-foreground">
                          Open POs
                        </p>
                        <p className="font-doodle text-2xl font-bold text-doodle-text">
                          {openPOs.length}
                        </p>
                        <p className="font-doodle text-xs text-muted-foreground mt-1">
                          of {poHeaders.length} total
                        </p>
                      </div>
                      <div className="doodle-card p-4">
                        <p className="font-doodle text-xs text-muted-foreground">
                          Pending Value
                        </p>
                        <p className="font-doodle text-2xl font-bold text-doodle-blue">
                          $
                          {pendingValue.toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 0,
                          })}
                        </p>
                        <p className="font-doodle text-xs text-muted-foreground mt-1">
                          across {openPOs.length} orders
                        </p>
                      </div>
                      <div className="doodle-card p-4">
                        <p className="font-doodle text-xs text-muted-foreground">
                          Avg Lead Time
                        </p>
                        <p className="font-doodle text-2xl font-bold text-doodle-text">
                          {avgLeadDays != null
                            ? `${avgLeadDays.toFixed(1)}d`
                            : "—"}
                        </p>
                        <p className="font-doodle text-xs text-muted-foreground mt-1">
                          order → ship
                        </p>
                      </div>
                      <div className="doodle-card p-4">
                        <p className="font-doodle text-xs text-muted-foreground">
                          Recent
                        </p>
                        <p className="font-doodle text-2xl font-bold text-doodle-accent">
                          {recentPOs.length}
                        </p>
                        <p className="font-doodle text-xs text-muted-foreground mt-1">
                          placed via supply chain
                        </p>
                      </div>
                    </div>
                  );
                })()}

              {/* Filters */}
              {poHeaders && poHeaders.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative flex-1 min-w-[200px] max-w-xs">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="Search PO #, vendor…"
                      value={poSearch}
                      onChange={(e) => {
                        setPoSearch(e.target.value);
                        setPoPage(0);
                      }}
                      className="w-full pl-9 pr-3 py-2 doodle-button text-sm text-left"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 font-doodle text-xs">
                    <Filter className="w-3.5 h-3.5 text-muted-foreground" />
                    {(
                      [
                        [1, "Pending", "bg-yellow-100 text-yellow-800"],
                        [2, "Approved", "bg-blue-100 text-blue-800"],
                        [3, "Rejected", "bg-red-100 text-red-800"],
                        [4, "Complete", "bg-emerald-100 text-emerald-800"],
                      ] as [number, string, string][]
                    ).map(([status, label, color]) => (
                      <button
                        key={status}
                        onClick={() => {
                          setPoStatusFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(status)) next.delete(status);
                            else next.add(status);
                            return next;
                          });
                          setPoPage(0);
                        }}
                        className={`px-2 py-0.5 rounded-full font-bold transition-opacity ${color} ${poStatusFilter.has(status) ? "opacity-100" : "opacity-30"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(() => {
                if (!poHeaders) return <TableSkeleton rows={6} cols={5} />;
                if (poHeaders.length === 0)
                  return (
                    <div className="doodle-card-static p-6 text-center font-doodle text-sm text-muted-foreground">
                      No purchase orders found
                    </div>
                  );

                const searchLower = poSearch.toLowerCase();
                const filteredPOs = poHeaders
                  .filter((po) => {
                    if (
                      poStatusFilter.size > 0 &&
                      !poStatusFilter.has(po.Status)
                    )
                      return false;
                    if (poSearch) {
                      const vendor = vendorMap.get(po.VendorID);
                      const vendorName = vendor?.Name?.toLowerCase() || "";
                      const poNum = String(po.PurchaseOrderID);
                      return (
                        poNum.includes(searchLower) ||
                        vendorName.includes(searchLower)
                      );
                    }
                    return true;
                  })
                  .sort((a, b) => b.PurchaseOrderID - a.PurchaseOrderID);

                const totalPages = Math.ceil(filteredPOs.length / PO_PAGE_SIZE);
                const paginated = filteredPOs.slice(
                  poPage * PO_PAGE_SIZE,
                  (poPage + 1) * PO_PAGE_SIZE,
                );

                return (
                  <>
                    <p className="font-doodle text-xs text-muted-foreground">
                      Showing {paginated.length} of {filteredPOs.length} orders
                      {filteredPOs.length < poHeaders.length &&
                        ` (${poHeaders.length} total)`}
                    </p>
                    <div className="doodle-card-static overflow-x-auto">
                      <table className="w-full font-doodle text-sm">
                        <thead>
                          <tr className="border-b-2 border-doodle-text/20">
                            <th className="text-left py-3 px-4">PO #</th>
                            <th className="text-left py-3 px-4">Vendor</th>
                            <th className="text-center py-3 px-4">Status</th>
                            <th className="text-left py-3 px-4">Order Date</th>
                            <th className="text-left py-3 px-4">Ship Date</th>
                            <th className="text-right py-3 px-4">Total Due</th>
                            <th className="text-center py-3 px-4">Items</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paginated.map((po) => {
                            const vendor = vendorMap.get(po.VendorID);
                            const isExpanded =
                              expandedPO === po.PurchaseOrderID;
                            const statusConfig: Record<
                              number,
                              {
                                label: string;
                                color: string;
                                icon: React.ReactNode;
                              }
                            > = {
                              1: {
                                label: "Pending",
                                color: "bg-yellow-100 text-yellow-800",
                                icon: <Clock className="w-3 h-3" />,
                              },
                              2: {
                                label: "Approved",
                                color: "bg-blue-100 text-blue-800",
                                icon: <Truck className="w-3 h-3" />,
                              },
                              3: {
                                label: "Rejected",
                                color: "bg-red-100 text-red-800",
                                icon: <XCircle className="w-3 h-3" />,
                              },
                              4: {
                                label: "Complete",
                                color: "bg-emerald-100 text-emerald-800",
                                icon: <CheckCircle className="w-3 h-3" />,
                              },
                            };
                            const status =
                              statusConfig[po.Status] || statusConfig[1];
                            const isRecent =
                              new Date(po.OrderDate).getFullYear() >= 2026;

                            return (
                              <>
                                <tr
                                  key={po.PurchaseOrderID}
                                  onClick={() =>
                                    setExpandedPO(
                                      isExpanded ? null : po.PurchaseOrderID,
                                    )
                                  }
                                  className={`border-b border-doodle-text/10 hover:bg-secondary/30 cursor-pointer ${isRecent ? "bg-primary/5" : ""}`}
                                >
                                  <td className="py-3 px-4 font-bold">
                                    <span className="flex items-center gap-1">
                                      {isExpanded ? (
                                        <ChevronUp className="w-3 h-3" />
                                      ) : (
                                        <ChevronDown className="w-3 h-3" />
                                      )}
                                      #{po.PurchaseOrderID}
                                    </span>
                                  </td>
                                  <td className="py-3 px-4">
                                    {vendor?.Name || `Vendor #${po.VendorID}`}
                                  </td>
                                  <td className="text-center py-3 px-4">
                                    <span
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${status.color}`}
                                    >
                                      {status.icon} {status.label}
                                    </span>
                                  </td>
                                  <td className="py-3 px-4 text-muted-foreground">
                                    {new Date(
                                      po.OrderDate,
                                    ).toLocaleDateString()}
                                  </td>
                                  <td className="py-3 px-4 text-muted-foreground">
                                    {po.ShipDate
                                      ? new Date(
                                          po.ShipDate,
                                        ).toLocaleDateString()
                                      : "—"}
                                  </td>
                                  <td className="text-right py-3 px-4 font-bold">
                                    $
                                    {po.TotalDue.toLocaleString(undefined, {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })}
                                  </td>
                                  <td className="text-center py-3 px-4">
                                    <span className="text-muted-foreground">
                                      Rev {po.RevisionNumber}
                                    </span>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr key={`${po.PurchaseOrderID}-detail`}>
                                    <td colSpan={7} className="p-0">
                                      <div className="bg-secondary/20 px-8 py-4 border-b border-doodle-text/10">
                                        {!expandedPODetails ? (
                                          <p className="font-doodle text-xs text-muted-foreground flex items-center gap-2">
                                            <Loader2 className="w-3 h-3 animate-spin" />{" "}
                                            Loading line items…
                                          </p>
                                        ) : expandedPODetails.length === 0 ? (
                                          <p className="font-doodle text-xs text-muted-foreground">
                                            No line items found
                                          </p>
                                        ) : (
                                          <div className="space-y-3">
                                            <p className="font-doodle text-xs font-bold text-muted-foreground uppercase tracking-wider">
                                              Line Items
                                            </p>
                                            <table className="w-full font-doodle text-xs">
                                              <thead>
                                                <tr className="border-b border-doodle-text/10">
                                                  <th className="text-left py-2 px-3">
                                                    Product
                                                  </th>
                                                  <th className="text-right py-2 px-3">
                                                    Ordered
                                                  </th>
                                                  <th className="text-right py-2 px-3">
                                                    Received
                                                  </th>
                                                  <th className="text-right py-2 px-3">
                                                    Stocked
                                                  </th>
                                                  <th className="text-right py-2 px-3">
                                                    Unit Price
                                                  </th>
                                                  <th className="text-right py-2 px-3">
                                                    Line Total
                                                  </th>
                                                  <th className="text-left py-2 px-3">
                                                    Due Date
                                                  </th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {expandedPODetails.map(
                                                  (detail) => {
                                                    const prod = productMap.get(
                                                      detail.ProductID,
                                                    );
                                                    const receivedPct =
                                                      detail.OrderQty > 0
                                                        ? (detail.ReceivedQty /
                                                            detail.OrderQty) *
                                                          100
                                                        : 0;
                                                    return (
                                                      <tr
                                                        key={
                                                          detail.PurchaseOrderDetailID
                                                        }
                                                        className="border-b border-doodle-text/5"
                                                      >
                                                        <td className="py-2 px-3">
                                                          <Link
                                                            to={`/receive/inventory/${detail.ProductID}`}
                                                            className="text-doodle-blue hover:underline font-bold"
                                                          >
                                                            {prod?.Name ||
                                                              `Product #${detail.ProductID}`}
                                                          </Link>
                                                        </td>
                                                        <td className="text-right py-2 px-3 font-bold">
                                                          {detail.OrderQty}
                                                        </td>
                                                        <td className="text-right py-2 px-3">
                                                          <span
                                                            className={
                                                              receivedPct >= 100
                                                                ? "text-doodle-green font-bold"
                                                                : receivedPct >
                                                                    0
                                                                  ? "text-doodle-blue"
                                                                  : "text-muted-foreground"
                                                            }
                                                          >
                                                            {detail.ReceivedQty}
                                                          </span>
                                                        </td>
                                                        <td className="text-right py-2 px-3">
                                                          {detail.StockedQty}
                                                        </td>
                                                        <td className="text-right py-2 px-3">
                                                          $
                                                          {detail.UnitPrice.toFixed(
                                                            2,
                                                          )}
                                                        </td>
                                                        <td className="text-right py-2 px-3 font-bold">
                                                          $
                                                          {detail.LineTotal.toLocaleString(
                                                            undefined,
                                                            {
                                                              minimumFractionDigits: 2,
                                                              maximumFractionDigits: 2,
                                                            },
                                                          )}
                                                        </td>
                                                        <td className="py-2 px-3 text-muted-foreground">
                                                          {new Date(
                                                            detail.DueDate,
                                                          ).toLocaleDateString()}
                                                        </td>
                                                      </tr>
                                                    );
                                                  },
                                                )}
                                              </tbody>
                                            </table>
                                            <div className="flex gap-6 text-xs text-muted-foreground pt-2 border-t border-doodle-text/10">
                                              <span>
                                                Subtotal:{" "}
                                                <strong>
                                                  $
                                                  {po.SubTotal.toLocaleString(
                                                    undefined,
                                                    {
                                                      minimumFractionDigits: 2,
                                                    },
                                                  )}
                                                </strong>
                                              </span>
                                              <span>
                                                Tax:{" "}
                                                <strong>
                                                  $
                                                  {po.TaxAmt.toLocaleString(
                                                    undefined,
                                                    {
                                                      minimumFractionDigits: 2,
                                                    },
                                                  )}
                                                </strong>
                                              </span>
                                              <span>
                                                Freight:{" "}
                                                <strong>
                                                  $
                                                  {po.Freight.toLocaleString(
                                                    undefined,
                                                    {
                                                      minimumFractionDigits: 2,
                                                    },
                                                  )}
                                                </strong>
                                              </span>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-center gap-2 font-doodle text-sm">
                        <button
                          onClick={() => setPoPage((p) => Math.max(0, p - 1))}
                          disabled={poPage === 0}
                          className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                        >
                          ← Prev
                        </button>
                        <span className="text-muted-foreground">
                          Page {poPage + 1} of {totalPages}
                        </span>
                        <button
                          onClick={() =>
                            setPoPage((p) => Math.min(totalPages - 1, p + 1))
                          }
                          disabled={poPage >= totalPages - 1}
                          className="doodle-button text-xs py-1 px-3 disabled:opacity-30"
                        >
                          Next →
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </>
      )}

      {/* Reorder Dialog */}
      {reorderProduct && inventory && locations && (
        <ReorderDialog
          product={reorderProduct}
          inventory={inventory}
          locations={locations}
          pendingOrdersByProduct={pendingOrdersByProduct}
          onClose={() => setReorderProduct(null)}
        />
      )}

      {/* Schedule Manufacture Dialog */}
      {manufactureProduct && bom && (
        <ScheduleManufactureDialog
          product={manufactureProduct}
          buildable={calcBuildable(
            manufactureProduct.ProductID,
            bom,
            inventoryByProduct,
          )}
          onClose={() => setManufactureProduct(null)}
        />
      )}

      {/* Reorder Components Dialog */}
      {reorderComponentsProduct && bom && (
        <ReorderComponentsDialog
          product={reorderComponentsProduct}
          bom={bom}
          inventoryByProduct={inventoryByProduct}
          pendingOrdersByProduct={pendingOrdersByProduct}
          productMap={productMap}
          onClose={() => setReorderComponentsProduct(null)}
          onManufacture={(p) => setManufactureProduct(p)}
        />
      )}
    </div>
  );
};

export default ReceiveInventory;
