import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import {
  fetchProductCategories, fetchProductSubcategories, fetchProducts,
  fetchActiveBOM, beginManufacturingRun, fetchProductInventory, fetchWorkOrders,
} from '@/services/api';
import { useManufacturedProductIds } from '@/hooks/useManufacturedProductIds';
import type { ManufacturingBeginResponse } from '@/services/api';
import { fetchOrders } from '@/services/supplyChainApi';
import { toast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus, ChevronRight, Package, Layers, CheckCircle2, Loader2, AlertTriangle, Truck } from 'lucide-react';
import type { Product, BillOfMaterials } from '@/types/production';
import { Skeleton } from '@/components/ui/skeleton';

interface BomNode {
  productId: number;
  productName: string;
  qty: number;
  bomLevel: number;
  children: BomNode[];
}

/** Walk the BOM tree for a given assembly product and build a dependency tree */
function buildBomTree(
  assemblyId: number,
  bomRecords: BillOfMaterials[],
  productMap: Map<number, Product>,
  parentQty: number,
  visited: Set<number>
): BomNode[] {
  if (visited.has(assemblyId)) return [];
  visited.add(assemblyId);

  const children = bomRecords.filter(b => b.ProductAssemblyID === assemblyId);
  return children
    .filter(b => {
      const comp = productMap.get(b.ComponentID);
      return comp?.MakeFlag;
    })
    .map(b => {
      const comp = productMap.get(b.ComponentID)!;
      const qty = Math.ceil(b.PerAssemblyQty * parentQty);
      return {
        productId: comp.ProductID,
        productName: comp.Name,
        qty,
        bomLevel: b.BOMLevel,
        children: buildBomTree(comp.ProductID, bomRecords, productMap, qty, new Set(visited)),
      };
    });
}

/** Count total manufactured nodes in tree */
function countNodes(nodes: BomNode[]): number {
  let c = 0;
  for (const n of nodes) {
    c += 1 + countNodes(n.children);
  }
  return c;
}

type Step = 'category' | 'subcategory' | 'product' | 'review' | 'submitting' | 'result';

interface CreateProductionOrderDialogProps {
  /** If provided, renders as a custom trigger instead of the default button */
  trigger?: React.ReactNode;
  /** Pre-select a product by ID and skip to review step */
  prefillProductId?: number;
  /** Pre-fill the order quantity */
  prefillQty?: number;
  /** Called when production is successfully initiated */
  onSuccess?: () => void;
}

