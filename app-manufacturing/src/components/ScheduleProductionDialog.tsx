import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { beginManufacturingRun } from "@/services/api";
import { toast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CalendarPlus, Info } from "lucide-react";
import type { Product } from "@/types/production";

export type SuggestionSource = "open-demand" | "history-30d" | "reorder-point";

interface Props {
  product: Product;
  currentQty: number;
  /** Optional override for the suggested order quantity (e.g. customer-demand shortfall). */
  suggestedQty?: number;
  /** Optional ISO date (YYYY-MM-DD) to prefill the due date. */
  suggestedDueDate?: string;
  /** Optional label/tooltip describing where the suggestion came from. */
  suggestionLabel?: string;
  /** Where the suggested qty came from. Defaults to reorder-point when not provided. */
  suggestionSource?: SuggestionSource;
  /** Optional explicit formula breakdown to render in the source badge tooltip. */
  suggestionFormula?: string;
  /** Controlled open state. When provided, parent owns open/close. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in Schedule trigger button (useful when the parent provides its own trigger). */
  hideTrigger?: boolean;
}

const SOURCE_META: Record<SuggestionSource, { label: string; cls: string }> = {
  "open-demand": {
    label: "Open demand",
    cls: "bg-doodle-accent/20 text-doodle-accent border-doodle-accent",
  },
  "history-30d": {
    label: "30-day history",
    cls: "bg-doodle-blue/20 text-doodle-blue border-doodle-blue",
  },
  "reorder-point": {
    label: "Reorder point",
    cls: "bg-doodle-green/20 text-doodle-green border-doodle-green",
  },
};

