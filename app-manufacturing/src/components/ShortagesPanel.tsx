import React, { useMemo, useState, useCallback } from "react";
import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Package,
  Truck,
  ShoppingCart,
  DollarSign,
  Pencil,
  Ban,
  X,
  PackagePlus,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import type { ManufacturingStatus } from "@/services/api";
import {
  fetchWorkOrders,
  updateWorkOrder,
  deleteWorkOrder,
} from "@/services/api";
import {
  fetchCatalog,
  submitBulkReorder,
  formatIncomingEta,
  formatUtcTime,
  type SupplyQuote,
  type PurchaseOrder,
} from "@/services/supplyChainApi";

interface Props {
  status: ManufacturingStatus | undefined;
  ordersByProduct: Map<number, PurchaseOrder[]>;
}

type Shortage = ManufacturingStatus["shortages"][number];

const fmtMoney = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

const ShortagesPanel: React.FC<Props> = ({ status, ordersByProduct }) => {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const shortages = status?.shortages ?? [];

  // Group shortages by product
  const grouped = useMemo(() => {
    const byProduct = new Map<
      number,
      {
        productId: number;
        productName: string;
        totalShortfall: number;
        totalNeeded: number;
        totalAvailable: number;
        workOrders: Shortage[];
      }
    >();
    for (const s of shortages) {
      const e = byProduct.get(s.productId) || {
        productId: s.productId,
        productName: s.productName,
        totalShortfall: 0,
        totalNeeded: 0,
        totalAvailable: s.available,
        workOrders: [] as Shortage[],
      };
      e.totalShortfall += s.shortfall;
      e.totalNeeded += s.needed;
      e.totalAvailable = s.available;
      e.workOrders.push(s);
      byProduct.set(s.productId, e);
    }
    return Array.from(byProduct.values()).sort(
      (a, b) => b.totalShortfall - a.totalShortfall,
    );
  }, [shortages]);

  // Batch quote lookups for each shortage product
  const quoteResults = useQueries({
    queries: grouped.map((g) => ({
      queryKey: ["supply-catalog", g.productId],
      queryFn: () => fetchCatalog(g.productId),
      staleTime: 60_000,
      enabled: g.totalShortfall > 0,
    })),
  });
  const quotesByProduct = useMemo(() => {
    const m = new Map<number, SupplyQuote[]>();
    grouped.forEach((g, i) => {
      const data = quoteResults[i]?.data as SupplyQuote[] | undefined;
      if (data) {
        // sort cheapest with stock first
        const sorted = [...data].sort((a, b) => {
          const aOk = (a.stockAvailable ?? 0) > 0 ? 0 : 1;
          const bOk = (b.stockAvailable ?? 0) > 0 ? 0 : 1;
          if (aOk !== bOk) return aOk - bOk;
          return (a.unitCost ?? Infinity) - (b.unitCost ?? Infinity);
        });
        m.set(g.productId, sorted);
      }
    });
    return m;
  }, [grouped, quoteResults]);

  // Work orders for OrderQty/StockedQty (used for Reduce dialog)
  const { data: workOrders } = useQuery({
    queryKey: ["work-orders"],
    queryFn: fetchWorkOrders,
    staleTime: 30_000,
    enabled: shortages.length > 0,
  });
  const woById = useMemo(() => {
    const m = new Map<number, { OrderQty: number; StockedQty: number }>();
    workOrders?.forEach((w) =>
      m.set(w.WorkOrderID, { OrderQty: w.OrderQty, StockedQty: w.StockedQty }),
    );
    return m;
  }, [workOrders]);

  // Selection state — set of WorkOrderIDs
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  const toggleGroup = (ids: number[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  // Mutations
  const cancelMutation = useMutation({
    mutationFn: (id: number) => deleteWorkOrder(id),
  });
  const reduceMutation = useMutation({
    mutationFn: ({ id, qty }: { id: number; qty: number }) =>
      updateWorkOrder(id, { OrderQty: qty }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
    qc.invalidateQueries({ queryKey: ["work-orders"] });
  };

  // Reduce dialog
  const [reduceTarget, setReduceTarget] = useState<{
    id: number;
    current: number;
    stocked: number;
  } | null>(null);
  const [reduceValue, setReduceValue] = useState<string>("");
  const openReduce = (id: number) => {
    const wo = woById.get(id);
    const current = wo?.OrderQty ?? 0;
    const stocked = wo?.StockedQty ?? 0;
    setReduceTarget({ id, current, stocked });
    setReduceValue(String(Math.max(stocked, Math.max(0, current - 1))));
  };
  const submitReduce = async () => {
    if (!reduceTarget) return;
    const qty = parseInt(reduceValue, 10);
    if (isNaN(qty) || qty < reduceTarget.stocked) {
      toast.error(
        `Quantity must be at least already-stocked (${reduceTarget.stocked})`,
      );
      return;
    }
    if (qty >= reduceTarget.current) {
      toast.error("New quantity must be less than current OrderQty");
      return;
    }
    try {
      await reduceMutation.mutateAsync({ id: reduceTarget.id, qty });
      toast.success(`WO #${reduceTarget.id} reduced to ${qty}`);
      setReduceTarget(null);
      invalidate();
    } catch (e) {
      toast.error(`Failed to reduce WO: ${(e as Error).message}`);
    }
  };

  // Cancel one
  const [cancelOne, setCancelOne] = useState<number | null>(null);
  const submitCancelOne = async () => {
    if (cancelOne == null) return;
    try {
      await cancelMutation.mutateAsync(cancelOne);
      toast.success(`WO #${cancelOne} cancelled`);
      setCancelOne(null);
      invalidate();
    } catch (e) {
      toast.error(`Failed to cancel: ${(e as Error).message}`);
    }
  };

  // Bulk cancel
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const submitBulk = async () => {
    const activeShortageIds = new Set(shortages.map((s) => s.workOrderId));
    const ids = Array.from(selected).filter((id) => activeShortageIds.has(id));
    const skipped = selected.size - ids.length;
    const failures: number[] = [];
    for (const id of ids) {
      try {
        await cancelMutation.mutateAsync(id);
      } catch {
        failures.push(id);
      }
    }
    const suffix =
      skipped > 0
        ? `; skipped ${skipped} stale selection${skipped === 1 ? "" : "s"}`
        : "";
    if (failures.length === 0)
      toast.success(`Cancelled ${ids.length} work orders${suffix}`);
    else
      toast.error(
        `Cancelled ${ids.length - failures.length}/${ids.length}; failed: ${failures.join(", ")}${suffix}`,
      );
    setBulkConfirm(false);
    clearSelection();
    invalidate();
  };

  // Bulk savings estimate
  const bulkSavings = useMemo(() => {
    let units = 0;
    let dollars = 0;
    selected.forEach((id) => {
      const s = shortages.find((x) => x.workOrderId === id);
      if (!s) return;
      units += s.shortfall;
      const best = quotesByProduct.get(s.productId)?.[0];
      if (best?.unitCost) dollars += best.unitCost * s.shortfall;
    });
    return { units, dollars };
  }, [selected, shortages, quotesByProduct]);

  // ── Re-Order All logic ──────────────────────────────────────────────────────
  const [reorderAllConfirm, setReorderAllConfirm] = useState(false);
  const [reorderAllInProgress, setReorderAllInProgress] = useState(false);

  // Persist submitted product IDs in sessionStorage so the state survives
  // tab navigation (component unmount/remount). Expires after 10 minutes.
  const STORAGE_KEY = "reorderAllSubmitted";
  const readSubmitted = useCallback((): {
    ids: Set<number>;
    totalOrdersPlanned: number;
    baselineOrderCount: number;
  } => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw)
        return { ids: new Set(), totalOrdersPlanned: 0, baselineOrderCount: 0 };
      const parsed = JSON.parse(raw) as {
        ids: number[];
        totalOrdersPlanned: number;
        baselineOrderCount: number;
        ts: number;
      };
      // Expire after 10 minutes
      if (Date.now() - parsed.ts > 10 * 60 * 1000) {
        sessionStorage.removeItem(STORAGE_KEY);
        return { ids: new Set(), totalOrdersPlanned: 0, baselineOrderCount: 0 };
      }
      return {
        ids: new Set(parsed.ids),
        totalOrdersPlanned: parsed.totalOrdersPlanned ?? 0,
        baselineOrderCount: parsed.baselineOrderCount ?? 0,
      };
    } catch {
      return { ids: new Set(), totalOrdersPlanned: 0, baselineOrderCount: 0 };
    }
  }, []);
  const writeSubmitted = useCallback(
    (
      ids: Set<number>,
      totalOrdersPlanned: number,
      baselineOrderCount: number,
    ) => {
      if (ids.size === 0) {
        sessionStorage.removeItem(STORAGE_KEY);
      } else {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            ids: Array.from(ids),
            totalOrdersPlanned,
            baselineOrderCount,
            ts: Date.now(),
          }),
        );
      }
    },
    [],
  );
  const initialSubmitted = readSubmitted();
  const [reorderAllSubmitted, setReorderAllSubmittedRaw] = useState<
    Set<number>
  >(initialSubmitted.ids);
  const [reorderAllTotalOrders, setReorderAllTotalOrdersRaw] = useState<number>(
    initialSubmitted.totalOrdersPlanned,
  );
  const [reorderAllBaselineOrders, setReorderAllBaselineOrdersRaw] =
    useState<number>(initialSubmitted.baselineOrderCount);
  const setReorderAllSubmitted = useCallback(
    (
      ids: Set<number>,
      totalOrdersPlanned?: number,
      baselineOrderCount?: number,
    ) => {
      const totalOrd = totalOrdersPlanned ?? reorderAllTotalOrders;
      const baseOrd = baselineOrderCount ?? reorderAllBaselineOrders;
      writeSubmitted(ids, totalOrd, baseOrd);
      setReorderAllSubmittedRaw(ids);
      if (totalOrdersPlanned !== undefined)
        setReorderAllTotalOrdersRaw(totalOrdersPlanned);
      if (baselineOrderCount !== undefined)
        setReorderAllBaselineOrdersRaw(baselineOrderCount);
    },
    [writeSubmitted, reorderAllTotalOrders, reorderAllBaselineOrders],
  );

  // Order-level progress: count current orders for submitted products vs planned
  const reorderAllProgress = useMemo(() => {
    if (reorderAllTotalOrders === 0 || reorderAllSubmitted.size === 0) return 0;
    let currentOrderCount = 0;
    reorderAllSubmitted.forEach((pid) => {
      const orders = ordersByProduct.get(pid) || [];
      currentOrderCount += orders.length;
    });
    const newOrders = Math.max(0, currentOrderCount - reorderAllBaselineOrders);
    return Math.min(100, Math.round((newOrders / reorderAllTotalOrders) * 100));
  }, [
    reorderAllSubmitted,
    reorderAllTotalOrders,
    reorderAllBaselineOrders,
    ordersByProduct,
  ]);

  // Compute what needs ordering across all shortage groups
  const reorderAllPlan = useMemo(() => {
    const items: {
      productId: number;
      productName: string;
      remainingToOrder: number;
      quotes: SupplyQuote[];
      estCost: number;
      fulfillableQty: number;
      fulfillable: boolean;
    }[] = [];
    for (const g of grouped) {
      const orders = ordersByProduct.get(g.productId) || [];
      const totalOnOrder = orders.reduce((sum, o) => sum + o.qty, 0);
      const remainingToOrder = Math.max(0, g.totalShortfall - totalOnOrder);
      if (remainingToOrder <= 0) continue;
      const quotes = quotesByProduct.get(g.productId) || [];
      if (quotes.length === 0) continue;
      const best = quotes[0];
      // Calculate how much can actually be fulfilled from vendors with stock
      const availableVendors = quotes.filter((q) => q.stockAvailable > 0);
      const fulfillableQty = Math.min(
        remainingToOrder,
        availableVendors.reduce((sum, v) => sum + v.stockAvailable, 0),
      );
      items.push({
        productId: g.productId,
        productName: g.productName,
        remainingToOrder,
        quotes,
        estCost: best.unitCost * remainingToOrder,
        fulfillableQty,
        fulfillable: fulfillableQty > 0,
      });
    }
    return items;
  }, [grouped, ordersByProduct, quotesByProduct]);

  const reorderAllFulfillable = useMemo(
    () => reorderAllPlan.filter((item) => item.fulfillable),
    [reorderAllPlan],
  );
  const reorderAllUnfulfillable = useMemo(
    () => reorderAllPlan.filter((item) => !item.fulfillable),
    [reorderAllPlan],
  );
  const reorderAllFulfillableCost = useMemo(
    () =>
      reorderAllPlan.reduce((sum, item) => {
        if (!item.fulfillable) return sum;
        const best = item.quotes.find((q) => q.stockAvailable > 0);
        return sum + (best ? best.unitCost * item.fulfillableQty : 0);
      }, 0),
    [reorderAllPlan],
  );

  const submitReorderAll = async () => {
    setReorderAllInProgress(true);
    try {
      const items = reorderAllFulfillable.map((item) => ({
        productId: item.productId,
        remainingToOrder: item.remainingToOrder,
        quotes: item.quotes
          .filter((q) => q.stockAvailable > 0)
          .sort((a, b) => a.unitCost - b.unitCost)
          .map((q) => ({
            vendorId: q.vendorId,
            stockAvailable: q.stockAvailable,
            minOrderQty: q.minOrderQty || 1,
            maxOrderQty: q.maxOrderQty || q.stockAvailable,
            unitCost: q.unitCost,
          })),
      }));

      const result = await submitBulkReorder(items);
      // Snapshot how many orders already exist for these products (baseline)
      let baselineCount = 0;
      for (const item of reorderAllFulfillable) {
        baselineCount += (ordersByProduct.get(item.productId) || []).length;
      }
      setReorderAllSubmitted(
        new Set(reorderAllFulfillable.map((i) => i.productId)),
        result.totalOrdersPlanned,
        baselineCount,
      );
      setReorderAllConfirm(false);
      toast.success(
        `Reordering ${reorderAllFulfillable.length} product${reorderAllFulfillable.length !== 1 ? "s" : ""} in background (${result.totalOrdersPlanned} POs planned)`,
      );
    } catch (e) {
      console.error("Bulk reorder failed:", e);
      toast.error("Failed to submit bulk reorder — please try again.");
    } finally {
      setReorderAllInProgress(false);
    }
  };

  // Clear submitted tracking when shortages resolve (real-time updates).
  // A product is considered resolved when either:
  // - its shortage disappears entirely, OR
  // - pending/approved orders already cover the shortfall (remainingToOrder ≤ 0)
  React.useEffect(() => {
    if (reorderAllSubmitted.size === 0) return;
    const unresolvedProducts = new Set<number>();
    for (const g of grouped) {
      const orders = ordersByProduct.get(g.productId) || [];
      const totalOnOrder = orders.reduce((sum, o) => sum + o.qty, 0);
      if (g.totalShortfall - totalOnOrder > 0) {
        unresolvedProducts.add(g.productId);
      }
    }
    const updated = new Set<number>();
    reorderAllSubmitted.forEach((pid) => {
      if (unresolvedProducts.has(pid)) updated.add(pid);
    });
    if (updated.size < reorderAllSubmitted.size) {
      setReorderAllSubmitted(updated);
    }
  }, [grouped, ordersByProduct, reorderAllSubmitted, setReorderAllSubmitted]);

  if (!shortages.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-doodle">Material Shortages</CardTitle>
          <CardDescription>
            Work orders stalled waiting for purchased components
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm text-center py-4">
            No active shortages — supply chain is healthy.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="font-doodle">Material Shortages</CardTitle>
              <CardDescription>
                Grouped by missing component. Use Reduce to scale a WO down, or
                Cancel to remove it entirely.
              </CardDescription>
            </div>
            {reorderAllPlan.length > 0 && (
              <Button
                onClick={() => setReorderAllConfirm(true)}
                className="gap-2"
                disabled={
                  reorderAllFulfillable.length === 0 ||
                  reorderAllSubmitted.size > 0
                }
              >
                {reorderAllSubmitted.size > 0 ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Reordering — {reorderAllProgress}% complete
                  </>
                ) : (
                  <>
                    <PackagePlus className="h-4 w-4" />
                    Re-Order All
                    {reorderAllFulfillable.length > 0 && (
                      <span className="font-mono text-xs opacity-90">
                        {fmtMoney(reorderAllFulfillableCost)}
                      </span>
                    )}
                  </>
                )}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" className="space-y-1">
            {grouped.map((g) => {
              const orders = ordersByProduct.get(g.productId) || [];
              const totalOnOrder = orders.reduce((sum, o) => sum + o.qty, 0);
              const remainingToOrder = Math.max(
                0,
                g.totalShortfall - totalOnOrder,
              );
              const covered = totalOnOrder >= g.totalShortfall;
              const quotes = quotesByProduct.get(g.productId) || [];
              const best = quotes[0];
              const next = quotes[1];
              // Calculate how much vendors can actually supply
              const availableVendors = quotes.filter(
                (q) => q.stockAvailable > 0,
              );
              const totalVendorStock = availableVendors.reduce((sum, v) => {
                const maxQty = v.maxOrderQty || v.stockAvailable;
                return sum + Math.min(v.stockAvailable, maxQty);
              }, 0);
              const orderableQty = Math.min(remainingToOrder, totalVendorStock);
              const hasStockShortage =
                remainingToOrder > 0 && orderableQty < remainingToOrder;
              const noVendorStock = remainingToOrder > 0 && orderableQty === 0;
              const estCost =
                best?.unitCost && orderableQty > 0
                  ? best.unitCost * orderableQty
                  : null;
              const woIds = g.workOrders.map((w) => w.workOrderId);
              const allSelected =
                woIds.length > 0 && woIds.every((id) => selected.has(id));
              const someSelected = woIds.some((id) => selected.has(id));

              return (
                <AccordionItem
                  key={g.productId}
                  value={String(g.productId)}
                  className="border rounded-md px-3"
                >
                  <AccordionTrigger className="py-3 hover:no-underline">
                    <div className="flex items-center gap-3 text-left flex-1 flex-wrap">
                      <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-sm">
                        {g.productName}
                      </span>
                      <Badge
                        variant="destructive"
                        className="text-xs font-mono"
                      >
                        short {g.totalShortfall.toLocaleString()}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {g.workOrders.length} WO
                        {g.workOrders.length !== 1 ? "s" : ""} blocked
                      </Badge>
                      <span className="text-xs text-muted-foreground font-mono">
                        need {g.totalNeeded.toLocaleString()} · have{" "}
                        {g.totalAvailable.toLocaleString()}
                      </span>
                      {totalOnOrder > 0 && (
                        <Badge
                          variant="outline"
                          className="text-xs gap-1 border-primary/40 text-primary"
                        >
                          <Truck className="h-3 w-3" />
                          incoming {totalOnOrder.toLocaleString()}
                        </Badge>
                      )}
                      {estCost !== null && (
                        <Badge
                          variant="secondary"
                          className="text-xs gap-1"
                          title={`${best!.unitCost.toFixed(2)}/ea from ${best!.vendorName}`}
                        >
                          <DollarSign className="h-3 w-3" />~{fmtMoney(estCost)}
                        </Badge>
                      )}
                      {noVendorStock && !covered && (
                        <Badge
                          variant="outline"
                          className="text-xs gap-1 border-destructive/40 text-destructive"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          No vendor stock
                        </Badge>
                      )}
                      {hasStockShortage && !noVendorStock && !covered && (
                        <Badge
                          variant="outline"
                          className="text-xs gap-1 border-amber-500/40 text-amber-600"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          Vendors can supply {orderableQty.toLocaleString()}/
                          {remainingToOrder.toLocaleString()}
                        </Badge>
                      )}
                      {covered ? (
                        <Badge className="text-[10px] bg-green-100 text-green-800 ml-auto mr-4">
                          ✓ Covered by {totalOnOrder.toLocaleString()} on order
                        </Badge>
                      ) : noVendorStock ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto mr-4 h-7 gap-1 text-muted-foreground"
                          disabled
                        >
                          <ShoppingCart className="h-3 w-3" />
                          Out of stock
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="default"
                          className="ml-auto mr-4 h-7 gap-1"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(
                              `/supply?product=${g.productId}&qty=${orderableQty}`,
                            );
                          }}
                        >
                          <ShoppingCart className="h-3 w-3" />
                          Order {orderableQty.toLocaleString()}
                          {hasStockShortage && (
                            <span className="text-[10px] opacity-75">
                              /{remainingToOrder.toLocaleString()}
                            </span>
                          )}
                        </Button>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    {/* Cost preview */}
                    {best && remainingToOrder > 0 && (
                      <div
                        className={`mb-3 p-2 rounded text-xs space-y-0.5 ${noVendorStock ? "bg-destructive/5 border border-destructive/20" : "bg-muted/40"}`}
                      >
                        <p className="font-medium text-muted-foreground">
                          {noVendorStock
                            ? "⚠ No vendors have stock"
                            : "Cost preview"}
                        </p>
                        {noVendorStock ? (
                          <p className="text-destructive">
                            All {quotes.length} vendor
                            {quotes.length !== 1 ? "s" : ""} are out of stock
                            for this component. Stock will need to be
                            replenished before ordering.
                          </p>
                        ) : (
                          <>
                            <p>
                              <span className="font-mono">
                                ${best.unitCost.toFixed(2)}/ea
                              </span>
                              {" × "}
                              <span className="font-mono">
                                {orderableQty.toLocaleString()}
                              </span>
                              {" = "}
                              <span className="font-mono font-bold">
                                {fmtMoney(best.unitCost * orderableQty)}
                              </span>
                              {" — "}
                              <span className="text-muted-foreground">
                                {best.vendorName}
                              </span>
                              {(best.stockAvailable ?? 0) < orderableQty && (
                                <span className="ml-2 text-amber-600">
                                  (only {best.stockAvailable} in stock — will
                                  split across vendors)
                                </span>
                              )}
                            </p>
                            {hasStockShortage && (
                              <p className="text-amber-600">
                                ⚠ Vendors can only supply{" "}
                                {orderableQty.toLocaleString()} of{" "}
                                {remainingToOrder.toLocaleString()} needed
                              </p>
                            )}
                            {next && (
                              <p className="text-muted-foreground">
                                Next:{" "}
                                <span className="font-mono">
                                  ${next.unitCost.toFixed(2)}/ea
                                </span>{" "}
                                — {next.vendorName}
                                {(next.stockAvailable ?? 0) > 0 &&
                                  ` (${next.stockAvailable} in stock)`}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {orders.length > 0 && (
                      <div className="mb-3 p-2 bg-muted/40 rounded space-y-1">
                        <p className="text-xs font-medium text-muted-foreground mb-1">
                          On order ({totalOnOrder.toLocaleString()} total)
                        </p>
                        {orders.map((o, idx) => {
                          const eta = o.estimatedDeliveryUtc || null;
                          return (
                            <div
                              key={idx}
                              className="flex items-center gap-1.5 text-xs flex-wrap"
                            >
                              <Truck className="h-3 w-3 text-primary shrink-0" />
                              <span className="font-mono font-medium">
                                {o.qty}×
                              </span>
                              <span className="text-muted-foreground">
                                from {o.vendorName}
                              </span>
                              <Badge className="text-[10px] px-1.5 py-0">
                                {o.status}
                              </Badge>
                              <span className="font-medium text-muted-foreground">
                                {formatIncomingEta(eta)}
                              </span>
                              {eta && (
                                <span className="text-[10px] text-muted-foreground/80 font-mono">
                                  ({formatUtcTime(eta)})
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8">
                            <Checkbox
                              checked={allSelected}
                              onCheckedChange={(v) => toggleGroup(woIds, !!v)}
                              aria-label="Select all WOs in group"
                            />
                          </TableHead>
                          <TableHead>WO #</TableHead>
                          <TableHead className="text-right">
                            Order Qty
                          </TableHead>
                          <TableHead className="text-right">Stocked</TableHead>
                          <TableHead className="text-right">
                            Component Need
                          </TableHead>
                          <TableHead className="text-right">
                            Shortfall
                          </TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {g.workOrders
                          .sort((a, b) => b.shortfall - a.shortfall)
                          .map((s) => {
                            const wo = woById.get(s.workOrderId);
                            return (
                              <TableRow
                                key={s.workOrderId}
                                data-state={
                                  selected.has(s.workOrderId)
                                    ? "selected"
                                    : undefined
                                }
                              >
                                <TableCell>
                                  <Checkbox
                                    checked={selected.has(s.workOrderId)}
                                    onCheckedChange={() =>
                                      toggle(s.workOrderId)
                                    }
                                    aria-label={`Select WO ${s.workOrderId}`}
                                  />
                                </TableCell>
                                <TableCell>
                                  <button
                                    className="text-[hsl(var(--doodle-blue))] hover:underline font-medium cursor-pointer"
                                    onClick={() =>
                                      navigate(
                                        `/plan/work-orders/${s.workOrderId}`,
                                      )
                                    }
                                  >
                                    #{s.workOrderId}
                                  </button>
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  {wo?.OrderQty ?? "—"}
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  {wo?.StockedQty ?? "—"}
                                </TableCell>
                                <TableCell className="text-right font-mono">
                                  {s.needed}
                                </TableCell>
                                <TableCell className="text-right font-mono text-destructive font-bold">
                                  {s.shortfall}
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex justify-end gap-1">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 gap-1 text-xs"
                                      onClick={() => openReduce(s.workOrderId)}
                                      disabled={!wo}
                                      title="Reduce OrderQty"
                                    >
                                      <Pencil className="h-3 w-3" /> Reduce
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      className="h-7 gap-1 text-xs"
                                      onClick={() =>
                                        setCancelOne(s.workOrderId)
                                      }
                                      title="Cancel work order"
                                    >
                                      <Ban className="h-3 w-3" /> Cancel
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                      </TableBody>
                    </Table>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </CardContent>
      </Card>

      {/* Sticky bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-background border-2 border-primary rounded-lg shadow-lg px-4 py-3 flex items-center gap-4">
          <div className="text-sm">
            <span className="font-bold">{selected.size}</span> WO
            {selected.size !== 1 ? "s" : ""} selected
            {bulkSavings.units > 0 && (
              <span className="text-muted-foreground">
                {" · "}frees ~{bulkSavings.units.toLocaleString()} units
                {bulkSavings.dollars > 0 &&
                  ` · saves ~${fmtMoney(bulkSavings.dollars)}`}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setBulkConfirm(true)}
            className="gap-1"
          >
            <Ban className="h-3 w-3" /> Cancel selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSelection}
            className="gap-1"
          >
            <X className="h-3 w-3" /> Clear
          </Button>
        </div>
      )}

      {/* Reduce dialog */}
      <Dialog
        open={!!reduceTarget}
        onOpenChange={(o) => !o && setReduceTarget(null)}
      >
        <DialogContent className="doodle-dialog max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-doodle">
              Reduce WO #{reduceTarget?.id}
            </DialogTitle>
            <DialogDescription>
              Current OrderQty:{" "}
              <span className="font-mono">{reduceTarget?.current}</span>
              {" · "}Already stocked:{" "}
              <span className="font-mono">{reduceTarget?.stocked}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">New OrderQty</label>
            <Input
              type="number"
              value={reduceValue}
              onChange={(e) => setReduceValue(e.target.value)}
              min={reduceTarget?.stocked ?? 0}
              max={reduceTarget?.current ?? 0}
            />
            <p className="text-xs text-muted-foreground">
              Setting OrderQty to {reduceTarget?.stocked ?? 0} (stocked) will
              close this WO immediately.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReduceTarget(null)}>
              Cancel
            </Button>
            <Button onClick={submitReduce} disabled={reduceMutation.isPending}>
              {reduceMutation.isPending ? "Saving…" : "Reduce"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel one dialog */}
      <Dialog
        open={cancelOne != null}
        onOpenChange={(o) => !o && setCancelOne(null)}
      >
        <DialogContent className="doodle-dialog max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-doodle">
              Cancel WO #{cancelOne}?
            </DialogTitle>
            <DialogDescription>
              This marks the work order as Rejected. Any stocked units remain in
              inventory. Consider reducing instead if you want to keep partial
              production.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOne(null)}>
              Keep WO
            </Button>
            <Button
              variant="destructive"
              onClick={submitCancelOne}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? "Cancelling…" : "Cancel WO"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk cancel dialog */}
      <Dialog open={bulkConfirm} onOpenChange={setBulkConfirm}>
        <DialogContent className="doodle-dialog max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-doodle">
              Cancel {selected.size} work orders?
            </DialogTitle>
            <DialogDescription>
              All selected WOs will be marked Rejected. Any already-stocked
              units stay in inventory.
              {bulkSavings.dollars > 0 && (
                <>
                  {" "}
                  Estimated material savings:{" "}
                  <span className="font-mono font-bold">
                    {fmtMoney(bulkSavings.dollars)}
                  </span>
                  .
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkConfirm(false)}>
              Keep them
            </Button>
            <Button
              variant="destructive"
              onClick={submitBulk}
              disabled={cancelMutation.isPending}
            >
              Cancel {selected.size} WOs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Re-Order All confirmation dialog */}
      <Dialog
        open={reorderAllConfirm}
        onOpenChange={(o) =>
          !o && !reorderAllInProgress && setReorderAllConfirm(false)
        }
      >
        <DialogContent className="doodle-dialog max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-doodle">
              Re-Order All Shortages
            </DialogTitle>
            <DialogDescription>
              {reorderAllFulfillable.length > 0
                ? `Place purchase orders for ${reorderAllFulfillable.length} product${reorderAllFulfillable.length !== 1 ? "s" : ""}. Orders will be split across multiple vendors when a single supplier cannot fulfil the full quantity.`
                : "No products can be ordered — all vendors are out of stock."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {reorderAllFulfillable.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Component</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Vendors</TableHead>
                    <TableHead className="text-right">Est. Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reorderAllFulfillable.map((item) => (
                    <TableRow key={item.productId}>
                      <TableCell className="text-sm">
                        {item.productName}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {item.fulfillableQty.toLocaleString()}
                        {item.fulfillableQty < item.remainingToOrder && (
                          <span className="text-muted-foreground text-xs">
                            /{item.remainingToOrder.toLocaleString()}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {item.quotes.filter((q) => q.stockAvailable > 0).length}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {fmtMoney(
                          (item.quotes.find((q) => q.stockAvailable > 0)
                            ?.unitCost ?? 0) * item.fulfillableQty,
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {reorderAllUnfulfillable.length > 0 && (
              <div className="mt-3 p-3 bg-destructive/5 border border-destructive/20 rounded-md">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <span className="text-sm font-medium text-destructive">
                    Cannot order — no vendor stock available
                  </span>
                </div>
                <div className="space-y-1">
                  {reorderAllUnfulfillable.map((item) => (
                    <div
                      key={item.productId}
                      className="flex items-center justify-between text-sm text-muted-foreground"
                    >
                      <span>{item.productName}</span>
                      <span className="font-mono">
                        {item.remainingToOrder.toLocaleString()} needed
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {reorderAllFulfillable.length > 0 && (
            <div className="flex justify-between items-center pt-2 border-t text-sm">
              <span className="text-muted-foreground">
                Total ({reorderAllFulfillable.length} product
                {reorderAllFulfillable.length !== 1 ? "s" : ""})
              </span>
              <span className="font-mono font-bold text-base">
                {fmtMoney(reorderAllFulfillableCost)}
              </span>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReorderAllConfirm(false)}
              disabled={reorderAllInProgress}
            >
              Cancel
            </Button>
            <Button
              onClick={submitReorderAll}
              disabled={
                reorderAllInProgress || reorderAllFulfillable.length === 0
              }
              className="gap-2"
            >
              {reorderAllInProgress ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Placing orders…
                </>
              ) : (
                <>
                  <PackagePlus className="h-4 w-4" />
                  Confirm — {fmtMoney(reorderAllFulfillableCost)}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ShortagesPanel;
