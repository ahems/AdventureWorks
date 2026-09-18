import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createProductModel, updateProductModel } from '@/services/api';
import { toast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus, Pencil } from 'lucide-react';
import type { ProductModel } from '@/types/production';

interface Props {
  model?: ProductModel; // if provided, edit mode
  onSuccess?: () => void;
}

const CreateModelDialog = ({ model, onSuccess }: Props) => {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const isEdit = !!model;

  const [form, setForm] = useState({
    Name: model?.Name || '',
    CatalogDescription: model?.CatalogDescription || '',
    Instructions: model?.Instructions || '',
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        Name: form.Name,
        CatalogDescription: form.CatalogDescription || null,
        Instructions: form.Instructions || null,
        ModifiedDate: new Date().toISOString(),
      };
      if (isEdit) {
        await updateProductModel(model.ProductModelID, body);
      } else {
        await createProductModel(body);
      }
    },
    onSuccess: () => {
      toast({ title: isEdit ? `✅ Updated model: ${form.Name}` : `✅ Created model: ${form.Name}` });
      qc.invalidateQueries({ queryKey: ['product-models'] });
      if (model) qc.invalidateQueries({ queryKey: ['product-model', model.ProductModelID] });
      setOpen(false);
      onSuccess?.();
    },
    onError: (e) => toast({ title: `❌ Failed to ${isEdit ? 'update' : 'create'} model`, description: String(e), variant: 'destructive' }),
  });

  const handleOpen = () => {
    if (model) {
      setForm({
        Name: model.Name,
        CatalogDescription: model.CatalogDescription || '',
        Instructions: model.Instructions || '',
      });
    }
    setOpen(true);
  };

  return (
    <>
      {isEdit ? (
        <button onClick={handleOpen} className="text-doodle-blue hover:text-doodle-blue/80 transition-colors" title="Edit">
          <Pencil className="w-4 h-4" />
        </button>
      ) : (
        <button onClick={handleOpen} className="doodle-button doodle-button-primary text-sm inline-flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New Model
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="doodle-dialog max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">
              {isEdit ? 'Edit Model' : 'Create New Model'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">Model Name *</label>
              <input value={form.Name} onChange={e => set('Name', e.target.value)} placeholder="e.g. HL Mountain Frame" className="doodle-input w-full text-sm mt-1" />
            </div>
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">Catalog Description</label>
              <textarea value={form.CatalogDescription} onChange={e => set('CatalogDescription', e.target.value)} placeholder="Optional catalog description..." className="doodle-input w-full text-sm mt-1 min-h-[80px]" />
            </div>
            <div>
              <label className="font-doodle text-xs font-bold text-doodle-text">Instructions</label>
              <textarea value={form.Instructions} onChange={e => set('Instructions', e.target.value)} placeholder="Optional manufacturing instructions..." className="doodle-input w-full text-sm mt-1 min-h-[80px]" />
            </div>
          </div>
          <DialogFooter>
            <button onClick={() => setOpen(false)} className="doodle-button text-sm">Cancel</button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!form.Name || mutation.isPending}
              className="doodle-button doodle-button-primary text-sm disabled:opacity-50"
            >
              {mutation.isPending ? (isEdit ? 'Saving...' : 'Creating...') : (isEdit ? 'Save Changes' : 'Create Model')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CreateModelDialog;
