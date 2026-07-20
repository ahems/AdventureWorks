import { useState } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import {
  beginManufacturingRun,
  fetchManufacturedProducts,
} from "@/services/api";
import { toast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";

const CreateWorkOrderDialog = () => {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data: products } = useQuery({
    queryKey: ["manufactured-products"],
    queryFn: fetchManufacturedProducts,
  });

  const [form, setForm] = useState({
    ProductID: "",
    OrderQty: "10",
    DueDate: "",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: () =>
      beginManufacturingRun({
        productId: parseInt(form.ProductID),
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
      setForm({ ProductID: "", OrderQty: "10", DueDate: "" });
    },
    onError: (e) =>
      toast({
        title: "❌ Failed",
        description: String(e),
        variant: "destructive",
      }),
  });

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="doodle-button doodle-button-primary text-sm inline-flex items-center gap-1.5"
      >
        <Plus className="w-4 h-4" /> New Work Order
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="doodle-dialog max-w-md"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">
              Start Manufacturing Run
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">
                Product *
              </label>
              <select
                value={form.ProductID}
                onChange={(e) => set("ProductID", e.target.value)}
                className="doodle-input w-full text-sm mt-1"
              >
                <option value="">Select product...</option>
                {products?.map((p) => (
                  <option key={p.ProductID} value={p.ProductID}>
                    {p.Name} ({p.ProductNumber})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">
                Order Quantity *
              </label>
              <input
                type="number"
                min="1"
                max="32767"
                value={form.OrderQty}
                onChange={(e) => set("OrderQty", e.target.value)}
                className="doodle-input w-full text-sm mt-1"
              />
              {parseInt(form.OrderQty) > 32767 && (
                <p
                  className="font-doodle text-xs text-doodle-accent mt-1"
                  role="alert"
                >
                  Max 32,767 units — warehouse smallint limit.
                </p>
              )}
            </div>
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">
                Due Date (optional)
              </label>
              <input
                type="date"
                value={form.DueDate}
                onChange={(e) => set("DueDate", e.target.value)}
                className="doodle-input w-full text-sm mt-1"
              />
            </div>
            <p className="font-doodle text-xs text-muted-foreground">
              This will create all required work orders and immediately start
              manufacturing on the shop floor.
            </p>
          </div>
          <DialogFooter>
            <button
              onClick={() => setOpen(false)}
              className="doodle-button text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={
                !form.ProductID ||
                mutation.isPending ||
                parseInt(form.OrderQty) > 32767 ||
                parseInt(form.OrderQty) < 1
              }
              className="doodle-button doodle-button-primary text-sm disabled:opacity-50"
            >
              {mutation.isPending ? "Starting..." : "Start Manufacturing Run"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CreateWorkOrderDialog;