const CreateProductionOrderDialog: React.FC<CreateProductionOrderDialogProps> = ({
  trigger,
  prefillProductId,
  prefillQty,
  onSuccess,
}) => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('category');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [subcategoryId, setSubcategoryId] = useState<number | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [orderQty, setOrderQty] = useState('1');
  
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ManufacturingBeginResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: categories } = useQuery({ queryKey: ['product-categories'], queryFn: fetchProductCategories });
  const { data: subcategories } = useQuery({ queryKey: ['product-subcategories'], queryFn: fetchProductSubcategories });
  const { data: allProducts } = useQuery({ queryKey: ['all-products'], queryFn: () => fetchProducts() });
  const { data: activeBom } = useQuery({ queryKey: ['active-bom'], queryFn: fetchActiveBOM });
  const { assembledIds: manufacturedIds, routedIds } = useManufacturedProductIds();
  const { data: inventory, isFetching: isFetchingInventory } = useQuery({ queryKey: ['product-inventory-all'], queryFn: () => fetchProductInventory() });
  const { data: allWorkOrders, isFetching: isFetchingWorkOrders } = useQuery({ queryKey: ['work-orders'], queryFn: fetchWorkOrders });
  const isWipRefreshing = isFetchingInventory || isFetchingWorkOrders;

  const stockByProduct = useMemo(() => {
    const m = new Map<number, number>();
    inventory?.forEach(inv => m.set(inv.ProductID, (m.get(inv.ProductID) || 0) + (inv.Quantity || 0)));
    return m;
  }, [inventory]);

  // Fetch active supply chain orders to cross-reference with shortfall warnings
  const { data: supplyOrders } = useQuery({
    queryKey: ['supply-orders'],
    queryFn: fetchOrders,
    enabled: step === 'result' && !!result && result.warnings.length > 0,
  });

  // Map productId → total qty on order (active orders only)
  const onOrderByProduct = useMemo(() => {
    const map = new Map<number, number>();
    if (!supplyOrders) return map;
    for (const o of supplyOrders) {
      if (o.status === 'complete' || o.status === 'rejected') continue;
      map.set(o.productId, (map.get(o.productId) || 0) + o.qty);
    }
    return map;
  }, [supplyOrders]);

  const productMap = useMemo(() => {
    const m = new Map<number, Product>();
    allProducts?.forEach(p => m.set(p.ProductID, p));
    return m;
  }, [allProducts]);

  // Strict "really manufactured" filtering provided by useManufacturedProductIds.

  const filteredSubcategories = useMemo(() =>
    subcategories?.filter(sc => sc.ProductCategoryID === categoryId) || [],
    [subcategories, categoryId]
  );

  const filteredProducts = useMemo(() =>
    allProducts?.filter(p =>
      p.ProductSubcategoryID === subcategoryId &&
      p.MakeFlag &&
      p.FinishedGoodsFlag &&
      manufacturedIds.has(p.ProductID) &&
      routedIds.has(p.ProductID)
    ).sort((a, b) => {
      const sa = stockByProduct.get(a.ProductID) || 0;
      const sb = stockByProduct.get(b.ProductID) || 0;
      if (sa !== sb) return sa - sb;
      return a.Name.localeCompare(b.Name);
    }) || [],
    [allProducts, subcategoryId, stockByProduct, manufacturedIds, routedIds]
  );

  const bomTree = useMemo(() => {
    if (!selectedProduct || !activeBom) return [];
    return buildBomTree(selectedProduct.ProductID, activeBom, productMap, parseInt(orderQty) || 1, new Set());
  }, [selectedProduct, activeBom, productMap, orderQty]);

  const estimatedWorkOrders = useMemo(() => countNodes(bomTree) + 1, [bomTree]);

  /** Flatten BOM tree to (productId -> qty) collapsed across duplicates */
  const plannedByProduct = useMemo(() => {
    const m = new Map<number, number>();
    const topQty = parseInt(orderQty) || 1;
    if (selectedProduct) m.set(selectedProduct.ProductID, topQty);
    const walk = (nodes: BomNode[]) => {
      for (const n of nodes) {
        m.set(n.productId, (m.get(n.productId) || 0) + n.qty);
        walk(n.children);
      }
    };
    walk(bomTree);
    return m;
  }, [bomTree, selectedProduct, orderQty]);

  /** Open WIP per product across the planned set */
  const wipImpact = useMemo(() => {
    if (!selectedProduct || !allWorkOrders) {
      return { rows: [] as Array<{ productId: number; name: string; openWos: number; openUnits: number; addedUnits: number; isTop: boolean }>, totalOpenWos: 0, totalOpenUnits: 0, totalAddedUnits: 0 };
    }
    const openByProduct = new Map<number, { openWos: number; openUnits: number }>();
    for (const wo of allWorkOrders) {
      const remaining = wo.OrderQty - wo.StockedQty;
      if (remaining <= 0) continue; // treat StockedQty >= OrderQty as completed
      const cur = openByProduct.get(wo.ProductID) || { openWos: 0, openUnits: 0 };
      cur.openWos += 1;
      cur.openUnits += remaining;
      openByProduct.set(wo.ProductID, cur);
    }
    const rows = Array.from(plannedByProduct.entries()).map(([pid, qty]) => {
      const open = openByProduct.get(pid) || { openWos: 0, openUnits: 0 };
      return {
        productId: pid,
        name: productMap.get(pid)?.Name || `#${pid}`,
        openWos: open.openWos,
        openUnits: open.openUnits,
        addedUnits: qty,
        isTop: pid === selectedProduct.ProductID,
      };
    });
    rows.sort((a, b) => (a.isTop === b.isTop ? a.name.localeCompare(b.name) : a.isTop ? -1 : 1));
    return {
      rows,
      totalOpenWos: rows.reduce((s, r) => s + r.openWos, 0),
      totalOpenUnits: rows.reduce((s, r) => s + r.openUnits, 0),
      totalAddedUnits: rows.reduce((s, r) => s + r.addedUnits, 0),
    };
  }, [allWorkOrders, plannedByProduct, productMap, selectedProduct]);

  const reset = useCallback(() => {
    setStep('category');
    setCategoryId(null);
    setSubcategoryId(null);
    setSelectedProduct(null);
    setOrderQty('1');
    
    setResult(null);
    setError(null);
    setSubmitting(false);
  }, []);

  const handleOpen = useCallback(() => {
    reset();
    // If prefill product is available, jump to review
    if (prefillProductId && allProducts) {
      const product = allProducts.find(p => p.ProductID === prefillProductId);
      if (product) {
        setSelectedProduct(product);
        setOrderQty(String(prefillQty || Math.max(product.ReorderPoint || 0, 1)));
        // Set category/subcategory for breadcrumb
        if (product.ProductSubcategoryID) {
          const sub = subcategories?.find(sc => sc.ProductSubcategoryID === product.ProductSubcategoryID);
          if (sub) {
            setCategoryId(sub.ProductCategoryID);
            setSubcategoryId(sub.ProductSubcategoryID);
          }
        }
        setStep('review');
      }
    }
    // Force-refresh WIP-relevant data so recently started runs appear immediately
    qc.invalidateQueries({ queryKey: ['work-orders'] });
    qc.invalidateQueries({ queryKey: ['product-inventory-all'] });
    setOpen(true);
  }, [reset, prefillProductId, prefillQty, allProducts, subcategories, qc]);

  const handleSubmit = useCallback(async () => {
    if (!selectedProduct) return;
    setStep('submitting');
    setSubmitting(true);
    setError(null);

    try {
      const res = await beginManufacturingRun({
        productId: selectedProduct.ProductID,
        orderQty: parseInt(orderQty) || 1,
      });
      setResult(res);
      setStep('result');
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      toast({ title: `✅ Production run started — ${res.totalWorkOrders} work orders created` });
      onSuccess?.();
    } catch (e) {
      setError(String(e));
      setStep('review');
      toast({ title: '❌ Failed to start production run', description: String(e), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }, [selectedProduct, orderQty, qc]);

  const selectedCategory = categories?.find(c => c.ProductCategoryID === categoryId);
  const selectedSubcategory = subcategories?.find(sc => sc.ProductSubcategoryID === subcategoryId);

  return (
    <>
      {trigger ? (
        <span onClick={handleOpen} className="cursor-pointer">{trigger}</span>
      ) : (
        <button onClick={handleOpen} className="doodle-button doodle-button-primary text-sm inline-flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New Production Order
        </button>
      )}
      <Dialog open={open} onOpenChange={(v) => { if (!v && step !== 'submitting') { setOpen(false); } }}>
        <DialogContent className="doodle-dialog max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">
              {step === 'submitting' ? 'Starting Production Run...' :
               step === 'result' ? 'Production Run Started' :
               'New Production Order'}
            </DialogTitle>
          </DialogHeader>

          {/* Breadcrumb */}
          {!['submitting', 'result'].includes(step) && (
            <div className="flex items-center gap-1 text-xs font-doodle text-muted-foreground flex-wrap">
              <button
                onClick={() => { setStep('category'); setCategoryId(null); setSubcategoryId(null); setSelectedProduct(null); }}
                className={`hover:text-doodle-blue ${step === 'category' ? 'text-doodle-text font-bold' : ''}`}
              >
                Category
              </button>
              {categoryId != null && (
                <>
                  <ChevronRight className="w-3 h-3" />
                  <button
                    onClick={() => { setStep('subcategory'); setSubcategoryId(null); setSelectedProduct(null); }}
                    className={`hover:text-doodle-blue ${step === 'subcategory' ? 'text-doodle-text font-bold' : ''}`}
                  >
                    {selectedCategory?.Name}
                  </button>
                </>
              )}
              {subcategoryId != null && (
                <>
                  <ChevronRight className="w-3 h-3" />
                  <button
                    onClick={() => { setStep('product'); setSelectedProduct(null); }}
                    className={`hover:text-doodle-blue ${step === 'product' ? 'text-doodle-text font-bold' : ''}`}
                  >
                    {selectedSubcategory?.Name}
                  </button>
                </>
              )}
              {selectedProduct && (
                <>
                  <ChevronRight className="w-3 h-3" />
                  <span className="text-doodle-text font-bold">{selectedProduct.Name}</span>
                </>
              )}
            </div>
          )}

          {/* Step 1: Category */}
          {step === 'category' && (
            <div className="space-y-2">
              <p className="font-doodle text-sm text-muted-foreground">Select a product category:</p>
              <div className="grid grid-cols-2 gap-2">
                {categories?.sort((a, b) => a.Name.localeCompare(b.Name)).map(cat => (
                  <button
                    key={cat.ProductCategoryID}
                    onClick={() => { setCategoryId(cat.ProductCategoryID); setStep('subcategory'); }}
                    className="doodle-card-static p-3 text-left hover:border-doodle-blue transition-colors cursor-pointer"
                  >
                    <div className="font-doodle text-sm font-bold text-doodle-text">{cat.Name}</div>
                    <div className="font-doodle text-xs text-muted-foreground mt-1">
                      {subcategories?.filter(sc => sc.ProductCategoryID === cat.ProductCategoryID).length || 0} subcategories
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Subcategory */}
          {step === 'subcategory' && (
            <div className="space-y-2">
              <p className="font-doodle text-sm text-muted-foreground">Select a subcategory:</p>
              <div className="grid grid-cols-2 gap-2">
                {filteredSubcategories.sort((a, b) => a.Name.localeCompare(b.Name)).map(sc => {
                  const count = allProducts?.filter(p =>
                    p.ProductSubcategoryID === sc.ProductSubcategoryID && p.MakeFlag && p.FinishedGoodsFlag && manufacturedIds.has(p.ProductID) && routedIds.has(p.ProductID)
                  ).length || 0;
                  return (
                    <button
                      key={sc.ProductSubcategoryID}
                      onClick={() => { setSubcategoryId(sc.ProductSubcategoryID); setStep('product'); }}
                      className="doodle-card-static p-3 text-left hover:border-doodle-blue transition-colors cursor-pointer"
                      disabled={count === 0}
                    >
                      <div className="font-doodle text-sm font-bold text-doodle-text">{sc.Name}</div>
                      <div className="font-doodle text-xs text-muted-foreground mt-1">
                        {count} finished product{count !== 1 ? 's' : ''}
                      </div>
                    </button>
                  );
                })}
                {filteredSubcategories.length === 0 && (
                  <p className="col-span-2 font-doodle text-sm text-muted-foreground text-center py-4">No subcategories found</p>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Product */}
          {step === 'product' && (
            <div className="space-y-2">
              <p className="font-doodle text-sm text-muted-foreground">Select a finished product to manufacture:</p>
              <div className="space-y-1 max-h-[300px] overflow-y-auto">
                {filteredProducts.map(p => {
                  const stock = stockByProduct.get(p.ProductID) || 0;
                  const low = stock < p.ReorderPoint;
                  const out = stock === 0;
                  return (
                    <button
                      key={p.ProductID}
                      onClick={() => {
                        setSelectedProduct(p);
                        setOrderQty(String(Math.max(p.ReorderPoint || 0, 1)));
                        setStep('review');
                      }}
                      className="doodle-card-static p-3 w-full text-left hover:border-doodle-blue transition-colors cursor-pointer flex items-center gap-3"
                    >
                      <Package className="w-4 h-4 text-doodle-blue shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-doodle text-sm font-bold text-doodle-text truncate">{p.Name}</div>
                        <div className="font-doodle text-xs text-muted-foreground">{p.ProductNumber} · ${p.ListPrice.toFixed(2)}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`font-doodle text-sm font-bold ${out ? 'text-doodle-accent' : low ? 'text-doodle-accent' : 'text-doodle-text'}`}>
                          {stock}
                        </div>
                        <div className="font-doodle text-[10px] text-muted-foreground uppercase tracking-wide">
                          {out ? 'out of stock' : low ? 'low stock' : 'in stock'}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {filteredProducts.length === 0 && (
                  <p className="font-doodle text-sm text-muted-foreground text-center py-4">No finished manufactured products in this subcategory</p>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Review & Configure */}
          {step === 'review' && selectedProduct && (() => {
            const stock = stockByProduct.get(selectedProduct.ProductID) || 0;
            const low = stock < selectedProduct.ReorderPoint;
            const out = stock === 0;
            return (
            <div className="space-y-4">
              <div className="doodle-card-static p-3 bg-secondary/30 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-doodle text-sm font-bold text-doodle-text">{selectedProduct.Name}</div>
                  <div className="font-doodle text-xs text-muted-foreground">{selectedProduct.ProductNumber} · Days to manufacture: {selectedProduct.DaysToManufacture}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`font-doodle text-base font-bold ${out || low ? 'text-doodle-accent' : 'text-doodle-text'}`}>{stock}</div>
                  <div className="font-doodle text-[10px] text-muted-foreground uppercase tracking-wide">
                    {out ? 'out of stock' : low ? 'low stock' : 'in stock'} · reorder {selectedProduct.ReorderPoint}
                  </div>
                </div>
              </div>

              <div>
                <label className="font-doodle text-xs font-bold text-doodle-text">Quantity</label>
                <input type="number" min="1" value={orderQty} onChange={e => setOrderQty(e.target.value)} className="doodle-input w-full text-sm mt-1" />
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded border border-doodle-accent/30 bg-doodle-accent/5">
                  <AlertTriangle className="w-4 h-4 text-doodle-accent shrink-0 mt-0.5" />
                  <p className="font-doodle text-xs text-doodle-accent">{error}</p>
                </div>
              )}

              {/* BOM breakdown — informational */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Layers className="w-4 h-4 text-doodle-blue" />
                  <span className="font-doodle text-sm font-bold text-doodle-text">
                    Estimated Work Orders: ~{estimatedWorkOrders}
                  </span>
                </div>
                <p className="font-doodle text-xs text-muted-foreground">
                  The API will explode the full BOM and create all required work orders for sub-assemblies and the final product, scheduling them in the correct dependency order.
                </p>
              </div>

              {/* WIP impact summary */}
              <div className="doodle-card-static p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-doodle text-sm font-bold text-doodle-text flex items-center gap-2">
                    Impact on current WIP
                    {isWipRefreshing && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="Refreshing WIP data" />
                    )}
                  </span>
                  <span className="font-doodle text-[11px] text-muted-foreground">
                    {isWipRefreshing ? 'Refreshing…' : `${wipImpact.totalOpenWos} open WO${wipImpact.totalOpenWos === 1 ? '' : 's'} → ~${wipImpact.totalOpenWos + estimatedWorkOrders} after`}
                  </span>
                </div>
                {isWipRefreshing ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="rounded border border-doodle-text/15 p-2 space-y-2">
                          <Skeleton className="h-3 w-16 mx-auto" />
                          <Skeleton className="h-5 w-12 mx-auto" />
                        </div>
                      ))}
                    </div>
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                    <Skeleton className="h-4 w-4/6" />
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2 text-center mb-3">
                      <div className="rounded border border-doodle-text/15 p-2">
                        <div className="font-doodle text-[10px] text-muted-foreground uppercase">Open units now</div>
                        <div className="font-doodle text-base font-bold text-doodle-text">{wipImpact.totalOpenUnits.toLocaleString()}</div>
                      </div>
                      <div className="rounded border border-doodle-text/15 p-2">
                        <div className="font-doodle text-[10px] text-muted-foreground uppercase">Adding</div>
                        <div className="font-doodle text-base font-bold text-doodle-blue">+{wipImpact.totalAddedUnits.toLocaleString()}</div>
                      </div>
                      <div className="rounded border border-doodle-text/15 p-2">
                        <div className="font-doodle text-[10px] text-muted-foreground uppercase">Projected</div>
                        <div className="font-doodle text-base font-bold text-doodle-text">{(wipImpact.totalOpenUnits + wipImpact.totalAddedUnits).toLocaleString()}</div>
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto">
                      <table className="w-full font-doodle text-xs">
                        <thead>
                          <tr className="text-muted-foreground border-b border-doodle-text/15">
                            <th className="text-left py-1 pr-2 font-medium">Product</th>
                            <th className="text-right py-1 px-2 font-medium">Open WOs</th>
                            <th className="text-right py-1 px-2 font-medium">Open units</th>
                            <th className="text-right py-1 pl-2 font-medium">Adding</th>
                            <th className="text-right py-1 pl-2 font-medium">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wipImpact.rows.map(r => (
                            <tr key={r.productId} className="border-b border-doodle-text/10">
                              <td className="py-1 pr-2 truncate max-w-[160px]">
                                {r.name}
                                {r.isTop && <span className="ml-1 text-[10px] text-doodle-blue">(top)</span>}
                              </td>
                              <td className="text-right py-1 px-2 font-mono">{r.openWos}</td>
                              <td className="text-right py-1 px-2 font-mono">{r.openUnits}</td>
                              <td className="text-right py-1 pl-2 font-mono text-doodle-blue">+{r.addedUnits}</td>
                              <td className="text-right py-1 pl-2 font-mono font-bold">{r.openUnits + r.addedUnits}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="font-doodle text-[11px] text-muted-foreground mt-2">
                      Open units = remaining (OrderQty − StockedQty) on work orders not yet completed. New WOs start at 0 stocked and add their full OrderQty to WIP.
                    </p>
                  </>
                )}
              </div>
            </div>
            );
          })()}

          {/* Submitting */}
          {step === 'submitting' && (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-doodle-blue" />
              <p className="font-doodle text-sm text-muted-foreground">
                Starting production run for {selectedProduct?.Name}...
              </p>
              <p className="font-doodle text-xs text-muted-foreground">
                The API is exploding the BOM, creating work orders and scheduling operations. This may take a moment if the backend is waking up.
              </p>
            </div>
          )}

          {/* Result */}
          {step === 'result' && result && (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-6 h-6 text-doodle-green shrink-0" />
                <div>
                  <p className="font-doodle text-sm font-bold text-doodle-text">Production run created successfully</p>
                  <p className="font-doodle text-xs text-muted-foreground">Run ID: {result.runId}</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="doodle-card-static p-3 text-center">
                  <div className="font-doodle text-lg font-bold text-doodle-blue">{result.totalWorkOrders}</div>
                  <div className="font-doodle text-xs text-muted-foreground">Total Work Orders</div>
                </div>
                <div className="doodle-card-static p-3 text-center">
                  <div className="font-doodle text-lg font-bold text-doodle-green">{result.leafWorkOrders}</div>
                  <div className="font-doodle text-xs text-muted-foreground">Started Processing</div>
                </div>
                <div className="doodle-card-static p-3 text-center">
                  <button
                    onClick={() => { setOpen(false); reset(); navigate(`/plan/work-orders/${result.rootWorkOrderId}`); }}
                    className="font-doodle text-lg font-bold text-doodle-blue hover:underline cursor-pointer"
                  >
                    #{result.rootWorkOrderId}
                  </button>
                  <div className="font-doodle text-xs text-muted-foreground">Root Work Order</div>
                </div>
              </div>

              {/* Warnings — inventory shortfalls */}
              {result.warnings.length > 0 && (() => {
                const coveredCount = result.warnings.filter(w => {
                  const onOrder = onOrderByProduct.get(w.productId) || 0;
                  return onOrder >= w.shortfall;
                }).length;
                return (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span className="font-doodle text-sm font-bold text-foreground">
                      Inventory Shortfalls ({result.warnings.length})
                      {coveredCount > 0 && (
                        <span className="text-primary font-normal ml-1">
                          — {coveredCount} covered by supplier orders
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="font-doodle text-xs text-muted-foreground">
                    These components have insufficient stock. Production will proceed and retry automatically until materials are available.
                  </p>
                  <div className="space-y-1 max-h-[200px] overflow-y-auto">
                    {result.warnings.map((w, i) => {
                      const onOrder = onOrderByProduct.get(w.productId) || 0;
                      const effectiveShortfall = Math.max(0, w.shortfall - onOrder);
                      return (
                        <div key={i} className={`flex items-center justify-between px-3 py-2 rounded text-xs font-doodle ${effectiveShortfall === 0 ? 'bg-primary/5 border border-primary/20' : 'bg-amber-500/5 border border-amber-500/20'}`}>
                          <span className="text-foreground truncate flex-1">{w.name}</span>
                          <span className="shrink-0 ml-2 flex items-center gap-2">
                            <span className={effectiveShortfall === 0 ? 'text-primary' : 'text-amber-600'}>
                              Need {w.required}, have {w.available}
                              {effectiveShortfall > 0 && ` (short ${effectiveShortfall})`}
                            </span>
                            {onOrder > 0 && (
                              <span className="inline-flex items-center gap-1 text-primary font-bold">
                                <Truck className="w-3 h-3" />
                                {onOrder} on order
                                {effectiveShortfall === 0 && ' ✓'}
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                );
              })()}

              {result.warnings.length === 0 && (
                <p className="font-doodle text-xs text-doodle-green flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  All required materials are in stock — production is underway.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            {step === 'result' ? (
              <button onClick={() => { setOpen(false); reset(); }} className="doodle-button doodle-button-primary text-sm">
                Done
              </button>
            ) : step === 'review' ? (
              <>
                <button onClick={() => setStep('product')} className="doodle-button text-sm">Back</button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="doodle-button doodle-button-primary text-sm disabled:opacity-50"
                >
                  Start Production Run
                </button>
              </>
            ) : step === 'submitting' ? null : (
              <button onClick={() => setOpen(false)} className="doodle-button text-sm">Cancel</button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CreateProductionOrderDialog;
