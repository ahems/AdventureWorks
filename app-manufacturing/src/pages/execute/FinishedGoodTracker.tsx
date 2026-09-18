import { useQuery, useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useMemo, useState, useRef, useEffect } from 'react';
import { ArrowLeft, Package, Clock, Activity, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, PartyPopper } from 'lucide-react';
import { toast } from 'sonner';
import { fetchWorkOrders, fetchManufacturedProducts, fetchActiveBOM, fetchActiveOperations, fetchWorkOrderRouting } from '@/services/api';
import type { WorkOrder, Product, BillOfMaterials } from '@/types/production';
import { ShopFloorSkeleton } from '@/components/LoadingSkeletons';

/** Recursively collect all manufactured component ProductIDs for a given assembly */
function collectSubAssemblyIds(
  assemblyId: number,
  bomRecords: BillOfMaterials[],
  productMap: Map<number, Product>,
  visited: Set<number>
): Set<number> {
  if (visited.has(assemblyId)) return new Set();
  visited.add(assemblyId);
  const result = new Set<number>();
  const children = bomRecords.filter(b => b.ProductAssemblyID === assemblyId);
  for (const b of children) {
    const comp = productMap.get(b.ComponentID);
    if (comp?.MakeFlag) {
      result.add(comp.ProductID);
      const grandchildren = collectSubAssemblyIds(comp.ProductID, bomRecords, productMap, new Set(visited));
      grandchildren.forEach(id => result.add(id));
    }
  }
  return result;
}

interface FinishedGoodRun {
  rootWo: WorkOrder;
  rootProduct: Product;
  subWos: WorkOrder[];
  allWos: WorkOrder[];
}

