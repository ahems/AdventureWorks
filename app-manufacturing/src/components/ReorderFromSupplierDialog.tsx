import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchCatalog,
  placeOrder,
  type SupplyQuote,
} from "@/services/supplyChainApi";
import { toast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Truck } from "lucide-react";
import type { Product } from "@/types/production";

interface Props {
  product: Product;
  currentQty: number;
  suggestedQty: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}

const ReorderFromSupplierDialog = ({
  product,
  currentQty,
  suggestedQty,
  open: controlledOpen,
  onOpenChange,
  hideTrigger,
}: Props) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (!isControlled) setInternalOpen(v);
    onOpenChange?.(v);
  };
  const qc = useQueryClient();

  const suggested = Math.max(1, suggestedQty);
  const [qty, setQty] = useState(String(suggested));
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQty(String(suggested));
      setSelectedVendor(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggested]);

  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ["supply-catalog", product.ProductID],
    queryFn: () => fetchCatalog(product.ProductID),
    enabled: open,
  });

  // Auto-select best vendor (most stock, in stock, cheapest)
  useEffect(() => {
    if (catalog && catalog.length > 0 && !selectedVendor) {
      const best =
        [...catalog]
          .filter((q) => (q.inStock && q.stockAvailable >= parseInt(qty)) || 1)
          .sort((a, b) => a.unitCost - b.unitCost)[0] ?? catalog[0];
      setSelectedVendor(best.vendorId);
    }
  }, [catalog, selectedVendor, qty]);

  const chosenQuote = catalog?.find((q) => q.vendorId === selectedVendor);

  const mutation = useMutation({
    mutationFn: () => {
      if (!selectedVendor) throw new Error("No vendor selected");
      return placeOrder(selectedVendor, product.ProductID, parseInt(qty) || 1);
    },
    onSuccess: (order) => {
      toast({
        title: `✅ Purchase order placed — ${order.vendorName} × ${order.qty} units`,
      });
      qc.invalidateQueries({ queryKey: ["supply-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory-all"] });
      qc.invalidateQueries({ queryKey: ["open-demand"] });
      setOpen(false);
    },
    onError: (e) =>
      toast({
        title: "❌ Order failed",
        description: String(e),
        variant: "destructive",
      }),
  });

  const orderQtyInvalid = !qty || parseInt(qty) < 1;
  const canSubmit = !orderQtyInvalid && !!selectedVendor && !mutation.isPending;

  return (
    <>
      {!hideTrigger && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
          className="doodle-button doodle-button-primary text-xs inline-flex items-center gap-1 py-1 px-2"
          title="Re-order from supplier"
        >
          <Truck className="w-3.5 h-3.5" /> Re-order
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="doodle-dialog max-w-md">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">
              Re-order from Supplier: {product.Name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="doodle-card p-3 space-y-1">
              <div className="flex justify-between font-doodle text-sm">
                <span className="text-muted-foreground">Current Stock</span>
                <span className="font-bold text-doodle-accent">
                  {currentQty}
                </span>
              </div>
              <div className="flex justify-between font-doodle text-sm">
                <span className="text-muted-foreground">
                  Safety Stock Level
                </span>
                <span className="font-bold">{product.SafetyStockLevel}</span>
              </div>
              <div className="flex justify-between font-doodle text-sm">
                <span className="text-muted-foreground">Shortfall</span>
                <span className="font-bold text-doodle-accent">
                  {suggested}
                </span>
              </div>
              <p className="font-doodle text-[11px] text-muted-foreground italic">
                This product is purchased from suppliers (not manufactured
                in-house).
              </p>
            </div>

            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">
                Order Quantity *
              </label>
              <input
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="doodle-input w-full text-sm mt-1"
              />
              <p className="font-doodle text-xs text-muted-foreground mt-1">
                Suggested: {suggested} (covers open demand shortfall)
              </p>
            </div>

            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">
                Supplier
              </label>
              {catalogLoading ? (
                <p className="font-doodle text-xs text-muted-foreground mt-1">
                  Loading suppliers…
                </p>
              ) : !catalog || catalog.length === 0 ? (
                <p className="font-doodle text-xs text-doodle-accent mt-1">
                  No suppliers found for this product.
                </p>
              ) : (
                <div className="space-y-2 mt-1">
                  {catalog.map((q) => (
                    <label
                      key={q.vendorId}
                      className={`flex items-center gap-3 p-2 rounded border cursor-pointer transition-colors ${
                        selectedVendor === q.vendorId
                          ? "border-doodle-blue bg-doodle-blue/10"
                          : "border-doodle-text/10 hover:border-doodle-blue/50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="vendor"
                        checked={selectedVendor === q.vendorId}
                        onChange={() => setSelectedVendor(q.vendorId)}
                        className="accent-doodle-blue"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-doodle text-sm font-bold truncate">
                          {q.vendorName}
                        </div>
                        <div className="font-doodle text-[11px] text-muted-foreground">
                          ${q.unitCost.toFixed(2)}/unit · Stock:{" "}
                          {q.stockAvailable} · Lead: {q.leadTimeDays}d ·
                          Reliability: {q.reliabilityPct}%
                        </div>
                      </div>
                      {q.inStock ? (
                        <span className="text-[10px] font-doodle text-green-600 bg-green-100 px-1.5 py-0.5 rounded">
                          In stock
                        </span>
                      ) : (
                        <span className="text-[10px] font-doodle text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">
                          Low stock
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {chosenQuote && (
              <div className="doodle-card p-3">
                <div className="flex justify-between font-doodle text-sm">
                  <span className="text-muted-foreground">Estimated Cost</span>
                  <span className="font-bold">
                    ${(chosenQuote.unitCost * (parseInt(qty) || 1)).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between font-doodle text-sm">
                  <span className="text-muted-foreground">Est. Delivery</span>
                  <span className="font-bold">
                    {chosenQuote.leadTimeDays} day(s)
                  </span>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              onClick={() => setOpen(false)}
              className="doodle-button text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => canSubmit && mutation.mutate()}
              disabled={!canSubmit}
              className="doodle-button doodle-button-primary text-sm inline-flex items-center gap-1"
            >
              <Truck className="w-4 h-4" />
              {mutation.isPending ? "Placing order…" : "Place Purchase Order"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ReorderFromSupplierDialog;
