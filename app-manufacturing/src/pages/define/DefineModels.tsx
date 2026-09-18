import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchProductModels, deleteProductModel, fetchManufacturedProducts } from '@/services/api';
import { useManufacturedProductIds } from '@/hooks/useManufacturedProductIds';
import { TableSkeleton } from '@/components/LoadingSkeletons';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import CreateModelDialog from '@/components/CreateModelDialog';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import { toast } from '@/hooks/use-toast';

const DefineModels = () => {
  const qc = useQueryClient();
  const { data: models, isLoading } = useQuery({ queryKey: ['product-models'], queryFn: fetchProductModels });
  const { data: mfgProducts } = useQuery({ queryKey: ['manufactured-products'], queryFn: fetchManufacturedProducts });
  const { manufacturedIds } = useManufacturedProductIds();

  const inUseModelIds = useMemo(() => {
    const s = new Set<number>();
    mfgProducts?.forEach(p => {
      if (p.ProductModelID && manufacturedIds.has(p.ProductID)) s.add(p.ProductModelID);
    });
    return s;
  }, [mfgProducts, manufacturedIds]);

  const deleteMut = useMutation({
    mutationFn: deleteProductModel,
    onSuccess: () => { toast({ title: '✅ Model deleted' }); qc.invalidateQueries({ queryKey: ['product-models'] }); },
    onError: (e) => toast({ title: '❌ Delete failed', description: String(e), variant: 'destructive' }),
  });

  const filtered = (models || []).filter(m => inUseModelIds.has(m.ProductModelID));

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/define" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Products
      </Link>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">Product Models</h1>
          <p className="font-doodle text-sm text-muted-foreground">Models in use by manufactured products.</p>
        </div>
        <CreateModelDialog />
      </div>




      {isLoading ? (
        <TableSkeleton rows={8} cols={5} />
      ) : (
        <div className="doodle-card-static overflow-x-auto">
          <table className="w-full font-doodle text-sm">
            <thead>
              <tr className="border-b-2 border-doodle-text/20">
                <th className="text-left py-3 px-4">ID</th>
                <th className="text-left py-3 px-4">Name</th>
                <th className="text-left py-3 px-4">Has Catalog</th>
                <th className="text-left py-3 px-4">Has Instructions</th>
                <th className="py-3 px-4 w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.ProductModelID} className="border-b border-doodle-text/10 hover:bg-secondary/30">
                  <td className="py-3 px-4">{m.ProductModelID}</td>
                  <td className="py-3 px-4 font-bold">
                    <Link to={`/define/models/${m.ProductModelID}`} className="text-doodle-blue hover:underline">
                      {m.Name}
                    </Link>
                  </td>
                  <td className="py-3 px-4">{m.CatalogDescription ? '✓' : '—'}</td>
                  <td className="py-3 px-4">{m.Instructions ? '✓' : '—'}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2 justify-center">
                      <CreateModelDialog model={m} />
                      <DeleteConfirmDialog
                        title="Delete Model"
                        description={`Delete "${m.Name}"? Products using this model will be unaffected but will lose the model association.`}
                        onConfirm={() => deleteMut.mutateAsync(m.ProductModelID)}
                        isPending={deleteMut.isPending}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">No models found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DefineModels;
