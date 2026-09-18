import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, Fragment } from 'react';
import { AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react';
import {
  fetchWorkOrdersByProduct,
  fetchActiveOperations,
} from '@/services/api';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { WorkOrder, BomTreeNode } from '@/types/production';
import type { CurrentBomCostLine } from '@/services/planningApi';

type WOStatus = 'Planned' | 'Released' | 'Completed' | 'Scrapped';

interface FlatComponent {
  componentId: number;
  componentName: string;
  effectivePerAssembly: number; // qty per finished assembly (multiplied through tree)
  unitCost: number;
  costSource?: CurrentBomCostLine['costSource'];
}

function flattenTree(nodes: BomTreeNode[], multiplier = 1): FlatComponent[] {
  const out: FlatComponent[] = [];
  for (const n of nodes) {
    const eff = n.perAssemblyQty * multiplier;
    out.push({
      componentId: n.componentId,
      componentName: n.componentName,
      effectivePerAssembly: eff,
      unitCost: n.standardCost,
    });
    if (n.children.length) out.push(...flattenTree(n.children, eff));
  }
  // Aggregate duplicate components (same componentId may appear multiple times)
  const map = new Map<number, FlatComponent>();
  for (const c of out) {
    const existing = map.get(c.componentId);
    if (existing) existing.effectivePerAssembly += c.effectivePerAssembly;
    else map.set(c.componentId, { ...c });
  }
  return Array.from(map.values());
}

const sourceMeta: Record<
  CurrentBomCostLine['costSource'],
  { label: string; color: string; volatile: boolean }
> = {
  'ProductCostHistory': {
    label: 'Cost History',
    color: 'bg-green-100 text-green-800',
    volatile: true,
  },
  'ProductVendor.LastReceiptCost': {
    label: 'Last Receipt',
    color: 'bg-blue-100 text-blue-800',
    volatile: true,
  },
  'Product.StandardCost': {
    label: 'Std Cost',
    color: 'bg-muted text-muted-foreground',
    volatile: false,
  },
};

function getStatus(wo: WorkOrder, activeIds: Set<number>): WOStatus {
  if (wo.ScrappedQty > 0 && wo.StockedQty === 0) return 'Scrapped';
  if (wo.EndDate || wo.StockedQty >= wo.OrderQty) return 'Completed';
  if (activeIds.has(wo.WorkOrderID)) return 'Released';
  if (wo.StockedQty > 0 && wo.StockedQty < wo.OrderQty) return 'Released';
  return 'Planned';
}

interface Props {
  assemblyProductId: number;
  tree: BomTreeNode[];
  costMap: Map<number, CurrentBomCostLine>;
}

const WorkOrderCostImpactPanel: React.FC<Props> = ({ assemblyProductId, tree, costMap }) => {
  const { data: workOrders, isLoading } = useQuery({
    queryKey: ['wos-for-product', assemblyProductId],
    queryFn: () => fetchWorkOrdersByProduct(assemblyProductId),
  });
  const { data: activeOps } = useQuery({
    queryKey: ['active-operations'],
    queryFn: fetchActiveOperations,
    staleTime: 30_000,
  });

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeIds = useMemo(() => {
    const s = new Set<number>();
    activeOps?.forEach(op => s.add(op.workOrderId));
    return s;
  }, [activeOps]);

  const enrichedWOs = useMemo(() => {
    return (workOrders || [])
      .map(wo => ({
        wo,
        status: getStatus(wo, activeIds),
        remaining: Math.max(0, wo.OrderQty - wo.StockedQty),
      }))
      .filter(x => x.status === 'Planned' || x.status === 'Released');
  }, [workOrders, activeIds]);

  const { plannedRemaining, releasedRemaining, plannedCount, releasedCount } = useMemo(() => {
    let plannedRem = 0;
    let releasedRem = 0;
    let pCount = 0;
    let rCount = 0;
    enrichedWOs.forEach(({ status, remaining }) => {
      if (status === 'Planned') {
        plannedRem += remaining;
        pCount += 1;
      } else {
        releasedRem += remaining;
        rCount += 1;
      }
    });
    return {
      plannedRemaining: plannedRem,
      releasedRemaining: releasedRem,
      plannedCount: pCount,
      releasedCount: rCount,
    };
  }, [enrichedWOs]);

  const flatComponents = useMemo(() => {
    const flat = flattenTree(tree);
    return flat
      .map(c => {
        const line = costMap.get(c.componentId);
        return { ...c, costSource: line?.costSource, unitCost: line?.currentCost ?? c.unitCost };
      })
      .sort((a, b) => {
        // Volatile first, then by total exposure desc
        const aVol = a.costSource && sourceMeta[a.costSource].volatile ? 1 : 0;
        const bVol = b.costSource && sourceMeta[b.costSource].volatile ? 1 : 0;
        if (aVol !== bVol) return bVol - aVol;
        const aExp = a.effectivePerAssembly * (plannedRemaining + releasedRemaining) * a.unitCost;
        const bExp = b.effectivePerAssembly * (plannedRemaining + releasedRemaining) * b.unitCost;
        return bExp - aExp;
      });
  }, [tree, costMap, plannedRemaining, releasedRemaining]);

  const totals = useMemo(() => {
    let plannedTotal = 0;
    let releasedTotal = 0;
    let volatilePlanned = 0;
    let volatileReleased = 0;
    flatComponents.forEach(c => {
      const p = c.effectivePerAssembly * plannedRemaining * c.unitCost;
      const r = c.effectivePerAssembly * releasedRemaining * c.unitCost;
      plannedTotal += p;
      releasedTotal += r;
      if (c.costSource && sourceMeta[c.costSource].volatile) {
        volatilePlanned += p;
        volatileReleased += r;
      }
    });
    return { plannedTotal, releasedTotal, volatilePlanned, volatileReleased };
  }, [flatComponents, plannedRemaining, releasedRemaining]);

  if (isLoading) {
    return (
      <div className="doodle-card-static p-6">
        <h2 className="font-doodle text-lg font-bold text-doodle-text">Work Order Cost Impact</h2>
        <p className="font-doodle text-sm text-muted-foreground mt-2">Loading work orders…</p>
      </div>
    );
  }

  if (!workOrders || workOrders.length === 0 || (plannedCount === 0 && releasedCount === 0)) {
    return (
      <div className="doodle-card-static p-6">
        <h2 className="font-doodle text-lg font-bold text-doodle-text">Work Order Cost Impact</h2>
        <p className="font-doodle text-sm text-muted-foreground mt-2">
          No planned or released work orders for this assembly. Cost-source changes will only affect future runs.
        </p>
      </div>
    );
  }

  return (
    <div className="doodle-card-static p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-doodle text-lg font-bold text-doodle-text flex items-center gap-2">
            Work Order Cost Impact
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="w-4 h-4 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent className="font-doodle text-xs max-w-sm">
                  Shows how a change to each component's cost source would flow into the remaining
                  material cost of <b>Planned</b> (not yet started) and <b>Released</b> (in-progress)
                  work orders. Released exposure is based on remaining unbuilt qty
                  (OrderQty − StockedQty).
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </h2>
          <p className="font-doodle text-xs text-muted-foreground mt-1">
            {plannedCount} planned · {releasedCount} released · {plannedRemaining + releasedRemaining} units of remaining exposure
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <div className="border-2 border-dashed border-doodle-text/20 rounded p-3">
          <p className="font-doodle text-xs text-muted-foreground">Planned WO material</p>
          <p className="font-doodle text-lg font-bold text-doodle-text">${totals.plannedTotal.toFixed(0)}</p>
        </div>
        <div className="border-2 border-dashed border-doodle-text/20 rounded p-3">
          <p className="font-doodle text-xs text-muted-foreground">Released WO remaining</p>
          <p className="font-doodle text-lg font-bold text-doodle-text">${totals.releasedTotal.toFixed(0)}</p>
        </div>
        <div className="border-2 border-dashed border-doodle-accent/40 rounded p-3 bg-doodle-accent/5">
          <p className="font-doodle text-xs text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-doodle-accent" /> Volatile · Planned
          </p>
          <p className="font-doodle text-lg font-bold text-doodle-accent">${totals.volatilePlanned.toFixed(0)}</p>
        </div>
        <div className="border-2 border-dashed border-doodle-accent/40 rounded p-3 bg-doodle-accent/5">
          <p className="font-doodle text-xs text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-doodle-accent" /> Volatile · Released
          </p>
          <p className="font-doodle text-lg font-bold text-doodle-accent">${totals.volatileReleased.toFixed(0)}</p>
        </div>
      </div>

      {/* Per-component table */}
      <div className="overflow-x-auto">
        <table className="w-full font-doodle text-sm">
          <thead>
            <tr className="border-b-2 border-doodle-text/20 text-left">
              <th className="py-2 px-2 w-6"></th>
              <th className="py-2 px-2">Component</th>
              <th className="py-2 px-2">Cost Source</th>
              <th className="py-2 px-2 text-right">Per Assy</th>
              <th className="py-2 px-2 text-right">Unit $</th>
              <th className="py-2 px-2 text-right">Δ$ per +$1 cost</th>
              <th className="py-2 px-2 text-right">Planned $</th>
              <th className="py-2 px-2 text-right">Released $</th>
            </tr>
          </thead>
          <tbody>
            {flatComponents.map(c => {
              const meta = c.costSource ? sourceMeta[c.costSource] : null;
              const sensitivity = c.effectivePerAssembly * (plannedRemaining + releasedRemaining);
              const plannedExp = c.effectivePerAssembly * plannedRemaining * c.unitCost;
              const releasedExp = c.effectivePerAssembly * releasedRemaining * c.unitCost;
              const isVolatile = meta?.volatile ?? false;
              const isOpen = expanded.has(c.componentId);
              return (
                <Fragment key={c.componentId}>
                  <tr
                    key={c.componentId}
                    className={`border-b border-doodle-text/10 cursor-pointer hover:bg-secondary/40 ${isVolatile ? 'bg-doodle-accent/5' : ''}`}
                    onClick={() => toggle(c.componentId)}
                  >
                    <td className="py-2 px-2">
                      {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
                    <td className="py-2 px-2">
                      <Link
                        to={`/engineer/bom/${c.componentId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-doodle-blue hover:underline font-bold"
                      >
                        {c.componentName}
                      </Link>
                    </td>
                    <td className="py-2 px-2">
                      {meta ? (
                        <Badge variant="outline" className={`text-[10px] px-1 py-0 ${meta.color}`}>
                          {meta.label}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right">{c.effectivePerAssembly.toFixed(2)}</td>
                    <td className="py-2 px-2 text-right">${c.unitCost.toFixed(2)}</td>
                    <td className="py-2 px-2 text-right font-bold text-doodle-text">
                      ${sensitivity.toFixed(0)}
                    </td>
                    <td className="py-2 px-2 text-right">${plannedExp.toFixed(0)}</td>
                    <td className="py-2 px-2 text-right">${releasedExp.toFixed(0)}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${c.componentId}-detail`} className="border-b border-doodle-text/10 bg-secondary/20">
                      <td></td>
                      <td colSpan={8} className="py-3 px-2">
                        {enrichedWOs.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No planned or released work orders.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full font-doodle text-xs">
                              <thead>
                                <tr className="text-left text-muted-foreground">
                                  <th className="py-1 px-2">WO #</th>
                                  <th className="py-1 px-2">Status</th>
                                  <th className="py-1 px-2">Due</th>
                                  <th className="py-1 px-2 text-right">Order Qty</th>
                                  <th className="py-1 px-2 text-right">Stocked</th>
                                  <th className="py-1 px-2 text-right">Remaining (assy)</th>
                                  <th className="py-1 px-2 text-right">Component units</th>
                                  <th className="py-1 px-2 text-right">Exposure $</th>
                                </tr>
                              </thead>
                              <tbody>
                                {enrichedWOs
                                  .map(({ wo, status, remaining }) => {
                                    const compUnits = remaining * c.effectivePerAssembly;
                                    const exposure = compUnits * c.unitCost;
                                    return { wo, status, remaining, compUnits, exposure };
                                  })
                                  .sort((a, b) => b.exposure - a.exposure)
                                  .map(({ wo, status, remaining, compUnits, exposure }) => (
                                    <tr key={wo.WorkOrderID} className="border-t border-doodle-text/10">
                                      <td className="py-1 px-2">
                                        <Link
                                          to={`/plan/work-orders/${wo.WorkOrderID}`}
                                          className="text-doodle-blue hover:underline font-bold"
                                        >
                                          #{wo.WorkOrderID}
                                        </Link>
                                      </td>
                                      <td className="py-1 px-2">
                                        <Badge
                                          variant="outline"
                                          className={`text-[10px] px-1 py-0 ${
                                            status === 'Released'
                                              ? 'bg-doodle-green/10 text-doodle-green'
                                              : 'bg-doodle-blue/10 text-doodle-blue'
                                          }`}
                                        >
                                          {status}
                                        </Badge>
                                      </td>
                                      <td className="py-1 px-2">
                                        {new Date(wo.DueDate).toLocaleDateString()}
                                      </td>
                                      <td className="py-1 px-2 text-right">{wo.OrderQty}</td>
                                      <td className="py-1 px-2 text-right">{wo.StockedQty}</td>
                                      <td className="py-1 px-2 text-right">{remaining}</td>
                                      <td className="py-1 px-2 text-right">{compUnits.toFixed(2)}</td>
                                      <td className="py-1 px-2 text-right font-bold">
                                        ${exposure.toFixed(2)}
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="font-doodle text-xs text-muted-foreground mt-3">
        <b>Δ$ per +$1 cost</b> = effective qty per assembly × remaining units across planned + released WOs.
        Highlighted rows pull from cost sources (Cost History, Last Receipt) that change as new data arrives.
      </p>
    </div>
  );
};

export default WorkOrderCostImpactPanel;