const ScheduleProductionDialog = ({
  product,
  currentQty,
  suggestedQty,
  suggestedDueDate,
  suggestionLabel,
  suggestionSource,
  suggestionFormula,
  open: controlledOpen,
  onOpenChange,
  hideTrigger,
}: Props) => {
  const effectiveSource: SuggestionSource =
    suggestionSource ??
    (suggestedQty && suggestedQty > 0 ? "open-demand" : "reorder-point");
  const sourceMeta = SOURCE_META[effectiveSource];
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (!isControlled) setInternalOpen(v);
    onOpenChange?.(v);
  };
  const qc = useQueryClient();

  const deficit = Math.max(0, product.SafetyStockLevel - currentQty);
  const fallbackSuggested = Math.max(deficit, product.ReorderPoint);
  const suggested =
    suggestedQty && suggestedQty > 0 ? suggestedQty : fallbackSuggested;

  const dueDefault =
    suggestedDueDate ||
    new Date(Date.now() + product.DaysToManufacture * 86400000)
      .toISOString()
      .split("T")[0];

  const [form, setForm] = useState({
    OrderQty: String(suggested),
    DueDate: dueDefault,
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Re-prefill the form whenever the dialog opens or the suggestion inputs change,
  // so auto-opens from a parent always show the latest calculated qty / due date.
  useEffect(() => {
    if (open) setForm({ OrderQty: String(suggested), DueDate: dueDefault });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggested, dueDefault]);

  const mutation = useMutation({
    mutationFn: () =>
      beginManufacturingRun({
        productId: product.ProductID,
        orderQty: parseInt(form.OrderQty) || 1,
        dueDate: form.DueDate || undefined,
      }),
    onSuccess: (result) => {
      toast({
        title: `✅ Manufacturing run started — WO #${result.rootWorkOrderId} (${result.totalWorkOrders} work orders)`,
      });
      qc.invalidateQueries({ queryKey: ["work-orders"] });
      qc.invalidateQueries({ queryKey: ["manufacturing-status"] });
      setOpen(false);
    },
    onError: (e) =>
      toast({
        title: "❌ Failed",
        description: String(e),
        variant: "destructive",
      }),
  });

  // Validation: due date must not be in the past, and must allow at least
  // DaysToManufacture lead time from today.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const earliestFeasible = new Date(
    today.getTime() + product.DaysToManufacture * 86400000,
  );
  const earliestFeasibleISO = earliestFeasible.toISOString().split("T")[0];
  const dueDateObj = form.DueDate ? new Date(form.DueDate + "T00:00:00") : null;
  const dueInPast = !!dueDateObj && dueDateObj < today;
  const dueTooSoon =
    !!dueDateObj && !dueInPast && dueDateObj < earliestFeasible;
  const orderQtyNum = parseInt(form.OrderQty);
  const orderQtyInvalid =
    !form.OrderQty || orderQtyNum < 1 || orderQtyNum > 32767;
  const orderQtyError =
    orderQtyNum > 32767 ? "Max 32,767 units — warehouse smallint limit." : null;
  const dueDateError = !form.DueDate
    ? "Due date is required."
    : dueInPast
      ? "Due date cannot be in the past."
      : dueTooSoon
        ? `Lead time is ${product.DaysToManufacture} day${product.DaysToManufacture === 1 ? "" : "s"} — earliest feasible due date is ${earliestFeasibleISO}.`
        : null;
  const canSubmit = !dueDateError && !orderQtyInvalid && !mutation.isPending;

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
          title="Schedule production run"
        >
          <CalendarPlus className="w-3.5 h-3.5" /> Schedule
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="doodle-dialog max-w-md">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">
              Schedule Production: {product.Name}
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
                <span className="text-muted-foreground">Deficit</span>
                <span className="font-bold text-doodle-accent">{deficit}</span>
              </div>
              <div className="flex justify-between font-doodle text-sm">
                <span className="text-muted-foreground">
                  Days to Manufacture
                </span>
                <span className="font-bold">{product.DaysToManufacture}</span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className="font-doodle text-xs font-bold text-doodle-text">
                  Order Quantity *
                </label>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-doodle border rounded cursor-help ${sourceMeta.cls}`}
                      >
                        Source: {sourceMeta.label}
                        <Info className="w-3 h-3 opacity-70" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="left"
                      className="max-w-xs font-doodle text-xs"
                    >
                      <p className="font-bold mb-1">{sourceMeta.label}</p>
                      <p className="whitespace-pre-line text-muted-foreground">
                        {suggestionFormula ??
                          (effectiveSource === "reorder-point"
                            ? `SafetyStock = ${product.SafetyStockLevel}\nOnHand = ${currentQty}\nDeficit = max(0, SafetyStock − OnHand)\n       = max(0, ${product.SafetyStockLevel} − ${currentQty}) = ${deficit}\nReorderPoint = ${product.ReorderPoint}\n\nSuggested = max(Deficit, ReorderPoint)\n          = max(${deficit}, ${product.ReorderPoint}) = ${suggested}`
                            : effectiveSource === "open-demand"
                              ? `Suggested = open shortfall = OpenQty − OnHand − WIP = ${suggested}`
                              : `Suggested = 30-day shortfall = Qty30d − OnHand − WIP = ${suggested}`)}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <input
                type="number"
                min="1"
                max="32767"
                value={form.OrderQty}
                onChange={(e) => set("OrderQty", e.target.value)}
                className={`doodle-input w-full text-sm mt-1 ${orderQtyError ? "border-doodle-accent" : ""}`}
              />
              {orderQtyError ? (
                <p
                  className="font-doodle text-xs text-doodle-accent mt-1"
                  role="alert"
                >
                  {orderQtyError}
                </p>
              ) : (
                <p className="font-doodle text-xs text-muted-foreground mt-1">
                  Suggested: {suggested}{" "}
                  {suggestionLabel
                    ? `(${suggestionLabel})`
                    : "(covers deficit + reorder point)"}
                </p>
              )}
            </div>
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">
                Due Date
              </label>
              <input
                type="date"
                value={form.DueDate}
                min={earliestFeasibleISO}
                onChange={(e) => set("DueDate", e.target.value)}
                aria-invalid={!!dueDateError}
                className={`doodle-input w-full text-sm mt-1 ${dueDateError ? "border-doodle-accent" : ""}`}
              />
              {dueDateError ? (
                <p
                  className="font-doodle text-xs text-doodle-accent mt-1"
                  role="alert"
                >
                  {dueDateError}
                </p>
              ) : (
                <p className="font-doodle text-xs text-muted-foreground mt-1">
                  Earliest feasible due date: {earliestFeasibleISO} (today +{" "}
                  {product.DaysToManufacture}d lead time)
                </p>
              )}
            </div>
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
              title={dueDateError ?? undefined}
              className="doodle-button doodle-button-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mutation.isPending ? "Starting..." : "Start Manufacturing Run"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ScheduleProductionDialog;
