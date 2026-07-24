import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ArrowLeft, CheckCircle, Circle, AlertCircle } from 'lucide-react';
import { fetchWorkOrder, fetchWorkOrderRouting, fetchProduct, fetchLocations, fetchScrapReasons, fetchRoutingByProduct } from '@/services/api';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import type { WorkOrder } from '@/types/production';

const getStatus = (wo: WorkOrder) => {
  if (wo.ScrappedQty > 0 && wo.StockedQty === 0) return 'Scrapped';
  if (wo.EndDate || wo.StockedQty >= wo.OrderQty) return 'Completed';
  if (new Date(wo.StartDate) <= new Date()) return 'In Progress';
  return 'Planned';
};

const PlanWorkOrderDetail = () => {
  const { id } = useParams();
  const woId = Number(id);

  const { data: wo, isLoading } = useQuery({ queryKey: ['work-order', woId], queryFn: () => fetchWorkOrder(woId), refetchInterval: 120_000 });
  const { data: routing } = useQuery({ queryKey: ['wo-routing', woId], queryFn: () => fetchWorkOrderRouting(woId), enabled: !!wo, refetchInterval: 120_000 });
  const { data: productRouting } = useQuery({ queryKey: ['product-routing', wo?.ProductID], queryFn: () => fetchRoutingByProduct(wo!.ProductID), enabled: !!wo });
  const { data: product } = useQuery({ queryKey: ['product', wo?.ProductID], queryFn: () => fetchProduct(wo!.ProductID), enabled: !!wo });
  const { data: locations } = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });
  const { data: scrapReasons } = useQuery({ queryKey: ['scrap-reasons'], queryFn: fetchScrapReasons });

  const locationMap = useMemo(() => {
    const map = new Map<number, string>();
    locations?.forEach(l => map.set(l.LocationID, l.Name));
    return map;
  }, [locations]);

  if (isLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;
  if (!wo) return <div className="container mx-auto px-4 py-8 font-doodle">Work order not found</div>;

  const status = getStatus(wo);
  const scrapReason = wo.ScrapReasonID ? scrapReasons?.find(s => s.ScrapReasonID === wo.ScrapReasonID) : null;
  const sortedRouting = [...(routing || [])].sort((a, b) => a.OperationSequence - b.OperationSequence);

  const statusSteps = ['Planned', 'In Progress', 'Completed'];
  const currentStep = status === 'Scrapped' ? -1 : statusSteps.indexOf(status);

  const progress = wo.OrderQty > 0 ? ((wo.StockedQty / wo.OrderQty) * 100) : 0;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/plan" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Work Orders
      </Link>

      <div className="doodle-card-static p-6">
        <div className="flex flex-col md:flex-row justify-between gap-4">
          <div>
            <h1 className="font-doodle text-2xl font-bold text-doodle-text">Work Order #{wo.WorkOrderID}</h1>
            <Link to={`/define/products/${wo.ProductID}`} className="font-doodle text-doodle-blue hover:underline">{product?.Name || `Product #${wo.ProductID}`}</Link>
          </div>
          <div className="flex gap-6 text-center">
            <div><p className="font-doodle text-xs text-muted-foreground">Order Qty</p><p className="font-doodle text-xl font-bold">{wo.OrderQty}</p></div>
            <div><p className="font-doodle text-xs text-muted-foreground">Stocked</p><p className="font-doodle text-xl font-bold text-doodle-green">{wo.StockedQty}</p></div>
            <div><p className="font-doodle text-xs text-muted-foreground">Scrapped</p><p className="font-doodle text-xl font-bold text-doodle-accent">{wo.ScrappedQty}</p></div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-4 space-y-2">
          <div className="flex justify-between font-doodle text-sm">
            <span>Progress: {wo.StockedQty} / {wo.OrderQty}</span>
            <span className="font-bold">{Math.min(100, progress).toFixed(0)}%</span>
          </div>
          <div className="w-full h-4 bg-secondary border-2 border-doodle-text rounded-sm overflow-hidden">
            <div className="h-full bg-doodle-green transition-all" style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
        </div>

        {/* Status stepper */}
        <div className="flex items-center gap-4 mt-6 py-4 border-t border-dashed border-doodle-text/20">
          {status === 'Scrapped' ? (
            <div className="flex items-center gap-2">
              <AlertCircle className="w-6 h-6 text-doodle-accent" />
              <span className="font-doodle font-bold text-doodle-accent">SCRAPPED</span>
              {scrapReason && <span className="font-doodle text-sm text-muted-foreground">— {scrapReason.Name}</span>}
            </div>
          ) : (
            statusSteps.map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                {i <= currentStep ? <CheckCircle className="w-5 h-5 text-doodle-green" /> : <Circle className="w-5 h-5 text-muted-foreground" />}
                <span className={`font-doodle text-sm ${i <= currentStep ? 'font-bold text-doodle-text' : 'text-muted-foreground'}`}>{step}</span>
                {i < statusSteps.length - 1 && <span className="text-muted-foreground">→</span>}
              </div>
            ))
          )}
        </div>

        <p className="font-doodle text-xs text-muted-foreground mt-2 italic">
          Status transitions are managed automatically as the factory runs.
        </p>

        <div className="grid md:grid-cols-3 gap-4 mt-4 text-sm">
          <div className="font-doodle"><span className="text-muted-foreground">Start:</span> {new Date(wo.StartDate).toLocaleDateString()}</div>
          <div className="font-doodle"><span className="text-muted-foreground">Due:</span> {new Date(wo.DueDate).toLocaleDateString()}</div>
          <div className="font-doodle"><span className="text-muted-foreground">End:</span> {wo.EndDate ? new Date(wo.EndDate).toLocaleDateString() : 'In progress'}</div>
        </div>
      </div>

      {/* Routing Schedule - read only */}
      <div className="doodle-card-static p-6">
        <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Routing Schedule</h2>
        {sortedRouting.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full font-doodle text-sm">
              <thead>
                <tr className="border-b-2 border-doodle-text/20">
                  <th className="text-left py-2 px-3">Op#</th>
                  <th className="text-left py-2 px-3">Location</th>
                  <th className="text-left py-2 px-3">Scheduled Start</th>
                  <th className="text-left py-2 px-3">Scheduled End</th>
                  <th className="text-left py-2 px-3">Actual Start</th>
                  <th className="text-left py-2 px-3">Actual End</th>
                  <th className="text-right py-2 px-3">Planned $</th>
                  <th className="text-right py-2 px-3">Actual $</th>
                  <th className="text-right py-2 px-3">Actual Hrs</th>
                </tr>
              </thead>
              <tbody>
                {sortedRouting.map((r) => {
                  const overBudget = r.ActualCost != null && r.ActualCost > r.PlannedCost;
                  const isActive = r.ActualStartDate && !r.ActualEndDate;
                  return (
                    <tr key={`${r.WorkOrderID}-${r.OperationSequence}`} className={`border-b border-doodle-text/10 ${isActive ? 'bg-doodle-green/10' : ''}`}>
                      <td className="py-2 px-3 font-bold">{r.OperationSequence} {isActive && '🔄'}</td>
                      <td className="py-2 px-3">{locationMap.get(r.LocationID) || `#${r.LocationID}`}</td>
                      <td className="py-2 px-3">{new Date(r.ScheduledStartDate).toLocaleDateString()}</td>
                      <td className="py-2 px-3">{new Date(r.ScheduledEndDate).toLocaleDateString()}</td>
                      <td className="py-2 px-3">{r.ActualStartDate ? new Date(r.ActualStartDate).toLocaleString() : '—'}</td>
                      <td className="py-2 px-3">{r.ActualEndDate ? new Date(r.ActualEndDate).toLocaleString() : '—'}</td>
                      <td className="text-right py-2 px-3">${r.PlannedCost.toFixed(2)}</td>
                      <td className={`text-right py-2 px-3 ${overBudget ? 'text-doodle-accent font-bold' : ''}`}>{r.ActualCost != null ? `$${r.ActualCost.toFixed(2)}` : '—'}</td>
                      <td className="text-right py-2 px-3">{r.ActualResourceHrs != null ? r.ActualResourceHrs.toFixed(2) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="font-doodle text-sm text-muted-foreground">No routing steps yet — they'll be created when this work order is processed on the shop floor.</p>
        )}
      </div>

      {/* Product-level Routing History */}
      {(() => {
        const otherRouting = (productRouting || []).filter(r => r.WorkOrderID !== woId);
        const woGroups = new Map<number, typeof otherRouting>();
        otherRouting.forEach(r => {
          if (!woGroups.has(r.WorkOrderID)) woGroups.set(r.WorkOrderID, []);
          woGroups.get(r.WorkOrderID)!.push(r);
        });
        if (woGroups.size === 0) return null;
        const sortedAllRouting = [...(productRouting || [])].sort((a, b) => a.OperationSequence - b.OperationSequence);
        const uniqueOps = [...new Map(sortedAllRouting.map(r => [`${r.LocationID}-${r.OperationSequence}`, r])).values()];

        return (
          <div className="doodle-card-static p-6">
            <h2 className="font-doodle text-lg font-bold text-doodle-text mb-2">Product Routing History</h2>
            <p className="font-doodle text-xs text-muted-foreground mb-4">
              All routing operations across {woGroups.size + (sortedRouting.length > 0 ? 1 : 0)} work order(s) for this product.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full font-doodle text-sm">
                <thead>
                  <tr className="border-b-2 border-doodle-text/20">
                    <th className="text-left py-2 px-3">Op#</th>
                    <th className="text-left py-2 px-3">Location</th>
                    <th className="text-right py-2 px-3">Avg Planned $</th>
                    <th className="text-right py-2 px-3">Avg Actual $</th>
                    <th className="text-right py-2 px-3">Avg Hrs</th>
                    <th className="text-right py-2 px-3">Used In WOs</th>
                  </tr>
                </thead>
                <tbody>
                  {uniqueOps.map((op) => {
                    const matching = (productRouting || []).filter(r => r.LocationID === op.LocationID && r.OperationSequence === op.OperationSequence);
                    const avgPlanned = matching.reduce((s, r) => s + r.PlannedCost, 0) / matching.length;
                    const actuals = matching.filter(r => r.ActualCost != null);
                    const avgActual = actuals.length > 0 ? actuals.reduce((s, r) => s + (r.ActualCost || 0), 0) / actuals.length : null;
                    const hrsEntries = matching.filter(r => r.ActualResourceHrs != null);
                    const avgHrs = hrsEntries.length > 0 ? hrsEntries.reduce((s, r) => s + (r.ActualResourceHrs || 0), 0) / hrsEntries.length : null;
                    return (
                      <tr key={`${op.LocationID}-${op.OperationSequence}`} className="border-b border-doodle-text/10">
                        <td className="py-2 px-3 font-bold">{op.OperationSequence}</td>
                        <td className="py-2 px-3">{locationMap.get(op.LocationID) || `#${op.LocationID}`}</td>
                        <td className="text-right py-2 px-3">${avgPlanned.toFixed(2)}</td>
                        <td className="text-right py-2 px-3">{avgActual != null ? `$${avgActual.toFixed(2)}` : '—'}</td>
                        <td className="text-right py-2 px-3">{avgHrs != null ? avgHrs.toFixed(2) : '—'}</td>
                        <td className="text-right py-2 px-3">{matching.length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      <div className="flex gap-3">
        <Link to={`/execute/work-order/${woId}`} className="doodle-button doodle-button-accent text-sm">Execution View →</Link>
        <Link to={`/engineer/bom/${wo.ProductID}`} className="doodle-button text-sm">View BOM →</Link>
      </div>
    </div>
  );
};

export default PlanWorkOrderDetail;