const FinishedGoodTracker = () => {
  const { data: workOrders, isLoading } = useQuery({ queryKey: ['work-orders'], queryFn: fetchWorkOrders, refetchInterval: 120_000 });
  const { data: products } = useQuery({ queryKey: ['manufactured-products'], queryFn: fetchManufacturedProducts });
  const { data: bom } = useQuery({ queryKey: ['active-bom'], queryFn: fetchActiveBOM });
  const { data: activeOps } = useQuery({ queryKey: ['active-operations'], queryFn: fetchActiveOperations, refetchInterval: 60_000 });

  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('active');

  const productMap = useMemo(() => {
    const map = new Map<number, Product>();
    products?.forEach(p => map.set(p.ProductID, p));
    return map;
  }, [products]);

  const activeWoIds = useMemo(() => new Set((activeOps || []).map(op => op.workOrderId)), [activeOps]);

  // Identify finished good runs: root WOs where product has FinishedGoodsFlag
  // Then find sub-assembly WOs that were created at the same time for BOM components
  const runs = useMemo(() => {
    if (!workOrders || !products || !bom) return [];

    const finishedGoods = new Set<number>();
    products.forEach(p => { if (p.FinishedGoodsFlag && p.MakeFlag) finishedGoods.add(p.ProductID); });

    // Find root WOs: any FinishedGood WO started in the last 30 days,
    // or whose ID matches an active operation right now.
    const cutoff = Date.now() - 30 * 86400000;
    const rootWos = workOrders.filter(wo =>
      finishedGoods.has(wo.ProductID) &&
      (new Date(wo.StartDate).getTime() >= cutoff || activeWoIds.has(wo.WorkOrderID))
    );

    const result: FinishedGoodRun[] = [];
    const claimedWoIds = new Set<number>();

    for (const rootWo of rootWos) {
      if (claimedWoIds.has(rootWo.WorkOrderID)) continue;

      const subProductIds = collectSubAssemblyIds(rootWo.ProductID, bom, productMap, new Set());
      
      // Find WOs created around the same time for sub-assembly products
      const rootStart = new Date(rootWo.StartDate).getTime();
      const subWos = workOrders.filter(wo =>
        wo.WorkOrderID !== rootWo.WorkOrderID &&
        subProductIds.has(wo.ProductID) &&
        !claimedWoIds.has(wo.WorkOrderID) &&
        Math.abs(new Date(wo.StartDate).getTime() - rootStart) < 60000 // within 1 minute
      );

      claimedWoIds.add(rootWo.WorkOrderID);
      subWos.forEach(wo => claimedWoIds.add(wo.WorkOrderID));

      const rootProduct = productMap.get(rootWo.ProductID);
      if (rootProduct) {
        result.push({
          rootWo,
          rootProduct,
          subWos,
          allWos: [rootWo, ...subWos],
        });
      }
    }

    return result.sort((a, b) => b.rootWo.WorkOrderID - a.rootWo.WorkOrderID);
  }, [workOrders, products, bom, productMap, activeWoIds]);

  // Track completed runs and notify on new completions
  const notifiedRuns = useRef(new Set<number>());

  useEffect(() => {
    for (const run of runs) {
      const allDone = run.allWos.every(wo => wo.EndDate != null);
      if (allDone && !notifiedRuns.current.has(run.rootWo.WorkOrderID)) {
        notifiedRuns.current.add(run.rootWo.WorkOrderID);
        // Skip notification on initial load (seed all already-done runs)
        if (notifiedRuns.current.size > runs.filter(r => r.allWos.every(w => w.EndDate != null)).length) {
          // This shouldn't fire on first load — handled below
        }
      }
    }
  // Seed on first load
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect newly completed runs
  const prevCompletedRef = useRef(new Set<number>());
  useEffect(() => {
    const currentCompleted = new Set<number>();
    for (const run of runs) {
      if (run.allWos.every(wo => wo.EndDate != null)) {
        currentCompleted.add(run.rootWo.WorkOrderID);
      }
    }
    // Find newly completed (in current but not in previous)
    for (const woId of currentCompleted) {
      if (!prevCompletedRef.current.has(woId)) {
        const run = runs.find(r => r.rootWo.WorkOrderID === woId);
        if (run && prevCompletedRef.current.size > 0) {
          // Only notify after initial load (prevCompleted was populated at least once)
          toast.success(`${run.rootProduct.Name} — Build Complete!`, {
            description: `All ${run.allWos.length} work orders finished. WO #${run.rootWo.WorkOrderID}`,
            duration: 10000,
          });
        }
      }
    }
    prevCompletedRef.current = currentCompleted;
  }, [runs]);


  const expandedRun_ = runs.find(r => r.rootWo.WorkOrderID === expandedRun);
  const routingQueries = useQueries({
    queries: (expandedRun_?.allWos || []).map(wo => ({
      queryKey: ['wo-routing', wo.WorkOrderID],
      queryFn: () => fetchWorkOrderRouting(wo.WorkOrderID),
      refetchInterval: 60_000,
      staleTime: 3000,
    })),
  });

  const filteredRuns = useMemo(() => {
    return runs.filter(run => {
      const allDone = run.allWos.every(wo => wo.EndDate != null);
      const anyActive = run.allWos.some(wo => activeWoIds.has(wo.WorkOrderID));
      if (filter === 'active') return !allDone;
      if (filter === 'completed') return allDone;
      return true;
    });
  }, [runs, filter, activeWoIds]);

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">Finished Good Tracker</h1>
          <p className="font-doodle text-sm text-muted-foreground">Track overall progress of complete product builds</p>
        </div>
        <Link to="/execute" className="doodle-button text-sm">← Manufacturing Dashboard</Link>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {(['active', 'completed', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`font-doodle text-xs px-3 py-1.5 border-2 border-doodle-text rounded transition-colors ${
              filter === f ? 'bg-doodle-text text-background' : 'hover:bg-secondary'
            }`}
          >
            {f === 'active' ? 'Active Builds' : f === 'completed' ? 'Completed' : 'All'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <ShopFloorSkeleton />
      ) : filteredRuns.length === 0 ? (
        <div className="doodle-card-static p-8 text-center">
          <p className="font-doodle text-lg text-muted-foreground">
            {filter === 'active' ? 'No active production runs' : 'No production runs found'}
          </p>
          <p className="font-doodle text-sm text-muted-foreground mt-2">
            Start a production run from the Plan section to see it here
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredRuns.map((run) => {
            const totalWos = run.allWos.length;
            const completedWos = run.allWos.filter(wo => wo.EndDate != null).length;
            const activeWos = run.allWos.filter(wo => activeWoIds.has(wo.WorkOrderID)).length;
            const scrappedWos = run.allWos.filter(wo => wo.ScrappedQty > 0).length;
            const overallProgress = totalWos > 0 ? (completedWos / totalWos) * 100 : 0;
            const allDone = completedWos === totalWos;
            const isExpanded = expandedRun === run.rootWo.WorkOrderID;

            // Estimate remaining time based on active ops
            const activeOpsForRun = (activeOps || []).filter(op =>
              run.allWos.some(wo => wo.WorkOrderID === op.workOrderId)
            );
            const pendingWos = totalWos - completedWos - activeWos;
            const avgOpTime = 3.5; // default estimate per WO in minutes
            const estimatedRemaining = (pendingWos * avgOpTime) + 
              activeOpsForRun.reduce((sum, op) => sum + Math.max(0, avgOpTime - op.elapsedMinutes), 0);

            return (
              <div key={run.rootWo.WorkOrderID} className="doodle-card-static overflow-hidden">
                {/* Summary row */}
                <button
                  onClick={() => setExpandedRun(isExpanded ? null : run.rootWo.WorkOrderID)}
                  className="w-full p-5 text-left hover:bg-secondary/30 transition-colors"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                      <Package className="w-5 h-5 text-doodle-blue" />
                      <div>
                        <h3 className="font-doodle text-sm font-bold text-doodle-text">{run.rootProduct.Name}</h3>
                        <p className="font-doodle text-xs text-muted-foreground">
                          WO #{run.rootWo.WorkOrderID} · Qty {run.rootWo.OrderQty} · {totalWos} work orders
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {!allDone && estimatedRemaining > 0 && (
                        <span className="font-doodle text-xs text-doodle-blue flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          ~{estimatedRemaining.toFixed(0)} min
                        </span>
                      )}
                      <span className={`font-doodle text-xs font-bold px-2 py-1 rounded-full border-2 border-doodle-text ${
                        allDone ? 'bg-doodle-green/20 text-doodle-green' :
                        activeWos > 0 ? 'bg-doodle-blue/20 text-doodle-blue' :
                        'bg-secondary text-muted-foreground'
                      }`}>
                        {allDone ? 'Complete' : activeWos > 0 ? `${activeWos} active` : 'Pending'}
                      </span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="ml-12 space-y-1">
                    <div className="flex justify-between font-doodle text-xs">
                      <span>{completedWos} / {totalWos} work orders done</span>
                      <span className="font-bold">{overallProgress.toFixed(0)}%</span>
                    </div>
                    <div className="w-full h-3 bg-secondary border-2 border-doodle-text rounded-sm overflow-hidden">
                      <div className="h-full bg-doodle-green transition-all" style={{ width: `${overallProgress}%` }} />
                    </div>
                    {scrappedWos > 0 && (
                      <p className="font-doodle text-xs text-doodle-accent flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {scrappedWos} work order(s) had scrap
                      </p>
                    )}
                  </div>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t-2 border-dashed border-doodle-text/10 p-5">
                    <div className="space-y-2">
                      {run.allWos
                        .sort((a, b) => {
                          // Root WO first, then by completion status
                          if (a.WorkOrderID === run.rootWo.WorkOrderID) return -1;
                          if (b.WorkOrderID === run.rootWo.WorkOrderID) return 1;
                          const aActive = activeWoIds.has(a.WorkOrderID);
                          const bActive = activeWoIds.has(b.WorkOrderID);
                          if (aActive && !bActive) return -1;
                          if (!aActive && bActive) return 1;
                          const aDone = a.EndDate != null;
                          const bDone = b.EndDate != null;
                          if (aDone && !bDone) return 1;
                          if (!aDone && bDone) return -1;
                          return 0;
                        })
                        .map((wo, idx) => {
                          const product = productMap.get(wo.ProductID);
                          const isRoot = wo.WorkOrderID === run.rootWo.WorkOrderID;
                          const isDone = wo.EndDate != null;
                          const isActive = activeWoIds.has(wo.WorkOrderID);
                          const op = (activeOps || []).find(o => o.workOrderId === wo.WorkOrderID);

                          // Get routing progress for this WO if expanded
                          const routingData = routingQueries[run.allWos.findIndex(w => w.WorkOrderID === wo.WorkOrderID)]?.data;
                          const opsCompleted = routingData?.filter(r => r.ActualEndDate != null).length ?? 0;
                          const opsTotal = routingData?.length ?? 0;

                          return (
                            <Link
                              key={wo.WorkOrderID}
                              to={`/execute/work-order/${wo.WorkOrderID}`}
                              className={`flex items-center gap-3 p-3 rounded border-2 transition-colors hover:bg-secondary/30 ${
                                isActive ? 'border-doodle-green bg-doodle-green/5' :
                                isDone ? 'border-doodle-text/10 opacity-60' :
                                'border-doodle-text/10'
                              }`}
                            >
                              <div className="shrink-0">
                                {isDone ? <CheckCircle2 className="w-4 h-4 text-doodle-green" /> :
                                 isActive ? <Activity className="w-4 h-4 text-doodle-green animate-pulse" /> :
                                 <Clock className="w-4 h-4 text-muted-foreground" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-doodle text-xs text-doodle-blue font-bold">#{wo.WorkOrderID}</span>
                                  {isRoot && <span className="font-doodle text-[10px] bg-doodle-blue/10 text-doodle-blue px-1.5 py-0.5 rounded">ROOT</span>}
                                </div>
                                <p className="font-doodle text-sm font-bold text-doodle-text truncate">
                                  {product?.Name || `Product #${wo.ProductID}`}
                                </p>
                                {op && (
                                  <p className="font-doodle text-xs text-doodle-green">
                                    Op {op.operationSequence} at {op.locationName} ({op.elapsedMinutes.toFixed(1)} min)
                                  </p>
                                )}
                                {opsTotal > 0 && (
                                  <p className="font-doodle text-xs text-muted-foreground">
                                    {opsCompleted}/{opsTotal} routing ops
                                  </p>
                                )}
                              </div>
                              <div className="shrink-0 text-right">
                                {isDone && wo.EndDate && (
                                  <p className="font-doodle text-xs text-muted-foreground">
                                    {new Date(wo.EndDate).toLocaleTimeString()}
                                  </p>
                                )}
                                {wo.ScrappedQty > 0 && (
                                  <p className="font-doodle text-xs text-doodle-accent">⚠ {wo.ScrappedQty} scrap</p>
                                )}
                              </div>
                            </Link>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default FinishedGoodTracker;
