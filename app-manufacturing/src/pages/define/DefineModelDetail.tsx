import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchProductModel, fetchProductsByModel, fetchProducts, updateProduct } from '@/services/api';
import { ArrowLeft, LinkIcon, Unlink } from 'lucide-react';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import CreateModelDialog from '@/components/CreateModelDialog';
import { toast } from '@/hooks/use-toast';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { Product } from '@/types/production';

const DefineModelDetail = () => {
  const { id } = useParams();
  const modelId = Number(id);
  const qc = useQueryClient();

  const { data: model, isLoading } = useQuery({ queryKey: ['product-model', modelId], queryFn: () => fetchProductModel(modelId) });
  const { data: associatedProducts } = useQuery({ queryKey: ['products-by-model', modelId], queryFn: () => fetchProductsByModel(modelId) });
  const { data: allProducts } = useQuery({ queryKey: ['all-products'], queryFn: () => fetchProducts() });

  const [assignOpen, setAssignOpen] = useState(false);
  const [search, setSearch] = useState('');

  const unassignableProducts = allProducts?.filter(p => !p.ProductModelID || p.ProductModelID !== modelId) || [];
  const filtered = unassignableProducts.filter(p =>
    p.Name.toLowerCase().includes(search.toLowerCase()) || p.ProductNumber.toLowerCase().includes(search.toLowerCase())
  ).slice(0, 20);

  const assignMutation = useMutation({
    mutationFn: (product: Product) => updateProduct(product.ProductID, { ProductModelID: modelId, ModifiedDate: new Date().toISOString() }),
    onSuccess: (_, product) => {
      toast({ title: `✅ Assigned ${product.Name} to this model` });
      qc.invalidateQueries({ queryKey: ['products-by-model', modelId] });
      qc.invalidateQueries({ queryKey: ['all-products'] });
    },
    onError: (e) => toast({ title: '❌ Failed to assign', description: String(e), variant: 'destructive' }),
  });

  const unassignMutation = useMutation({
    mutationFn: (product: Product) => updateProduct(product.ProductID, { ProductModelID: null, ModifiedDate: new Date().toISOString() }),
    onSuccess: (_, product) => {
      toast({ title: `✅ Removed ${product.Name} from this model` });
      qc.invalidateQueries({ queryKey: ['products-by-model', modelId] });
      qc.invalidateQueries({ queryKey: ['all-products'] });
    },
    onError: (e) => toast({ title: '❌ Failed to remove', description: String(e), variant: 'destructive' }),
  });

  if (isLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;
  if (!model) return <div className="container mx-auto px-4 py-8 font-doodle">Model not found</div>;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/define/models" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Models
      </Link>

      <div className="doodle-card-static p-6">
        <div className="flex flex-col md:flex-row justify-between gap-4">
          <div>
            <h1 className="font-doodle text-2xl font-bold text-doodle-text">{model.Name}</h1>
            <p className="font-doodle text-xs text-muted-foreground mt-1">Model ID: {model.ProductModelID}</p>
          </div>
          <CreateModelDialog model={model} />
        </div>
        {model.CatalogDescription && (
          <div className="mt-4">
            <h3 className="font-doodle text-sm font-bold text-muted-foreground">Catalog Description</h3>
            <p className="font-doodle text-sm text-doodle-text mt-1">{model.CatalogDescription}</p>
          </div>
        )}
        {model.Instructions && (
          <div className="mt-4">
            <h3 className="font-doodle text-sm font-bold text-muted-foreground">Instructions</h3>
            <p className="font-doodle text-xs text-doodle-text/70 mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap">{model.Instructions.substring(0, 500)}...</p>
          </div>
        )}
      </div>

      {/* Associated Products */}
      <div className="doodle-card-static p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-doodle text-lg font-bold text-doodle-text">
            Associated Products ({associatedProducts?.length || 0})
          </h2>
          <button onClick={() => setAssignOpen(true)} className="doodle-button doodle-button-primary text-sm inline-flex items-center gap-1.5">
            <LinkIcon className="w-4 h-4" /> Assign Product
          </button>
        </div>

        {associatedProducts?.length ? (
          <table className="w-full font-doodle text-sm">
            <thead>
              <tr className="border-b-2 border-doodle-text/20">
                <th className="text-left py-2 px-3">Product</th>
                <th className="text-left py-2 px-3">Number</th>
                <th className="text-left py-2 px-3">Cost</th>
                <th className="text-left py-2 px-3">Price</th>
                <th className="py-2 px-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {associatedProducts.map(p => (
                <tr key={p.ProductID} className="border-b border-doodle-text/10 hover:bg-secondary/30">
                  <td className="py-2 px-3">
                    <Link to={`/define/products/${p.ProductID}`} className="text-doodle-blue hover:underline font-bold">{p.Name}</Link>
                  </td>
                  <td className="py-2 px-3 text-muted-foreground">{p.ProductNumber}</td>
                  <td className="py-2 px-3">${p.StandardCost.toFixed(2)}</td>
                  <td className="py-2 px-3">${p.ListPrice.toFixed(2)}</td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() => unassignMutation.mutate(p)}
                      disabled={unassignMutation.isPending}
                      className="text-doodle-accent hover:text-doodle-accent/80 transition-colors"
                      title="Remove from model"
                    >
                      <Unlink className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="font-doodle text-sm text-muted-foreground">No products assigned to this model yet.</p>
        )}
      </div>

      {/* Assign Product Dialog */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="doodle-dialog max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">Assign Product to {model.Name}</DialogTitle>
          </DialogHeader>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search products..."
            className="doodle-input w-full text-sm"
          />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filtered.map(p => (
              <button
                key={p.ProductID}
                onClick={() => { assignMutation.mutate(p); setAssignOpen(false); }}
                className="w-full text-left px-3 py-2 rounded hover:bg-secondary/50 font-doodle text-sm flex justify-between items-center"
              >
                <span className="font-bold">{p.Name}</span>
                <span className="text-xs text-muted-foreground">{p.ProductNumber}</span>
              </button>
            ))}
            {filtered.length === 0 && <p className="font-doodle text-sm text-muted-foreground py-4 text-center">No unassigned products found</p>}
          </div>
          <DialogFooter>
            <button onClick={() => setAssignOpen(false)} className="doodle-button text-sm">Close</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DefineModelDetail;
