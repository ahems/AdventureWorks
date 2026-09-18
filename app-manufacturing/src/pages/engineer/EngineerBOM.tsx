import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchActiveBOM, fetchAllProducts, fetchProductCategories, fetchProductSubcategories, deleteBOM } from '@/services/api';
import { toast } from '@/hooks/use-toast';
import { ChevronRight, ChevronDown, ArrowLeft } from 'lucide-react';
import { SidebarListSkeleton, TableSkeleton } from '@/components/LoadingSkeletons';
import CreateBOMDialog from '@/components/CreateBOMDialog';
import BOMOverviewInsights from '@/components/bom-overview/BOMOverviewInsights';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import type { BillOfMaterials, Product, BomTreeNode } from '@/types/production';

function buildBomTree(
  bom: BillOfMaterials[],
  products: Map<number, Product>,
  parentId: number
): BomTreeNode[] {
  const children = bom.filter(b => b.ProductAssemblyID === parentId);
  return children.map(b => {
    const product = products.get(b.ComponentID);
    const childNodes = buildBomTree(bom, products, b.ComponentID);
    const childCost = childNodes.reduce((s, c) => s + c.totalCost, 0);
    const unitCost = product?.StandardCost || 0;
    const totalCost = (unitCost * b.PerAssemblyQty) + childCost;
    return {
      bomId: b.BillOfMaterialsID,
      componentId: b.ComponentID,
      componentName: product?.Name || `Component #${b.ComponentID}`,
      perAssemblyQty: b.PerAssemblyQty,
      unitMeasureCode: b.UnitMeasureCode,
      standardCost: unitCost,
      bomLevel: b.BOMLevel,
      children: childNodes,
      totalCost,
    };
  });
}

