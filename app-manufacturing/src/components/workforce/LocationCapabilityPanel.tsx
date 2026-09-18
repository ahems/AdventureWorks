import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Factory, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchWorkOrderRouting,
  fetchActiveBOM,
  fetchAllProducts,
} from '@/services/api';
import CreateProductionOrderDialog from '@/components/CreateProductionOrderDialog';
import type { Product, BillOfMaterials, WorkOrderRouting } from '@/types/production';

interface Props {
  locationId: number;
  locationName: string;
}

interface CapabilityRow {
  componentId: number;
  componentName: string;
  isFinishedGood: boolean;
  finishedGoods: { id: number; name: string }[];
}

const LocationCapabilityPanel: React.FC<Props> = ({ locationId, locationName }) => {
  const [expanded, setExpanded] = useState(false);
  

  const { data: routings, isLoading: rLoading } = useQuery({
    queryKey: ['all-routings'],
    queryFn: () => fetchWorkOrderRouting(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: bom, isLoading: bLoading } = useQuery({
    queryKey: ['active-bom'],
    queryFn: fetchActiveBOM,
    staleTime: 5 * 60 * 1000,
  });
  const { data: products, isLoading: pLoading } = useQuery({
    queryKey: ['all-products'],
    queryFn: fetchAllProducts,
    staleTime: 5 * 60 * 1000,
  });

  const productMap = useMemo(() => {
    const m = new Map<number, Product>();
    products?.forEach(p => m.set(p.ProductID, p));
    return m;
  }, [products]);

  // Reverse BOM index: component -> parent assemblies
  const parentsByComponent = useMemo(() => {
    const m = new Map<number, number[]>();
    (bom || []).forEach((b: BillOfMaterials) => {
      if (b.ProductAssemblyID == null) return;
      const list = m.get(b.ComponentID) || [];
      list.push(b.ProductAssemblyID);
      m.set(b.ComponentID, list);
    });
    return m;
  }, [bom]);

  const rows = useMemo<CapabilityRow[]>(() => {
    if (!routings || !bom || !products) return [];

    // distinct ProductIDs routed through this location
    const routed = new Set<number>();
    (routings as WorkOrderRouting[]).forEach(r => {
      if (r.LocationID === locationId) routed.add(r.ProductID);
    });

    const result: CapabilityRow[] = [];
    routed.forEach(pid => {
      const product = productMap.get(pid);
      if (!product) return;

      // BFS upward to finished goods
      const finishedGoods = new Map<number, string>();
      const visited = new Set<number>([pid]);
      const queue: { id: number; depth: number }[] = [{ id: pid, depth: 0 }];
      while (queue.length) {
        const { id, depth } = queue.shift()!;
        if (depth > 6) continue;
        const node = productMap.get(id);
        if (node?.FinishedGoodsFlag && id !== pid) {
          finishedGoods.set(id, node.Name);
          // don't dive further past a finished good
          continue;
        }
        const parents = parentsByComponent.get(id) || [];
        for (const parent of parents) {
          if (visited.has(parent)) continue;
          visited.add(parent);
          queue.push({ id: parent, depth: depth + 1 });
        }
      }

      result.push({
        componentId: pid,
        componentName: product.Name,
        isFinishedGood: !!product.FinishedGoodsFlag,
        finishedGoods: [...finishedGoods.entries()].map(([id, name]) => ({ id, name })),
      });
    });

    // sort by # finished goods consumers desc, then by direct-finished-good first, then name
    result.sort((a, b) => {
      const fg = b.finishedGoods.length - a.finishedGoods.length;
      if (fg !== 0) return fg;
      if (a.isFinishedGood !== b.isFinishedGood) return a.isFinishedGood ? -1 : 1;
      return a.componentName.localeCompare(b.componentName);
    });
    return result;
  }, [routings, bom, products, locationId, productMap, parentsByComponent]);

  const loading = rLoading || bLoading || pLoading;

  const totalFinishedGoods = useMemo(() => {
    const s = new Set<number>();
    rows.forEach(r => {
      if (r.isFinishedGood) s.add(r.componentId);
      r.finishedGoods.forEach(fg => s.add(fg.id));
    });
    return s.size;
  }, [rows]);

  const visibleRows = expanded ? rows : rows.slice(0, 10);

  if (loading) {
    return <Skeleton className="h-12 mt-3" />;
  }

  if (rows.length === 0) {
    return (
      <div className="mt-3 pt-3 border-t">
        <p className="text-xs text-muted-foreground italic">
          No products currently route through {locationName}.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-2 text-left hover:bg-muted/40 rounded px-2 py-1.5 -mx-2 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Factory className="h-4 w-4 text-primary" />
          <span className="text-xs font-doodle font-bold">Products routed here</span>
          <span className="text-xs text-muted-foreground">
            · {rows.length} component{rows.length === 1 ? '' : 's'} feed{' '}
            {totalFinishedGoods} finished good{totalFinishedGoods === 1 ? '' : 's'}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b">
              <th className="text-left py-1.5 pr-3 font-medium">Component</th>
              <th className="text-left py-1.5 px-3 font-medium">Used by finished goods</th>
              <th className="py-1.5 pl-3" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(row => (
              <tr key={row.componentId} className="border-b border-border/50 align-top">
                <td className="py-2 pr-3">
                  <Link
                    to={`/engineer/bom?product=${row.componentId}`}
                    className="text-primary hover:underline font-medium"
                  >
                    {row.componentName}
                  </Link>
                  {row.isFinishedGood && (
                    <Badge variant="outline" className="ml-2 text-[10px]">finished good</Badge>
                  )}
                </td>
                <td className="py-2 px-3">
                  {row.finishedGoods.length === 0 ? (
                    <span className="text-xs text-muted-foreground italic">
                      {row.isFinishedGood ? 'shipped directly' : 'no parent assembly'}
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {row.finishedGoods.slice(0, expanded ? 999 : 4).map(fg => (
                        <Link key={fg.id} to={`/define/products/${fg.id}`}>
                          <Badge
                            variant="outline"
                            className="text-[11px] hover:bg-primary/10 cursor-pointer"
                          >
                            {fg.name}
                          </Badge>
                        </Link>
                      ))}
                      {!expanded && row.finishedGoods.length > 4 && (
                        <span className="text-[11px] text-muted-foreground self-center">
                          +{row.finishedGoods.length - 4} more
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="py-2 pl-3 text-right">
                  {(row.isFinishedGood || row.finishedGoods.length > 0) && (
                    <CreateProductionOrderDialog
                      prefillProductId={
                        row.isFinishedGood ? row.componentId : row.finishedGoods[0].id
                      }
                      trigger={
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 h-7 px-2 text-xs rounded hover:bg-primary/10 text-primary"
                          title="Schedule production"
                        >
                          <Plus className="h-3 w-3" /> Schedule
                        </button>
                      }
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!expanded && rows.length > 10 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Show all {rows.length} components
          </button>
        )}
      </div>
    </div>
  );
};

export default LocationCapabilityPanel;
