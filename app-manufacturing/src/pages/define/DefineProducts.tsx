import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import {
  fetchManufacturedProducts, deleteProduct,
  fetchProductModels, fetchProductSubcategories, fetchProductCategories,
} from '@/services/api';
import { useManufacturedProductIds } from '@/hooks/useManufacturedProductIds';
import { toast } from '@/hooks/use-toast';
import { TableSkeleton } from '@/components/LoadingSkeletons';
import CreateProductDialog from '@/components/CreateProductDialog';
import CreateModelDialog from '@/components/CreateModelDialog';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import type { Product } from '@/types/production';

type Status = 'Active' | 'Upcoming' | 'Ended' | 'Discontinued';

const getProductStatus = (p: Product): Status => {
  if (p.DiscontinuedDate) return 'Discontinued';
  if (p.SellEndDate && new Date(p.SellEndDate) < new Date()) return 'Ended';
  if (new Date(p.SellStartDate) > new Date()) return 'Upcoming';
  return 'Active';
};

const STATUSES: Status[] = ['Active', 'Upcoming', 'Ended', 'Discontinued'];

const DefineProducts = () => {
  const qc = useQueryClient();
  const { data: products, isLoading } = useQuery({ queryKey: ['manufactured-products'], queryFn: fetchManufacturedProducts });
  const { data: models } = useQuery({ queryKey: ['product-models'], queryFn: fetchProductModels });
  const { data: subcategories } = useQuery({ queryKey: ['product-subcategories'], queryFn: fetchProductSubcategories });
  const { data: categories } = useQuery({ queryKey: ['product-categories'], queryFn: fetchProductCategories });
  const { manufacturedIds, isLoading: idsLoading } = useManufacturedProductIds();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [groupByModel, setGroupByModel] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const deleteMut = useMutation({
    mutationFn: deleteProduct,
    onSuccess: () => { toast({ title: '✅ Product deleted' }); qc.invalidateQueries({ queryKey: ['manufactured-products'] }); },
    onError: (e) => toast({ title: '❌ Delete failed', description: String(e), variant: 'destructive' }),
  });

  const modelMap = useMemo(() => {
    const m = new Map<number, string>();
    models?.forEach(x => m.set(x.ProductModelID, x.Name));
    return m;
  }, [models]);

  const subcatToCategory = useMemo(() => {
    const m = new Map<number, number>();
    subcategories?.forEach(s => m.set(s.ProductSubcategoryID, s.ProductCategoryID));
    return m;
  }, [subcategories]);

  // Strict-manufactured finished goods only.
  const baseFiltered = useMemo(() => {
    if (!products) return [];
    return products.filter(p =>
      p.MakeFlag &&
      p.FinishedGoodsFlag &&
      manufacturedIds.has(p.ProductID)
    );
  }, [products, manufacturedIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return baseFiltered.filter(p => {
      if (q) {
        const hay = `${p.Name} ${p.ProductNumber} ${p.Color || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (categoryFilter !== 'all') {
        const catId = p.ProductSubcategoryID ? subcatToCategory.get(p.ProductSubcategoryID) : undefined;
        if (String(catId) !== categoryFilter) return false;
      }
      if (statusFilter !== 'all' && getProductStatus(p) !== statusFilter) return false;
      return true;
    });
  }, [baseFiltered, search, categoryFilter, statusFilter, subcatToCategory]);

  // Group products by model name (for grouped view).
  const grouped = useMemo(() => {
    const map = new Map<string, { modelId: number | null; modelName: string; items: Product[] }>();
    for (const p of filtered) {
      const key = p.ProductModelID ? `m${p.ProductModelID}` : 'none';
      const name = p.ProductModelID ? (modelMap.get(p.ProductModelID) || `Model ${p.ProductModelID}`) : '— No model —';
      if (!map.has(key)) map.set(key, { modelId: p.ProductModelID, modelName: name, items: [] });
      map.get(key)!.items.push(p);
    }
    return Array.from(map.values()).sort((a, b) => a.modelName.localeCompare(b.modelName));
  }, [filtered, modelMap]);

  const toggleCollapsed = (modelId: number | null) => {
    const key = modelId ?? -1;
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const activeFilters = [
    search && `"${search}"`,
    categoryFilter !== 'all' && `category: ${categories?.find(c => String(c.ProductCategoryID) === categoryFilter)?.Name}`,
    statusFilter !== 'all' && `status: ${statusFilter}`,
  ].filter(Boolean) as string[];

  const renderRow = (p: Product) => {
    const status = getProductStatus(p);
    const modelName = p.ProductModelID ? modelMap.get(p.ProductModelID) : null;
    return (
      <tr key={p.ProductID} className="border-b border-doodle-text/10 hover:bg-secondary/30">
        <td className="py-3 px-4">
          <Link to={`/define/products/${p.ProductID}`} className="text-doodle-blue hover:underline font-bold">{p.Name}</Link>
        </td>
        <td className="py-3 px-4">
          {p.ProductModelID && modelName ? (
            <Link to={`/define/models/${p.ProductModelID}`} className="text-doodle-blue hover:underline">{modelName}</Link>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-3 px-4 text-muted-foreground">{p.ProductNumber}</td>
        <td className="py-3 px-4">{p.Color || '—'}</td>
        <td className="text-right py-3 px-4">${p.StandardCost.toFixed(2)}</td>
        <td className="text-right py-3 px-4">${p.ListPrice.toFixed(2)}</td>
        <td className="text-center py-3 px-4">
          <span className={`inline-block px-2 py-0.5 text-xs border rounded ${status === 'Active' ? 'border-doodle-green text-doodle-green' : 'border-muted-foreground text-muted-foreground'}`}>{status}</span>
        </td>
        <td className="text-center py-3 px-4">
          <DeleteConfirmDialog
            title="Delete Product"
            description={`Permanently delete "${p.Name}" (${p.ProductNumber})? This cannot be undone.`}
            onConfirm={() => deleteMut.mutateAsync(p.ProductID)}
            isPending={deleteMut.isPending}
          />
        </td>
      </tr>
    );
  };

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">1. Define — Product Catalog</h1>
          <p className="font-doodle text-sm text-muted-foreground">Finished goods we actually build (BOM + routing on file).</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <CreateModelDialog />
            <CreateProductDialog />
          </div>
          <p className="font-doodle text-xs text-muted-foreground">Models group product variants — create one first if needed.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="doodle-card-static p-4 flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, number, color…"
              className="doodle-input w-full text-sm pl-9"
            />
          </div>
          <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="doodle-input text-sm">
            <option value="all">All categories</option>
            {categories?.sort((a, b) => a.Name.localeCompare(b.Name)).map(c => (
              <option key={c.ProductCategoryID} value={c.ProductCategoryID}>{c.Name}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="doodle-input text-sm">
            <option value="all">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <label className="font-doodle text-sm inline-flex items-center gap-2 cursor-pointer whitespace-nowrap">
          <input type="checkbox" checked={groupByModel} onChange={e => setGroupByModel(e.target.checked)} />
          Group by Model
        </label>
      </div>

      {(isLoading || idsLoading) ? (
        <TableSkeleton rows={10} cols={8} />
      ) : (
        <div className="doodle-card-static overflow-x-auto">
          <table className="w-full font-doodle text-sm">
            <thead>
              <tr className="border-b-2 border-doodle-text/20">
                <th className="text-left py-3 px-4">Name</th>
                <th className="text-left py-3 px-4">Model</th>
                <th className="text-left py-3 px-4">Number</th>
                <th className="text-left py-3 px-4">Color</th>
                <th className="text-right py-3 px-4">Std Cost</th>
                <th className="text-right py-3 px-4">List Price</th>
                <th className="text-center py-3 px-4">Status</th>
                <th className="text-center py-3 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {groupByModel
                ? grouped.flatMap(g => {
                    const key = g.modelId ?? -1;
                    const isCollapsed = collapsed.has(key);
                    const headerRow = (
                      <tr key={`g-${key}`} className="bg-secondary/40 border-b border-doodle-text/20">
                        <td colSpan={8} className="py-2 px-4">
                          <button
                            onClick={() => toggleCollapsed(g.modelId)}
                            className="font-doodle text-sm font-bold text-doodle-text inline-flex items-center gap-2 hover:text-doodle-blue"
                          >
                            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            {g.modelId ? (
                              <Link to={`/define/models/${g.modelId}`} className="hover:underline" onClick={e => e.stopPropagation()}>
                                {g.modelName}
                              </Link>
                            ) : g.modelName}
                            <span className="text-muted-foreground font-normal">({g.items.length})</span>
                          </button>
                        </td>
                      </tr>
                    );
                    return isCollapsed ? [headerRow] : [headerRow, ...g.items.map(renderRow)];
                  })
                : filtered.map(renderRow)}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">No products match the current filters.</td></tr>
              )}
            </tbody>
          </table>
          <div className="p-3 text-center font-doodle text-xs text-muted-foreground">
            Showing {filtered.length} of {baseFiltered.length} manufactured finished goods
            {activeFilters.length > 0 && <> · filtered by {activeFilters.join(', ')}</>}
          </div>
        </div>
      )}
    </div>
  );
};

export default DefineProducts;