const TreeNode: React.FC<{ node: BomTreeNode; depth: number; onDelete: (id: number) => Promise<void> }> = ({ node, depth, onDelete }) => {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 px-2 hover:bg-secondary/30 rounded cursor-pointer"
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
        onClick={() => hasChildren && setOpen(!open)}
      >
        {hasChildren ? (
          open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Link to={`/define/products/${node.componentId}`} className="font-doodle text-sm text-doodle-blue hover:underline" onClick={(e) => e.stopPropagation()}>
          {node.componentName}
        </Link>
        <span className="font-doodle text-xs text-muted-foreground ml-auto flex gap-3 items-center">
          <span>×{node.perAssemblyQty} {node.unitMeasureCode}</span>
          <span>${node.standardCost.toFixed(2)}</span>
          <span className="font-bold text-doodle-green">${node.totalCost.toFixed(2)}</span>
          <span onClick={e => e.stopPropagation()}>
            <DeleteConfirmDialog title="Remove Component" description={`Remove "${node.componentName}" from this BOM?`} onConfirm={() => onDelete(node.bomId)} />
          </span>
        </span>
      </div>
      {open && node.children.map(child => (
        <TreeNode key={child.bomId} node={child} depth={depth + 1} onDelete={onDelete} />
      ))}
    </div>
  );
};

const EngineerBOM = () => {
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [selectedSubcategory, setSelectedSubcategory] = useState<number | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<number | null>(null);
  const qc = useQueryClient();

  const { data: bom, isLoading: bomLoading } = useQuery({ queryKey: ['active-bom'], queryFn: fetchActiveBOM });
  const { data: products, isLoading: productsLoading } = useQuery({ queryKey: ['all-products'], queryFn: fetchAllProducts });
  const { data: categories, isLoading: catsLoading } = useQuery({ queryKey: ['product-categories'], queryFn: fetchProductCategories });
  const { data: subcategories, isLoading: subsLoading } = useQuery({ queryKey: ['product-subcategories'], queryFn: fetchProductSubcategories });

  const delMut = useMutation({
    mutationFn: deleteBOM,
    onSuccess: () => { toast({ title: '✅ Component removed' }); qc.invalidateQueries({ queryKey: ['active-bom'] }); },
    onError: (e) => toast({ title: '❌ Failed', description: String(e), variant: 'destructive' }),
  });

  const productMap = useMemo(() => {
    const map = new Map<number, Product>();
    products?.forEach(p => map.set(p.ProductID, p));
    return map;
  }, [products]);

  const assemblyIds = useMemo(() => {
    if (!bom) return new Set<number>();
    return new Set(bom.map(b => b.ProductAssemblyID).filter(Boolean));
  }, [bom]);

  const productsBySubcategory = useMemo(() => {
    const map = new Map<number, Product[]>();
    products?.forEach(p => {
      if (p.ProductSubcategoryID && assemblyIds.has(p.ProductID)) {
        const list = map.get(p.ProductSubcategoryID) || [];
        list.push(p);
        map.set(p.ProductSubcategoryID, list);
      }
    });
    return map;
  }, [products, assemblyIds]);

  const filteredSubcategories = useMemo(() => {
    if (!selectedCategory || !subcategories) return [];
    return subcategories
      .filter(s => s.ProductCategoryID === selectedCategory)
      .filter(s => (productsBySubcategory.get(s.ProductSubcategoryID)?.length || 0) > 0);
  }, [selectedCategory, subcategories, productsBySubcategory]);

  const filteredProducts = useMemo(() => {
    if (!selectedSubcategory) return [];
    return productsBySubcategory.get(selectedSubcategory) || [];
  }, [selectedSubcategory, productsBySubcategory]);

  const relevantCategories = useMemo(() => {
    if (!categories || !subcategories) return [];
    const subcatIdsWithBom = new Set(
      Array.from(productsBySubcategory.keys())
    );
    const catIdsWithBom = new Set(
      subcategories
        .filter(s => subcatIdsWithBom.has(s.ProductSubcategoryID))
        .map(s => s.ProductCategoryID)
    );
    return categories.filter(c => catIdsWithBom.has(c.ProductCategoryID));
  }, [categories, subcategories, productsBySubcategory]);

  const tree = useMemo(() => {
    if (!selectedProduct || !bom) return [];
    return buildBomTree(bom, productMap, selectedProduct);
  }, [selectedProduct, bom, productMap]);

  const isLoading = bomLoading || productsLoading || catsLoading || subsLoading;

  const handleBack = () => {
    if (selectedProduct) { setSelectedProduct(null); }
    else if (selectedSubcategory) { setSelectedSubcategory(null); }
    else if (selectedCategory) { setSelectedCategory(null); }
  };

  const currentCategoryName = categories?.find(c => c.ProductCategoryID === selectedCategory)?.Name;
  const currentSubcategoryName = subcategories?.find(s => s.ProductSubcategoryID === selectedSubcategory)?.Name;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">2. Engineer — Bill of Materials</h1>
          <p className="font-doodle text-sm text-muted-foreground">Explore the component hierarchy for manufactured products</p>
        </div>
        <Link to="/engineer/locations" className="doodle-button text-sm">Locations</Link>
      </div>

      {isLoading ? (
        <div className="grid md:grid-cols-3 gap-6">
          <div className="doodle-card-static p-4 space-y-3">
            <SidebarListSkeleton count={12} />
          </div>
          <div className="md:col-span-2 doodle-card-static p-4">
            <TableSkeleton rows={6} cols={4} />
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-3 gap-6">
          {/* Category → Subcategory → Product Nav */}
          <div className="doodle-card-static p-4 space-y-3">
            {selectedCategory && (
              <button onClick={handleBack} className="flex items-center gap-1 font-doodle text-xs text-doodle-blue hover:underline mb-1">
                <ArrowLeft className="w-3 h-3" />
                Back
              </button>
            )}

            {selectedCategory && (
              <div className="font-doodle text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
                <button onClick={() => { setSelectedCategory(null); setSelectedSubcategory(null); setSelectedProduct(null); }} className="hover:text-doodle-blue">Categories</button>
                {currentCategoryName && (
                  <>
                    <ChevronRight className="w-3 h-3" />
                    <button onClick={() => { setSelectedSubcategory(null); setSelectedProduct(null); }} className="hover:text-doodle-blue">{currentCategoryName}</button>
                  </>
                )}
                {currentSubcategoryName && (
                  <>
                    <ChevronRight className="w-3 h-3" />
                    <span className="text-doodle-text font-bold">{currentSubcategoryName}</span>
                  </>
                )}
              </div>
            )}

            {!selectedCategory && (
              <>
                <h3 className="font-doodle text-sm font-bold text-doodle-text">Select Category</h3>
                <div className="space-y-1">
                  {relevantCategories.map(c => (
                    <button
                      key={c.ProductCategoryID}
                      onClick={() => setSelectedCategory(c.ProductCategoryID)}
                      className="w-full text-left px-3 py-2 font-doodle text-sm rounded transition-colors hover:bg-secondary/50 text-doodle-text flex items-center justify-between"
                    >
                      {c.Name}
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </>
            )}

            {selectedCategory && !selectedSubcategory && (
              <>
                <h3 className="font-doodle text-sm font-bold text-doodle-text">Select Subcategory</h3>
                <div className="space-y-1">
                  {filteredSubcategories.map(s => {
                    const count = productsBySubcategory.get(s.ProductSubcategoryID)?.length || 0;
                    return (
                      <button
                        key={s.ProductSubcategoryID}
                        onClick={() => setSelectedSubcategory(s.ProductSubcategoryID)}
                        className="w-full text-left px-3 py-2 font-doodle text-sm rounded transition-colors hover:bg-secondary/50 text-doodle-text flex items-center justify-between"
                      >
                        <span>{s.Name}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{count}</span>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {selectedSubcategory && (
              <>
                <h3 className="font-doodle text-sm font-bold text-doodle-text">Select Product</h3>
                <div className="max-h-96 overflow-y-auto space-y-1">
                  {filteredProducts.map(p => (
                    <button
                      key={p.ProductID}
                      onClick={() => setSelectedProduct(p.ProductID)}
                      className={`w-full text-left px-3 py-2 font-doodle text-sm rounded transition-colors ${selectedProduct === p.ProductID ? 'bg-doodle-accent/20 text-doodle-accent font-bold border-l-4 border-doodle-accent' : 'hover:bg-secondary/50 text-doodle-text'}`}
                    >
                      {p.Name}
                    </button>
                  ))}
                </div>
                <p className="font-doodle text-xs text-muted-foreground">{filteredProducts.length} products</p>
              </>
            )}
          </div>

          {/* BOM Tree */}
          <div className="md:col-span-2 doodle-card-static p-4">
            {selectedProduct ? (
              <>
                <div className="flex justify-between items-center mb-3">
                  <h3 className="font-doodle text-sm font-bold text-doodle-text">
                    BOM for: {productMap.get(selectedProduct)?.Name}
                  </h3>
                  <div className="flex gap-2">
                    <CreateBOMDialog assemblyProductId={selectedProduct} assemblyProductName={productMap.get(selectedProduct)?.Name || ''} />
                    <Link to={`/engineer/bom/${selectedProduct}`} className="font-doodle text-xs text-doodle-blue hover:underline">Full view →</Link>
                  </div>
                </div>
                <div className="font-doodle text-xs text-muted-foreground flex gap-6 mb-2 px-2 border-b border-doodle-text/10 pb-1">
                  <span className="ml-auto flex gap-3">
                    <span>Qty</span>
                    <span>Unit $</span>
                    <span className="font-bold">Total $</span>
                  </span>
                </div>
                {tree.length === 0 ? (
                  <p className="font-doodle text-sm text-muted-foreground p-4">No BOM records found</p>
                ) : (
                  tree.map(node => <TreeNode key={node.bomId} node={node} depth={0} onDelete={(id) => delMut.mutateAsync(id)} />)
                )}
                <div className="mt-3 pt-3 border-t-2 border-doodle-text/20 flex justify-between">
                  <span className="font-doodle text-sm font-bold">Total Cost Rollup</span>
                  <span className="font-doodle text-sm font-bold text-doodle-green">
                    ${tree.reduce((s, n) => s + n.totalCost, 0).toFixed(2)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-64">
                <p className="font-doodle text-muted-foreground">← Select a product to view its BOM</p>
              </div>
            )}
          </div>
        </div>
      )}

      {!isLoading && bom && products && (
        <div className="space-y-3 pt-4">
          <div>
            <h2 className="font-doodle text-lg font-bold text-doodle-text">BOM Insights</h2>
            <p className="font-doodle text-xs text-muted-foreground">
              Cross-cutting analytics across every active BOM — pick a lens below.
            </p>
          </div>
          <BOMOverviewInsights bom={bom} products={products} />
        </div>
      )}
    </div>
  );
};

export default EngineerBOM;
