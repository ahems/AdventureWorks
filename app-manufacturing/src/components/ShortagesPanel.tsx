import React, { useMemo, useState } from "react";
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
          <CardTitle className="font-doodle">Material Shortages</CardTitle>
          <CardDescription>
            Grouped by missing component. Use Reduce to scale a WO down, or
            Cancel to remove it entirely.
          </CardDescription>
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
              const estCost = best?.unitCost
                ? best.unitCost * remainingToOrder
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
                      {estCost !== null && remainingToOrder > 0 && (
                        <Badge
                          variant="secondary"
                          className="text-xs gap-1"
                          title={`${best!.unitCost.toFixed(2)}/ea from ${best!.vendorName}`}
                        >
                          <DollarSign className="h-3 w-3" />~{fmtMoney(estCost)}
                        </Badge>
                      )}
                      {covered ? (
                        <Badge className="text-[10px] bg-green-100 text-green-800 ml-auto mr-4">
                          ✓ Covered by {totalOnOrder.toLocaleString()} on order
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="default"
                          className="ml-auto mr-4 h-7 gap-1"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(
                              `/supply?product=${g.productId}&qty=${remainingToOrder}`,
                            );
                          }}
                        >
                          <ShoppingCart className="h-3 w-3" />
                          Order {remainingToOrder.toLocaleString()}
                        </Button>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    {/* Cost preview */}
                    {best && remainingToOrder > 0 && (
                      <div className="mb-3 p-2 bg-muted/40 rounded text-xs space-y-0.5">
                        <p className="font-medium text-muted-foreground">
                          Cost preview
                        </p>
                        <p>
                          <span className="font-mono">
                            ${best.unitCost.toFixed(2)}/ea
                          </span>
                          {" × "}
                          <span className="font-mono">
                            {remainingToOrder.toLocaleString()}
                          </span>
                          {" = "}
                          <span className="font-mono font-bold">
                            {fmtMoney(best.unitCost * remainingToOrder)}
                          </span>
                          {" — "}
                          <span className="text-muted-foreground">
                            {best.vendorName}
                          </span>
                          {(best.stockAvailable ?? 0) < remainingToOrder && (
                            <span className="ml-2 text-destructive">
                              (only {best.stockAvailable} in stock)
                            </span>
                          )}
                        </p>
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
    </>
  );
};

export default ShortagesPanel;
