import { useState } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { createWorkOrderRouting, fetchLocations } from "@/services/api";
import { toast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus } from "lucide-react";

interface Props {
  workOrderId: number;
  productId: number;
  existingOpSeqs: number[];
}

const CreateRoutingDialog = ({
  workOrderId,
  productId,
  existingOpSeqs,
}: Props) => {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data: locations } = useQuery({
    queryKey: ["locations"],
    queryFn: fetchLocations,
  });

  const nextOp =
    existingOpSeqs.length > 0 ? Math.max(...existingOpSeqs) + 1 : 1;
  const today = new Date().toISOString().split("T")[0];

  const [form, setForm] = useState({
    OperationSequence: String(nextOp),
    LocationID: "",
    PlannedCost: "0",
    ScheduledStartDate: today,
    ScheduledEndDate: today,
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: () =>
      createWorkOrderRouting({
        WorkOrderID: workOrderId,
        ProductID: productId,
        OperationSequence: parseInt(form.OperationSequence),
        LocationID: parseInt(form.LocationID),
        PlannedCost: parseFloat(form.PlannedCost) || 0,
        ScheduledStartDate: form.ScheduledStartDate,
        ScheduledEndDate: form.ScheduledEndDate,
        ModifiedDate: new Date().toISOString(),
      }),
    onSuccess: () => {
      toast({ title: "✅ Routing step added" });
      qc.invalidateQueries({ queryKey: ["wo-routing", workOrderId] });
      setOpen(false);
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
        <Plus className="w-4 h-4" /> Add Routing Step
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="doodle-dialog max-w-md"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">
              Add Routing Step to WO #{workOrderId}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">
                  Op Sequence *
                </label>
                <input
                  type="number"
                  min="1"
                  value={form.OperationSequence}
                  onChange={(e) => set("OperationSequence", e.target.value)}
                  className="doodle-input w-full text-sm mt-1"
                />
              </div>
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">
                  Location *
                </label>
                <select
                  value={form.LocationID}
                  onChange={(e) => set("LocationID", e.target.value)}
                  className="doodle-input w-full text-sm mt-1"
                >
                  <option value="">Select...</option>
                  {locations?.map((l) => (
                    <option key={l.LocationID} value={l.LocationID}>
                      {l.Name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">
                Planned Cost ($)
              </label>
              <input
                type="number"
                step="0.01"
                value={form.PlannedCost}
                onChange={(e) => set("PlannedCost", e.target.value)}
                className="doodle-input w-full text-sm mt-1"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">
                  Scheduled Start
                </label>
                <input
                  type="date"
                  value={form.ScheduledStartDate}
                  onChange={(e) => set("ScheduledStartDate", e.target.value)}
                  className="doodle-input w-full text-sm mt-1"
                />
              </div>
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">
                  Scheduled End
                </label>
                <input
                  type="date"
                  value={form.ScheduledEndDate}
                  onChange={(e) => set("ScheduledEndDate", e.target.value)}
                  className="doodle-input w-full text-sm mt-1"
                />
              </div>
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
              onClick={() => mutation.mutate()}
              disabled={!form.LocationID || mutation.isPending}
              className="doodle-button doodle-button-primary text-sm disabled:opacity-50"
            >
              {mutation.isPending ? "Adding..." : "Add Step"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CreateRoutingDialog;
