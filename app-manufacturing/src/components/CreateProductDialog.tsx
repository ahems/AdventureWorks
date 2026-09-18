import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createProduct, fetchProductModels, fetchManufacturedProducts } from '@/services/api';
import { useManufacturedProductIds } from '@/hooks/useManufacturedProductIds';
import { toast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

const CreateProductDialog = () => {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data: models } = useQuery({ queryKey: ['product-models'], queryFn: fetchProductModels, enabled: open });
  const { data: mfgProducts } = useQuery({ queryKey: ['manufactured-products'], queryFn: fetchManufacturedProducts, enabled: open });
  const { manufacturedIds } = useManufacturedProductIds();

  const inUseModelIds = useMemo(() => {
    const s = new Set<number>();
    mfgProducts?.forEach(p => {
      if (p.ProductModelID && manufacturedIds.has(p.ProductID)) s.add(p.ProductModelID);
    });
    return s;
  }, [mfgProducts, manufacturedIds]);


  const [form, setForm] = useState({
    Name: '', ProductNumber: '', Color: '', StandardCost: '0', ListPrice: '0',
    SafetyStockLevel: '100', ReorderPoint: '75', DaysToManufacture: '1',
    SellStartDate: new Date().toISOString().split('T')[0],
    ProductModelID: '',
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: () => createProduct({
      ...form,
      MakeFlag: true,
      FinishedGoodsFlag: false,
      StandardCost: parseFloat(form.StandardCost) || 0,
      ListPrice: parseFloat(form.ListPrice) || 0,
      SafetyStockLevel: parseInt(form.SafetyStockLevel) || 100,
      ReorderPoint: parseInt(form.ReorderPoint) || 75,
      DaysToManufacture: parseInt(form.DaysToManufacture) || 0,
      ProductModelID: form.ProductModelID ? parseInt(form.ProductModelID) : null,
      ModifiedDate: new Date().toISOString(),
    }),
    onSuccess: (p) => {
      toast({ title: `✅ Created product: ${p.Name}` });
      qc.invalidateQueries({ queryKey: ['manufactured-products'] });
      setOpen(false);
      setForm({ Name: '', ProductNumber: '', Color: '', StandardCost: '0', ListPrice: '0', SafetyStockLevel: '100', ReorderPoint: '75', DaysToManufacture: '1', SellStartDate: new Date().toISOString().split('T')[0], ProductModelID: '' });
    },
    onError: (e) => toast({ title: '❌ Failed to create product', description: String(e), variant: 'destructive' }),
  });

  return (
    <>
      <button onClick={() => setOpen(true)} className="doodle-button doodle-button-primary text-sm inline-flex items-center gap-1.5">
        <Plus className="w-4 h-4" /> New Product
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="doodle-dialog max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">Create New Product</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {[
              { label: 'Product Name *', key: 'Name', placeholder: 'e.g. Carbon Handlebar' },
              { label: 'Product Number *', key: 'ProductNumber', placeholder: 'e.g. CB-0001' },
              { label: 'Color', key: 'Color', placeholder: 'e.g. Black' },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <label className="font-doodle text-xs font-bold text-doodle-text">{label}</label>
                <input value={(form as Record<string, string>)[key]} onChange={e => set(key, e.target.value)} placeholder={placeholder} className="doodle-input w-full text-sm mt-1" />
              </div>
            ))}
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">Product Model</label>
              <select
                value={form.ProductModelID}
                onChange={e => set('ProductModelID', e.target.value)}
                className="doodle-input w-full text-sm mt-1"
              >
                <option value="">— None —</option>
                {models
                  ?.filter(m => inUseModelIds.has(m.ProductModelID))
                  .sort((a, b) => a.Name.localeCompare(b.Name))
                  .map(m => (
                    <option key={m.ProductModelID} value={m.ProductModelID}>{m.Name}</option>
                  ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Standard Cost', key: 'StandardCost', type: 'number' },
                { label: 'List Price', key: 'ListPrice', type: 'number' },
                { label: 'Safety Stock', key: 'SafetyStockLevel', type: 'number' },
                { label: 'Reorder Point', key: 'ReorderPoint', type: 'number' },
                { label: 'Days to Mfg', key: 'DaysToManufacture', type: 'number' },
              ].map(({ label, key, type }) => (
                <div key={key}>
                  <label className="font-doodle text-xs font-bold text-doodle-text">{label}</label>
                  <input type={type} value={(form as Record<string, string>)[key]} onChange={e => set(key, e.target.value)} className="doodle-input w-full text-sm mt-1" />
                </div>
              ))}
              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">Sell Start Date</label>
                <input type="date" value={form.SellStartDate} onChange={e => set('SellStartDate', e.target.value)} className="doodle-input w-full text-sm mt-1" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="doodle-button text-sm">Cancel</button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!form.Name || !form.ProductNumber || mutation.isPending}
              className="doodle-button doodle-button-primary text-sm disabled:opacity-50"
            >
              {mutation.isPending ? 'Creating...' : 'Create Product'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CreateProductDialog;
