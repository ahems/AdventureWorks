import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo, Fragment } from 'react';
import { ArrowLeft, Activity, Clock, AlertTriangle, CheckCircle2, Circle, Timer } from 'lucide-react';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import { fetchWorkOrder, fetchWorkOrderRouting, fetchProduct, fetchLocations, fetchScrapReasons, fetchActiveBOM, fetchAllProducts, fetchActiveOperations, fetchProductInventory } from '@/services/api';
import type { Product, ProductInventory } from '@/types/production';

const ExecuteWorkOrder = () => {
  const { id } = useParams();
  const woId = Number(id);

  const { data: wo, isLoading } = useQuery({ queryKey: ['work-order', woId], queryFn: () => fetchWorkOrder(woId) });
  const { data: routing } = useQuery({ queryKey: ['wo-routing', woId], queryFn: () => fetchWorkOrderRouting(woId), enabled: !!wo, refetchInterval: 60_000 });
  const { data: product } = useQuery({ queryKey: ['product', wo?.ProductID], queryFn: () => fetchProduct(wo!.ProductID), enabled: !!wo });
  const { data: locations } = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });
  const { data: scrapReasons } = useQuery({ queryKey: ['scrap-reasons'], queryFn: fetchScrapReasons });
  const { data: bom } = useQuery({ queryKey: ['active-bom'], queryFn: fetchActiveBOM });
  const { data: allProducts } = useQuery({ queryKey: ['all-products'], queryFn: () => fetchAllProducts() });
  const { data: activeOps } = useQuery({ queryKey: ['active-operations'], queryFn: fetchActiveOperations, refetchInterval: 60_000 });
  const { data: inventory } = useQuery({ queryKey: ['product-inventory'], queryFn: () => fetchProductInventory() });

  const locationMap = useMemo(() => {
    const map = new Map<number, string>();
    locations?.forEach(l => map.set(l.LocationID, l.Name));
    return map;
  }, [locations]);

  const productMap = useMemo(() => {
    const map = new Map<number, Product>();
    (allProducts as Product[] | undefined)?.forEach(p => map.set(p.ProductID, p));
    return map;
  }, [allProducts]);

  const inventoryByProduct = useMemo(() => {
    const map = new Map<number, number>();
    (inventory as ProductInventory[] | undefined)?.forEach(i => {
      map.set(i.ProductID, (map.get(i.ProductID) || 0) + i.Quantity);
    });
    return map;
  }, [inventory]);

  const activeOp = useMemo(() => (activeOps || []).find(op => op.workOrderId === woId), [activeOps, woId]);

  const sortedRouting = useMemo(() => [...(routing || [])].sort((a, b) => a.OperationSequence - b.OperationSequence), [routing]);
  const completedOps = sortedRouting.filter(r => r.ActualEndDate != null).length;
  const totalOps = sortedRouting.length;

  // Estimate time: completed ops have actual duration, remaining use avg of completed or 3.5 min default
  const timeEstimate = useMemo(() => {
    if (totalOps === 0) return null;
    const completedDurations = sortedRouting
      .filter(r => r.ActualStartDate && r.ActualEndDate)
      .map(r => (new Date(r.ActualEndDate!).getTime() - new Date(r.ActualStartDate!).getTime()) / 60000);
    const avgOpMinutes = completedDurations.length > 0
      ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
      : 3.5;
    const elapsedCompleted = completedDurations.reduce((a, b) => a + b, 0);
    const elapsedActive = activeOp?.elapsedMinutes || 0;
    const remainingOps = totalOps - completedOps - (activeOp ? 1 : 0);
    const estimatedRemainingForActive = activeOp ? Math.max(0, avgOpMinutes - elapsedActive) : 0;
    const estimatedRemaining = estimatedRemainingForActive + (remainingOps * avgOpMinutes);
    const totalEstimate = elapsedCompleted + elapsedActive + estimatedRemaining;
    return { estimatedRemaining, totalEstimate, avgOpMinutes, elapsedTotal: elapsedCompleted + elapsedActive };
  }, [sortedRouting, activeOp, totalOps, completedOps]);

  const progress = wo ? (wo.EndDate ? 100 : totalOps > 0
    ? ((completedOps + (activeOp ? 0.5 : 0)) / totalOps) * 100
    : 0) : 0;

  if (isLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;
  if (!wo) return <div className="container mx-auto px-4 py-8 font-doodle">Work order not found</div>;

  const scrapReason = wo.ScrapReasonID ? scrapReasons?.find(s => s.ScrapReasonID === wo.ScrapReasonID) : null;
  const components = bom?.filter(b => b.ProductAssemblyID === wo.ProductID) || [];

  const simStatus = wo.EndDate ? 'Completed' : activeOp ? 'In Progress' : wo.StockedQty > 0 ? 'Partial' : 'Planned';

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/execute" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Manufacturing Dashboard
      </Link>

      {/* Header */}
      <div className="doodle-card-static p-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="font-doodle text-2xl font-bold text-doodle-text">WO #{wo.WorkOrderID}</h1>
            <p className="font-doodle text-doodle-blue">{product?.Name}</p>
          </div>
          <span className={`font-doodle text-xs font-bold px-3 py-1 rounded-full border-2 border-doodle-text ${
            simStatus === 'In Progress' ? 'bg-doodle-green/20 text-doodle-green' :
            simStatus === 'Completed' ? 'bg-doodle-blue/20 text-doodle-blue' :
            'bg-secondary text-muted-foreground'
          }`}>
            {simStatus === 'In Progress' && <Activity className="w-3 h-3 inline mr-1" />}
            {simStatus}
          </span>
        </div>

        {/* Live simulation info */}
        {activeOp && (
          <div className="mt-4 p-3 border-2 border-doodle-green/30 bg-doodle-green/5 rounded">
            <div className="flex items-center gap-2 mb-1">
              <Activity className="w-4 h-4 text-doodle-green animate-pulse" />
              <span className="font-doodle text-sm font-bold text-doodle-green">Live — Currently Processing</span>
            </div>
            <div className="grid grid-cols-2 gap-2 font-doodle text-xs">
              <div><span className="text-muted-foreground">Station:</span> {activeOp.locationName}</div>
              <div><span className="text-muted-foreground">Operation:</span> Step {activeOp.operationSequence}</div>
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-muted-foreground">Elapsed:</span> {activeOp.elapsedMinutes.toFixed(1)} min
              </div>
            </div>
          </div>
        )}

        {/* Time Estimate */}
        {timeEstimate && simStatus !== 'Completed' && (
          <div className="mt-4 p-3 border-2 border-doodle-blue/30 bg-doodle-blue/5 rounded">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Timer className="w-4 h-4 text-doodle-blue" />
                <span className="font-doodle text-sm font-bold text-doodle-blue">
                  {simStatus === 'In Progress' ? 'Est. remaining' : 'Est. total time'}
                </span>
              </div>
              <span className="font-doodle text-lg font-bold text-doodle-blue">
                ~{timeEstimate.estimatedRemaining.toFixed(1)} min
              </span>
            </div>
            {simStatus === 'In Progress' && (
              <p className="font-doodle text-xs text-muted-foreground mt-1">
                {timeEstimate.elapsedTotal.toFixed(1)} min elapsed · ~{timeEstimate.avgOpMinutes.toFixed(1)} min avg per op · {totalOps - completedOps - 1} ops remaining after current
              </p>
            )}
            {simStatus === 'Planned' && (
              <p className="font-doodle text-xs text-muted-foreground mt-1">
                {totalOps} operations · ~{timeEstimate.avgOpMinutes.toFixed(1)} min avg per op (based on {completedOps > 0 ? 'actuals' : 'estimate'})
              </p>
            )}
          </div>
        )}
        {timeEstimate && simStatus === 'Completed' && (
          <div className="mt-4 p-3 border-2 border-doodle-green/30 bg-doodle-green/5 rounded">
            <div className="flex items-center justify-between">
              <Timer className="w-4 h-4 text-doodle-green" />
              <span className="font-doodle text-sm text-doodle-green">
                Completed in {timeEstimate.elapsedTotal.toFixed(1)} min across {totalOps} operations
              </span>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-2">
          <div className="flex justify-between font-doodle text-sm">
            <span>Operations: {completedOps} / {totalOps} complete{activeOp ? ` (1 active)` : ''}</span>
            <span className="font-bold">{Math.min(100, progress).toFixed(0)}%</span>
          </div>
          <div className="w-full h-4 bg-secondary border-2 border-doodle-text rounded-sm overflow-hidden">
            <div className="h-full bg-doodle-green transition-all" style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
        </div>
        {wo.ScrappedQty > 0 && (
          <p className="font-doodle text-sm text-doodle-accent mt-3">
            <AlertTriangle className="w-3 h-3 inline mr-1" />
            {wo.ScrappedQty} scrapped {scrapReason ? `— ${scrapReason.Name}` : ''}
          </p>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Component Consumption */}
        <div className="doodle-card-static p-6">
          <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Component Consumption</h2>
          {components.length === 0 ? (
            <p className="font-doodle text-sm text-muted-foreground">No BOM data for this product</p>
          ) : (
            <div className="space-y-2">
              {components.map((c) => {
                const comp = productMap.get(c.ComponentID);
                const needed = c.PerAssemblyQty * wo.OrderQty;
                const stock = inventoryByProduct.get(c.ComponentID) || 0;
                const sufficient = stock >= needed;
                return (
                  <div key={c.BillOfMaterialsID} className="flex justify-between items-center py-2 border-b border-dashed border-doodle-text/10">
                    <div>
                      <Link to={`/receive/inventory/${c.ComponentID}`} className="font-doodle text-sm font-bold text-doodle-blue hover:underline">
                        {comp?.Name || `#${c.ComponentID}`}
                      </Link>
                      <p className="font-doodle text-xs text-muted-foreground">
                        {c.PerAssemblyQty} {c.UnitMeasureCode} × {wo.OrderQty} = {needed.toFixed(1)} needed
                        {comp?.StandardCost ? ` · $${(comp.StandardCost * needed).toFixed(2)}` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`font-doodle text-sm font-bold ${sufficient ? 'text-doodle-green' : 'text-doodle-accent'}`}>
                        {stock.toLocaleString()} in stock
                      </p>
                      {!sufficient && (
                        <p className="font-doodle text-xs text-doodle-accent">
                          <AlertTriangle className="w-3 h-3 inline mr-0.5" />short {(needed - stock).toFixed(0)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Routing Operations */}
        <div className="doodle-card-static p-6">
          <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Routing Operations</h2>
          {sortedRouting.length === 0 ? (
            <p className="font-doodle text-sm text-muted-foreground">No routing data</p>
          ) : (
            <div className="space-y-3">
              {sortedRouting.map((r) => {
                const isActive = activeOp?.operationSequence === r.OperationSequence;
                const overBudget = r.ActualCost != null && r.ActualCost > r.PlannedCost;
                return (
                  <div key={r.OperationSequence} className={`p-3 border-2 rounded ${
                    isActive ? 'border-doodle-green bg-doodle-green/5' : 'border-doodle-text/10'
                  }`}>
                    <div className="flex justify-between mb-1">
                      <span className="font-doodle text-sm font-bold">
                        {isActive && <Activity className="w-3 h-3 inline mr-1 text-doodle-green animate-pulse" />}
                        Op {r.OperationSequence}
                      </span>
                      <span className="font-doodle text-xs text-muted-foreground">{locationMap.get(r.LocationID)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs font-doodle">
                      <div><span className="text-muted-foreground">Planned:</span> ${r.PlannedCost.toFixed(2)}</div>
                      <div className={overBudget ? 'text-doodle-accent font-bold' : ''}>
                        <span className="text-muted-foreground">Actual:</span> {r.ActualCost != null ? `$${r.ActualCost.toFixed(2)}` : '—'}
                      </div>
                      <div><span className="text-muted-foreground">Actual Hrs:</span> {r.ActualResourceHrs != null ? r.ActualResourceHrs.toFixed(2) : '—'}</div>
                      {isActive && (
                        <div className="text-doodle-green font-bold">
                          <Clock className="w-3 h-3 inline mr-1" />
                          {activeOp!.elapsedMinutes.toFixed(1)} min
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Production History Timeline */}
      <div className="doodle-card-static p-6">
        <h2 className="font-doodle text-lg font-bold text-doodle-text mb-6">
          <Timer className="w-5 h-5 inline mr-2" />
          Production Timeline
        </h2>
        {sortedRouting.length === 0 ? (
          <p className="font-doodle text-sm text-muted-foreground">No routing data available</p>
        ) : (
          <div className="relative">
            {sortedRouting.map((r, idx) => {
              const isActive = activeOp?.operationSequence === r.OperationSequence;
              const isCompleted = r.ActualEndDate != null;
              const isStarted = r.ActualStartDate != null;
              const isLast = idx === sortedRouting.length - 1;

              const startTime = r.ActualStartDate ? new Date(r.ActualStartDate) : null;
              const endTime = r.ActualEndDate ? new Date(r.ActualEndDate) : null;
              const durationMs = startTime && endTime ? endTime.getTime() - startTime.getTime() : null;
              const durationMin = durationMs ? (durationMs / 60000).toFixed(1) : null;

              return (
                <div key={r.OperationSequence} className="flex gap-4">
                  {/* Timeline rail */}
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      isCompleted ? 'border-doodle-green bg-doodle-green/20' :
                      isActive ? 'border-doodle-green bg-doodle-green/10 animate-pulse' :
                      'border-doodle-text/20 bg-secondary'
                    }`}>
                      {isCompleted ? <CheckCircle2 className="w-4 h-4 text-doodle-green" /> :
                       isActive ? <Activity className="w-4 h-4 text-doodle-green" /> :
                       <Circle className="w-4 h-4 text-muted-foreground" />}
                    </div>
                    {!isLast && (
                      <div className={`w-0.5 flex-1 min-h-[2rem] ${
                        isCompleted ? 'bg-doodle-green' : 'bg-doodle-text/10'
                      }`} />
                    )}
                  </div>

                  {/* Content */}
                  <div className={`pb-6 flex-1 ${isLast ? 'pb-0' : ''}`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <span className="font-doodle text-sm font-bold text-doodle-text">
                          Op {r.OperationSequence} — {locationMap.get(r.LocationID) || `Location ${r.LocationID}`}
                        </span>
                        {isActive && <span className="font-doodle text-xs text-doodle-green font-bold ml-2">● LIVE</span>}
                      </div>
                      {durationMin && (
                        <span className="font-doodle text-xs bg-doodle-green/10 text-doodle-green px-2 py-0.5 rounded border border-doodle-green/30">
                          {durationMin} min
                        </span>
                      )}
                      {isActive && activeOp && (
                        <span className="font-doodle text-xs bg-doodle-blue/10 text-doodle-blue px-2 py-0.5 rounded border border-doodle-blue/30">
                          {activeOp.elapsedMinutes.toFixed(1)} min elapsed
                        </span>
                      )}
                    </div>
                    <div className="font-doodle text-xs text-muted-foreground mt-1 space-y-0.5">
                      {startTime && (
                        <p>Started: {startTime.toLocaleString()}</p>
                      )}
                      {endTime && (
                        <p>Completed: {endTime.toLocaleString()}</p>
                      )}
                      {!isStarted && !isActive && (
                        <p className="italic">Waiting</p>
                      )}
                      {r.ActualCost != null && (
                        <p>Cost: ${r.ActualCost.toFixed(2)} {r.ActualCost > r.PlannedCost ? <span className="text-doodle-accent font-bold">(over budget)</span> : <span className="text-doodle-green">(on budget)</span>}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default ExecuteWorkOrder;
