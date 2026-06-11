import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWorkOrders, updateWorkOrder, deleteWorkOrder, type ManufacturingStatus } from '@/services/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: number | null;
  productName: string;
  shortages: ManufacturingStatus['shortages'];
}

const BlockedWorkOrdersDialog: React.FC<Props> = ({ open, onOpenChange, productId, productName, shortages }) => {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const rows = useMemo(
    () => shortages.filter(s => s.productId === productId).sort((a, b) => b.shortfall - a.shortfall),
    [shortages, productId]
  );

  const { data: workOrders } = useQuery({
    queryKey: ['work-orders'],
    queryFn: fetchWorkOrders,
    staleTime: 30_000,
    enabled: open,
  });
  const woById = useMemo(() => {
    const m = new Map<number, { OrderQty: number; StockedQty: number }>();
    workOrders?.forEach(w => m.set(w.WorkOrderID, { OrderQty: w.OrderQty, StockedQty: w.StockedQty }));
    return m;
  }, [workOrders]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['manufacturing-status-vendor-detail'] });
    qc.invalidateQueries({ queryKey: ['manufacturing-status'] });
    qc.invalidateQueries({ queryKey: ['work-orders'] });
  };

  const cancelMutation = useMutation({
    mutationFn: (id: number) => deleteWorkOrder(id),
  });
  const reduceMutation = useMutation({
    mutationFn: ({ id, qty }: { id: number; qty: number }) => updateWorkOrder(id, { OrderQty: qty }),
  });

  const [reduceTarget, setReduceTarget] = useState<{ id: number; current: number; stocked: number } | null>(null);
  const [reduceValue, setReduceValue] = useState('');
  const [cancelOne, setCancelOne] = useState<number | null>(null);

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
      toast.error(`Quantity must be at least already-stocked (${reduceTarget.stocked})`);
      return;
    }
    if (qty >= reduceTarget.current) {
      toast.error('New quantity must be less than current OrderQty');
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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="doodle-dialog max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-doodle">Work orders blocked by {productName}</DialogTitle>
            <DialogDescription>
              Reduce a WO down to free up demand, or cancel it entirely. Reductions cannot go below the already-stocked quantity.
            </DialogDescription>
          </DialogHeader>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No blocked work orders.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>WO #</TableHead>
                  <TableHead className="text-right">Order Qty</TableHead>
                  <TableHead className="text-right">Stocked</TableHead>
                  <TableHead className="text-right">Component Need</TableHead>
                  <TableHead className="text-right">Shortfall</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(s => {
                  const wo = woById.get(s.workOrderId);
                  return (
                    <TableRow key={s.workOrderId}>
                      <TableCell>
                        <button
                          className="text-[hsl(var(--doodle-blue))] hover:underline font-medium"
                          onClick={() => navigate(`/plan/work-orders/${s.workOrderId}`)}
                        >
                          #{s.workOrderId}
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-mono">{wo?.OrderQty ?? '—'}</TableCell>
                      <TableCell className="text-right font-mono">{wo?.StockedQty ?? '—'}</TableCell>
                      <TableCell className="text-right font-mono">{s.needed}</TableCell>
                      <TableCell className="text-right font-mono text-destructive font-bold">{s.shortfall}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 text-xs"
                            onClick={() => openReduce(s.workOrderId)}
                            disabled={!wo}
                          >
                            <Pencil className="h-3 w-3" /> Reduce
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 gap-1 text-xs"
                            onClick={() => setCancelOne(s.workOrderId)}
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
          )}
        </DialogContent>
      </Dialog>

      {/* Reduce dialog */}
      <Dialog open={!!reduceTarget} onOpenChange={(o) => !o && setReduceTarget(null)}>
        <DialogContent className="doodle-dialog max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-doodle">Reduce WO #{reduceTarget?.id}</DialogTitle>
            <DialogDescription>
              Current OrderQty: <span className="font-mono">{reduceTarget?.current}</span>
              {' · '}Already stocked: <span className="font-mono">{reduceTarget?.stocked}</span>
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
              Setting OrderQty to {reduceTarget?.stocked ?? 0} (stocked) will close this WO immediately.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReduceTarget(null)}>Cancel</Button>
            <Button onClick={submitReduce} disabled={reduceMutation.isPending}>
              {reduceMutation.isPending ? 'Saving…' : 'Reduce'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel one dialog */}
      <Dialog open={cancelOne != null} onOpenChange={(o) => !o && setCancelOne(null)}>
        <DialogContent className="doodle-dialog max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-doodle">Cancel WO #{cancelOne}?</DialogTitle>
            <DialogDescription>
              This marks the work order as Rejected. Any stocked units remain in inventory.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOne(null)}>Keep WO</Button>
            <Button variant="destructive" onClick={submitCancelOne} disabled={cancelMutation.isPending}>
              {cancelMutation.isPending ? 'Cancelling…' : 'Cancel WO'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default BlockedWorkOrdersDialog;
