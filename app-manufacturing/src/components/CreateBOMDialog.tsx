import { useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createBOM, fetchManufacturedProducts, fetchUnitMeasures } from '@/services/api';
import { toast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

interface Props {
  assemblyProductId: number;
  assemblyProductName: string;
}

const CreateBOMDialog = ({ assemblyProductId, assemblyProductName }: Props) => {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data: products } = useQuery({ queryKey: ['manufactured-products'], queryFn: fetchManufacturedProducts });
  const { data: units } = useQuery({ queryKey: ['unit-measures'], queryFn: fetchUnitMeasures });

  const [form, setForm] = useState({ ComponentID: '', BOMLevel: '1', PerAssemblyQty: '1', UnitMeasureCode: 'EA' });
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: () => createBOM({
      ProductAssemblyID: assemblyProductId,
      ComponentID: parseInt(form.ComponentID),
      BOMLevel: parseInt(form.BOMLevel) || 1,
      PerAssemblyQty: parseFloat(form.PerAssemblyQty) || 1,
      UnitMeasureCode: form.UnitMeasureCode,
      StartDate: new Date().toISOString(),
      ModifiedDate: new Date().toISOString(),
    }),
    onSuccess: () => {
      toast({ title: '✅ BOM component added' });
      qc.invalidateQueries({ queryKey: ['active-bom'] });
      setOpen(false);
      setForm({ ComponentID: '', BOMLevel: '1', PerAssemblyQty: '1', UnitMeasureCode: 'EA' });
    },
    onError: (e) => toast({ title: '❌ Failed', description: String(e), variant: 'destructive' }),
  });

  const availableComponents = products?.filter(p => p.ProductID !== assemblyProductId) || [];

  return (
    <>
      <button onClick={() => setOpen(true)} className="doodle-button doodle-button-primary text-sm inline-flex items-center gap-1.5">
        <Plus className="w-4 h-4" /> Add Component
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="doodle-dialog max-w-md">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">Add Component to {assemblyProductName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">Component *</label>
              <select value={form.ComponentID} onChange={e => set('ComponentID', e.target.value)} className="doodle-input w-full text-sm mt-1">
                <option value="">Select component...</option>
                {availableComponents.map(p => <option key={p.ProductID} value={p.ProductID}>{p.Name} ({p.ProductNumber})</option>)}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">Qty per Assembly</label>
                <input type="number" step="0.01" value={form.PerAssemblyQty} onChange={e => set('PerAssemblyQty', e.target.value)} className="doodle-input w-full text-sm mt-1" />
              </div>
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">BOM Level</label>
                <input type="number" value={form.BOMLevel} onChange={e => set('BOMLevel', e.target.value)} className="doodle-input w-full text-sm mt-1" />
              </div>
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">Unit</label>
                <select value={form.UnitMeasureCode} onChange={e => set('UnitMeasureCode', e.target.value)} className="doodle-input w-full text-sm mt-1">
                  {units?.map(u => <option key={u.UnitMeasureCode} value={u.UnitMeasureCode}>{u.Name}</option>)}
                </select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="doodle-button text-sm">Cancel</button>
            <button onClick={() => mutation.mutate()} disabled={!form.ComponentID || mutation.isPending} className="doodle-button doodle-button-primary text-sm disabled:opacity-50">
              {mutation.isPending ? 'Adding...' : 'Add Component'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CreateBOMDialog;
