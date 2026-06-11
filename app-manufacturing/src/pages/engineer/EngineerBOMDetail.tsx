import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, ChevronDown, Info } from 'lucide-react';
import { fetchActiveBOM, fetchAllProducts, fetchProduct, deleteBOM } from '@/services/api';
import { fetchCurrentCost, type CurrentBomCostLine } from '@/services/planningApi';
import { toast } from '@/hooks/use-toast';
import { TableSkeleton } from '@/components/LoadingSkeletons';
import CreateBOMDialog from '@/components/CreateBOMDialog';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { BillOfMaterials, Product, BomTreeNode } from '@/types/production';
import WorkOrderCostImpactPanel from '@/components/WorkOrderCostImpactPanel';

function buildBomTree(
  bom: BillOfMaterials[],
  products: Map<number, Product>,
  costMap: Map<number, CurrentBomCostLine>,
  parentId: number
): BomTreeNode[] {
  const children = bom.filter(b => b.ProductAssemblyID === parentId);
  return children.map(b => {
    const product = products.get(b.ComponentID);
    const childNodes = buildBomTree(bom, products, costMap, b.ComponentID);
    const childCost = childNodes.reduce((s, c) => s + c.totalCost, 0);
    const costLine = costMap.get(b.ComponentID);
    const unitCost = costLine?.currentCost ?? product?.StandardCost ?? 0;
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

const costSourceLabel: Record<string, { label: string; color: string; hint: string; href?: (componentId: number) => string }> = {
  'ProductCostHistory': {
    label: 'Cost History',
    color: 'bg-green-100 text-green-800',
    hint: 'View cost & price history →',
    href: (id) => `/receive/costing/${id}`,
  },
  'ProductVendor.LastReceiptCost': {
    label: 'Last Receipt',
    color: 'bg-blue-100 text-blue-800',
    hint: 'View vendor receipts & POs →',
    href: (id) => `/receive/inventory/${id}`,
  },
  'Product.StandardCost': {
    label: 'Std Cost',
    color: 'bg-muted text-muted-foreground',
    hint: 'Fallback to Product.StandardCost (no richer source available)',
  },
};

const TreeNode: React.FC<{
  node: BomTreeNode;
  depth: number;
  costMap: Map<number, CurrentBomCostLine>;
  onDelete: (id: number) => Promise<void>;
}> = ({ node, depth, costMap, onDelete }) => {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const costLine = costMap.get(node.componentId);
  const source = costLine ? costSourceLabel[costLine.costSource] : null;

  return (
    <div>
      <div className="flex items-center gap-2 py-2 px-3 hover:bg-secondary/30 rounded" style={{ paddingLeft: `${depth * 28 + 12}px` }} onClick={() => hasChildren && setOpen(!open)}>
        {hasChildren ? (open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />) : <span className="w-4 shrink-0" />}
        <span className="font-doodle text-sm font-bold text-doodle-text">{node.componentName}</span>
        <span className="font-doodle text-xs text-muted-foreground ml-auto flex gap-4 items-center">
          <span>×{node.perAssemblyQty} {node.unitMeasureCode}</span>
          <span>Level {node.bomLevel}</span>
          <span className="flex items-center gap-1">
            ${node.standardCost.toFixed(2)}/ea
            {source && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    {source.href ? (
                      <Link
                        to={source.href(node.componentId)}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex"
                      >
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1 py-0 cursor-pointer hover:underline ${source.color}`}
                        >
                          {source.label}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge variant="outline" className={`text-[10px] px-1 py-0 ${source.color}`}>
                        {source.label}
                      </Badge>
                    )}
                  </TooltipTrigger>
                  <TooltipContent className="font-doodle text-xs">{source.hint}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </span>
          <span className="font-bold text-doodle-green">${node.totalCost.toFixed(2)}</span>
          <span onClick={e => e.stopPropagation()}>
            <DeleteConfirmDialog title="Remove Component" description={`Remove "${node.componentName}" from this BOM?`} onConfirm={() => onDelete(node.bomId)} />
          </span>
        </span>
      </div>
      {open && node.children.map(c => <TreeNode key={c.bomId} node={c} depth={depth + 1} costMap={costMap} onDelete={onDelete} />)}
    </div>
  );
};

const EngineerBOMDetail = () => {
  const { productId } = useParams();
  const pid = Number(productId);
  const qc = useQueryClient();

  const { data: product } = useQuery({ queryKey: ['product', pid], queryFn: () => fetchProduct(pid) });
  const { data: bom, isLoading } = useQuery({ queryKey: ['active-bom'], queryFn: fetchActiveBOM });
  const { data: products } = useQuery({ queryKey: ['all-products'], queryFn: fetchAllProducts });
  const { data: currentCost } = useQuery({
    queryKey: ['current-cost', pid],
    queryFn: () => fetchCurrentCost(pid),
    staleTime: 60_000,
  });

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

  const costMap = useMemo(() => {
    const map = new Map<number, CurrentBomCostLine>();
    currentCost?.bomBreakdown?.forEach(line => map.set(line.productId, line));
    return map;
  }, [currentCost]);

  const tree = useMemo(() => {
    if (!bom) return [];
    return buildBomTree(bom, productMap, costMap, pid);
  }, [bom, productMap, costMap, pid]);

  const totalMaterialCost = tree.reduce((s, n) => s + n.totalCost, 0);

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/engineer" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to BOM Explorer
      </Link>

      <div className="doodle-card-static p-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4">
          <div>
            <h1 className="font-doodle text-2xl font-bold text-doodle-text">Bill of Materials: {product?.Name || `Product #${pid}`}</h1>
            {currentCost && (
              <div className="flex items-center gap-3 mt-1">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-doodle text-sm text-muted-foreground flex items-center gap-1 cursor-help">
                        <Info className="w-3 h-3" />
                        Manufacturing Cost: <span className="font-bold text-doodle-green">${currentCost.totalManufacturingCost.toFixed(2)}</span>
                        <span className="text-xs ml-1">(margin {(currentCost.grossMarginPct * 100).toFixed(1)}%)</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="font-doodle text-xs max-w-xs">
                      <p>Material: ${currentCost.currentMaterialCost.toFixed(2)}</p>
                      <p>Routing: ${currentCost.estimatedRoutingCost.toFixed(2)}</p>
                      <p>List Price: ${currentCost.listPrice.toFixed(2)}</p>
                      <p className="text-muted-foreground mt-1">Costs from ProductCostHistory, vendor receipts, or standard cost fallback</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}
          </div>
          <CreateBOMDialog assemblyProductId={pid} assemblyProductName={product?.Name || `Product #${pid}`} />
        </div>
        {isLoading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : tree.length === 0 ? (
          <p className="font-doodle text-muted-foreground mt-4">No BOM records found. Add a component above.</p>
        ) : (
          <>
            <div className="mt-4">
              {tree.map(n => <TreeNode key={n.bomId} node={n} depth={0} costMap={costMap} onDelete={(id) => delMut.mutateAsync(id)} />)}
            </div>
            <div className="mt-4 pt-4 border-t-2 border-doodle-text/20 flex justify-between">
              <span className="font-doodle font-bold">Total Material Cost</span>
              <span className="font-doodle font-bold text-doodle-green">${totalMaterialCost.toFixed(2)}</span>
            </div>
          </>
        )}
      </div>

      {tree.length > 0 && (
        <WorkOrderCostImpactPanel assemblyProductId={pid} tree={tree} costMap={costMap} />
      )}

      <div className="flex gap-3">
        <Link to={`/engineer/routing/${pid}`} className="doodle-button text-sm">View Routing →</Link>
        <Link to={`/define/products/${pid}`} className="doodle-button text-sm">Product Detail →</Link>
      </div>
    </div>
  );
};

export default EngineerBOMDetail;
