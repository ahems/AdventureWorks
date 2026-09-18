import { useQuery, useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchWorkOrders, fetchWorkOrder, fetchManufacturedProducts, fetchActiveOperations, fetchWorkOrderRouting, fetchManufacturingStatus, fetchLocations } from '@/services/api';
import type { WorkOrder, WorkOrderRouting } from '@/types/production';
import { useMemo, useState } from 'react';
import { Clock, ArrowUpDown, Activity, CircleDot } from 'lucide-react';
import { ShopFloorSkeleton } from '@/components/LoadingSkeletons';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';

type SortMode = 'eta' | 'due-date';

interface StationInfo {
  locationId: number;
  locationName: string;
  activeCount: number;
  queueCount: number;
  capacity: number;
  earliestFreeSlotUtc: string | null;
}

const ExecuteShopFloor = () => {
  const [sortBy, setSortBy] = useState<SortMode>('eta');
  const [drawerStationId, setDrawerStationId] = useState<number | null>(null);
  const { data: workOrders, isLoading } = useQuery({ queryKey: ['work-orders'], queryFn: fetchWorkOrders });
  const { data: products } = useQuery({ queryKey: ['manufactured-products'], queryFn: fetchManufacturedProducts });
  const { data: activeOps } = useQuery({ queryKey: ['active-operations'], queryFn: fetchActiveOperations, refetchInterval: 60_000 });
  const { data: mfgStatus } = useQuery({ queryKey: ['manufacturing-status'], queryFn: fetchManufacturingStatus, refetchInterval: 60_000 });
  const { data: locations } = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });

  const productMap = useMemo(() => {
    const map = new Map<number, string>();
    products?.forEach(p => map.set(p.ProductID, p.Name));
    return map;
  }, [products]);

  const locationNameMap = useMemo(() => {
    const map = new Map<number, string>();
    locations?.forEach(l => map.set(l.LocationID, l.Name));
    (activeOps || []).forEach(op => { if (!map.has(op.locationId)) map.set(op.locationId, op.locationName); });
    (mfgStatus?.locationLoad || []).forEach(l => { if (!map.has(l.locationId)) map.set(l.locationId, l.locationName); });
    return map;
  }, [locations, activeOps, mfgStatus]);

  const activeWoIds = useMemo(() => Array.from(new Set((activeOps || []).map(op => op.workOrderId))), [activeOps]);

  // Some active work orders may not appear in the most-recent-500 list returned by fetchWorkOrders.
  // Fetch any missing ones by ID directly so the shop floor always reflects what's actually running.
  const knownWoMap = useMemo(() => {
    const m = new Map<number, WorkOrder>();
    (workOrders || []).forEach(wo => m.set(wo.WorkOrderID, wo));
    return m;
  }, [workOrders]);

  const missingWoIds = useMemo(
    () => activeWoIds.filter(id => !knownWoMap.has(id)),
    [activeWoIds, knownWoMap]
  );

  const missingWoQueries = useQueries({
    queries: missingWoIds.map(id => ({
      queryKey: ['work-order', id],
      queryFn: () => fetchWorkOrder(id),
      staleTime: 30_000,
    })),
  });

  const activeOrders = useMemo(() => {
    const fetched = missingWoQueries
      .map(q => q.data)
      .filter((wo): wo is WorkOrder => !!wo);
    const merged: WorkOrder[] = [];
    activeWoIds.forEach(id => {
      const wo = knownWoMap.get(id) || fetched.find(w => w.WorkOrderID === id);
      if (wo) merged.push(wo);
    });
    return merged.sort((a, b) => new Date(a.DueDate).getTime() - new Date(b.DueDate).getTime());
  }, [activeWoIds, knownWoMap, missingWoQueries]);

  // Fetch routing for each active WO
  const routingQueries = useQueries({
    queries: activeOrders.map(wo => ({
      queryKey: ['wo-routing', wo.WorkOrderID],
      queryFn: () => fetchWorkOrderRouting(wo.WorkOrderID),
      refetchInterval: 120_000,
    })),
  });

  // Full sorted routing per WO (used by the station drawer to show remaining steps).
  const woRoutingMap = useMemo(() => {
    const map = new Map<number, WorkOrderRouting[]>();
    activeOrders.forEach((wo, idx) => {
      const routing = routingQueries[idx]?.data;
      if (!routing) return;
      map.set(wo.WorkOrderID, [...routing].sort((a, b) => a.OperationSequence - b.OperationSequence));
    });
    return map;
  }, [activeOrders, routingQueries]);

  // Per-WO derived info: progress, ETA, and the next pending station (after the currently-active op).
  const woInfoMap = useMemo(() => {
    const map = new Map<number, {
      completedOps: number;
      totalOps: number;
      estimatedRemaining: number;
      nextLocationId: number | null;
      nextLocationName: string | null;
    }>();
    activeOrders.forEach((wo, idx) => {
      const routing = routingQueries[idx]?.data;
      if (!routing || routing.length === 0) return;
      const sorted = [...routing].sort((a, b) => a.OperationSequence - b.OperationSequence);
      const completed = sorted.filter(r => r.ActualEndDate != null);
      const completedDurations = completed
        .filter(r => r.ActualStartDate && r.ActualEndDate)
        .map(r => (new Date(r.ActualEndDate!).getTime() - new Date(r.ActualStartDate!).getTime()) / 60000);
      const avgOpMin = completedDurations.length > 0
        ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
        : 3.5;
      const op = (activeOps || []).find(o => o.workOrderId === wo.WorkOrderID);
      const elapsed = op?.elapsedMinutes || 0;
      const remainingOps = sorted.length - completed.length - (op ? 1 : 0);
      const remainingForActive = op ? Math.max(0, avgOpMin - elapsed) : 0;
      const estimatedRemaining = remainingForActive + (remainingOps * avgOpMin);

      // Next pending op = first op after the active one (or first not-started op if nothing active).
      const activeSeq = op?.operationSequence ?? -Infinity;
      const nextOp = sorted.find(r => r.ActualEndDate == null && r.ActualStartDate == null && r.OperationSequence > activeSeq)
        ?? sorted.find(r => r.ActualEndDate == null && r.ActualStartDate == null);
      map.set(wo.WorkOrderID, {
        completedOps: completed.length,
        totalOps: sorted.length,
        estimatedRemaining,
        nextLocationId: nextOp?.LocationID ?? null,
        nextLocationName: nextOp ? (locationNameMap.get(nextOp.LocationID) || `Location ${nextOp.LocationID}`) : null,
      });
    });
    return map;
  }, [activeOrders, routingQueries, activeOps, locationNameMap]);

  // Per-station aggregation
  const stations = useMemo<StationInfo[]>(() => {
    const agg = new Map<number, StationInfo>();
    const ensure = (id: number, name: string) => {
      if (!agg.has(id)) agg.set(id, { locationId: id, locationName: name, activeCount: 0, queueCount: 0, capacity: 0, earliestFreeSlotUtc: null });
      return agg.get(id)!;
    };

    // Capacity / availability from manufacturing status
    (mfgStatus?.locationLoad || []).forEach(l => {
      const s = ensure(l.locationId, l.locationName);
      s.capacity = l.capacityUnits;
      s.earliestFreeSlotUtc = l.earliestFreeSlotUtc;
    });

    // Active ops
    (activeOps || []).forEach(op => {
      const s = ensure(op.locationId, op.locationName);
      s.activeCount += 1;
    });

    // Queue: WOs whose next pending op points to this station
    activeOrders.forEach(wo => {
      const info = woInfoMap.get(wo.WorkOrderID);
      if (info?.nextLocationId != null) {
        const s = ensure(info.nextLocationId, info.nextLocationName || `Location ${info.nextLocationId}`);
        s.queueCount += 1;
      }
    });

    return Array.from(agg.values())
      .filter(s => s.activeCount > 0 || s.queueCount > 0 || s.capacity > 0)
      .sort((a, b) => (b.activeCount + b.queueCount) - (a.activeCount + a.queueCount) || a.locationName.localeCompare(b.locationName));
  }, [mfgStatus, activeOps, activeOrders, woInfoMap]);

  const sortedOrders = useMemo(() => {
    if (sortBy === 'eta') {
      return [...activeOrders].sort((a, b) => {
        const etaA = woInfoMap.get(a.WorkOrderID)?.estimatedRemaining ?? Infinity;
        const etaB = woInfoMap.get(b.WorkOrderID)?.estimatedRemaining ?? Infinity;
        return etaA - etaB;
      });
    }
    return activeOrders; // already sorted by due date
  }, [activeOrders, woInfoMap, sortBy]);

  const visibleOrders = sortedOrders;

  const loadTone = (s: StationInfo) => {
    const ratio = s.capacity > 0 ? s.queueCount / s.capacity : s.queueCount;
    if (ratio > 2) return { border: 'border-doodle-accent', bar: 'bg-doodle-accent', tag: 'bg-doodle-accent/15 text-doodle-accent' };
    if (ratio > 1) return { border: 'border-doodle-text', bar: 'bg-doodle-blue', tag: 'bg-doodle-blue/15 text-doodle-blue' };
    return { border: 'border-doodle-text', bar: 'bg-doodle-green', tag: 'bg-doodle-green/15 text-doodle-green' };
  };

  const formatFreeIn = (iso: string | null) => {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) return null;
    if (ms <= 0) return 'Free now';
    const mins = ms / 60000;
    if (mins < 60) return `Free in ~${mins.toFixed(0)} min`;
    return `Free in ~${(mins / 60).toFixed(1)} hr`;
  };

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">4. Execute — Shop Floor</h1>
          <p className="font-doodle text-sm text-muted-foreground">Active work orders in production</p>
        </div>
        <div className="flex gap-2">
          <Link to="/execute" className="doodle-button text-sm">← Manufacturing Dashboard</Link>
          <Link to="/execute/tracker" className="doodle-button text-sm">🚲 Finished Good Tracker</Link>
        </div>
      </div>

      {/* Simulator-wide KPI strip — explains why Shop Floor can look quiet while Queue Depth is high */}
      {mfgStatus && (() => {
        const queueDepth = mfgStatus.queueDepth ?? 0;
        const running = mfgStatus.inProgressWorkOrders ?? 0;
        const stalled = mfgStatus.stalledForMaterials ?? 0;
        const shortageSkus = mfgStatus.shortages?.length ?? 0;
        const stalledTone = stalled > 0 ? 'border-doodle-accent' : 'border-doodle-text/30';
        const stalledText = stalled > 0 ? 'text-doodle-accent' : 'text-doodle-text';
        const shortageTone = shortageSkus > 0 ? 'border-doodle-accent' : 'border-doodle-text/30';
        const shortageText = shortageSkus > 0 ? 'text-doodle-accent' : 'text-doodle-text';
        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 border-2 border-dashed border-doodle-text/30 rounded-sm bg-card">
              <p className="font-doodle text-[11px] text-muted-foreground">In queue</p>
              <p className="font-doodle text-2xl font-bold text-doodle-text">{queueDepth}</p>
              <p className="font-doodle text-[11px] text-muted-foreground">Total WOs the Factory is working on</p>
            </div>
            <div className="p-3 border-2 border-dashed border-doodle-green/60 rounded-sm bg-card">
              <p className="font-doodle text-[11px] text-muted-foreground">Running now</p>
              <p className="font-doodle text-2xl font-bold text-doodle-green">{running}</p>
              <p className="font-doodle text-[11px] text-muted-foreground">Active on a station — shown below</p>
            </div>
            <Link to="/execute?tab=shortages" className={`p-3 border-2 border-dashed rounded-sm bg-card hover:bg-secondary/50 transition-colors ${stalledTone}`}>
              <p className="font-doodle text-[11px] text-muted-foreground">Stalled (materials)</p>
              <p className={`font-doodle text-2xl font-bold ${stalledText}`}>{stalled}</p>
              <p className="font-doodle text-[11px] text-muted-foreground">Waiting on components → see shortages</p>
            </Link>
            <Link to="/execute?tab=shortages" className={`p-3 border-2 border-dashed rounded-sm bg-card hover:bg-secondary/50 transition-colors ${shortageTone}`}>
              <p className="font-doodle text-[11px] text-muted-foreground">Shortage SKUs</p>
              <p className={`font-doodle text-2xl font-bold ${shortageText}`}>{shortageSkus}</p>
              <p className="font-doodle text-[11px] text-muted-foreground">Distinct components short</p>
            </Link>
          </div>
        );
      })()}

      {/* Station strip — per-location queue / capacity / availability */}
      {stations.length > 0 && (
        <div>
          <div className="flex items-end justify-between mb-2">
            <h2 className="font-doodle text-sm font-bold text-doodle-text">Stations</h2>
            <span className="font-doodle text-[11px] text-muted-foreground">Click a station for details</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {stations.map(s => {
              const tone = loadTone(s);
              const ratio = s.capacity > 0 ? Math.min(100, (s.queueCount / s.capacity) * 100) : Math.min(100, s.queueCount * 25);
              const freeLabel = formatFreeIn(s.earliestFreeSlotUtc);
              return (
                <button
                  key={s.locationId}
                  onClick={() => setDrawerStationId(s.locationId)}
                  className={`text-left p-3 border-2 border-dashed rounded-sm transition-colors ${tone.border} bg-card hover:bg-secondary/50`}
                >
                  <div className="flex justify-between items-start gap-2 mb-1">
                    <span className="font-doodle text-xs font-bold text-doodle-text truncate">{s.locationName}</span>
                    <span className={`font-doodle text-[10px] px-1.5 py-0.5 rounded-full ${tone.tag} shrink-0`}>
                      {s.queueCount} queued
                    </span>
                  </div>
                  <p className="font-doodle text-[11px] text-muted-foreground">
                    Active {s.activeCount}{s.capacity > 0 ? ` / ${s.capacity}` : ''}
                  </p>
                  <div className="w-full h-2 bg-secondary border border-doodle-text/40 rounded-sm overflow-hidden mt-1.5">
                    <div className={`h-full transition-all ${tone.bar}`} style={{ width: `${ratio}%` }} />
                  </div>
                  {freeLabel && (
                    <p className="font-doodle text-[11px] text-muted-foreground mt-1">{freeLabel}</p>
                  )}
                </button>
              );
            })}
          </div>
          <p className="font-doodle text-[11px] text-muted-foreground mt-2 italic">
            Stations show what's running now. Material-blocked work orders don't appear here — see <strong>Stalled</strong> above.
          </p>
        </div>
      )}

      {activeOrders.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="font-doodle text-xs text-muted-foreground">Sort by:</span>
          <button
            onClick={() => setSortBy(sortBy === 'eta' ? 'due-date' : 'eta')}
            className="inline-flex items-center gap-1 font-doodle text-xs px-3 py-1.5 border-2 border-doodle-text rounded hover:bg-secondary transition-colors"
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortBy === 'eta' ? 'Finishing soonest' : 'Due date'}
          </button>
        </div>
      )}

      {isLoading ? (
        <ShopFloorSkeleton />
      ) : visibleOrders.length === 0 ? (
        <div className="doodle-card-static p-8 text-center">
          <p className="font-doodle text-lg text-muted-foreground">No active work orders on the floor</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleOrders.map((wo) => {
            const op = (activeOps || []).find(o => o.workOrderId === wo.WorkOrderID);
            const info = woInfoMap.get(wo.WorkOrderID);
            const completedOps = info?.completedOps ?? 0;
            const totalOps = info?.totalOps ?? 0;
            const progress = totalOps > 0 ? Math.min(100, ((completedOps + (op ? 0.5 : 0)) / totalOps) * 100) : 0;
            const pctStr = progress.toFixed(0);
            return (
              <Link key={wo.WorkOrderID} to={`/execute/work-order/${wo.WorkOrderID}`} className="doodle-card p-5 block">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-doodle text-xs text-doodle-blue font-bold">WO #{wo.WorkOrderID}</span>
                  <span className="font-doodle text-xs text-muted-foreground">Due {new Date(wo.DueDate).toLocaleDateString()}</span>
                </div>
                <h3 className="font-doodle text-sm font-bold text-doodle-text mb-1">{productMap.get(wo.ProductID) || `Product #${wo.ProductID}`}</h3>
                {op && (
                  <p className="font-doodle text-xs text-doodle-green mb-1">
                    ● Op {op.operationSequence} — {op.locationName} ({op.elapsedMinutes.toFixed(1)} min)
                  </p>
                )}
                {info?.nextLocationName && (
                  <p className="font-doodle text-xs text-muted-foreground mb-2">
                    ↳ Next: {info.nextLocationName}
                  </p>
                )}
                {info && info.estimatedRemaining > 0 && (
                  <div className="flex items-center gap-1 font-doodle text-xs text-doodle-blue mb-2">
                    <Clock className="w-3 h-3" />
                    <span>~{info.estimatedRemaining.toFixed(1)} min remaining</span>
                  </div>
                )}
                <div className="space-y-1">
                  <div className="flex justify-between font-doodle text-xs">
                    <span>{completedOps} / {totalOps} ops</span>
                    <span className="font-bold">{pctStr}%</span>
                  </div>
                  <div className="w-full h-3 bg-secondary border-2 border-doodle-text rounded-sm overflow-hidden">
                    <div className="h-full bg-doodle-green transition-all" style={{ width: `${pctStr}%` }} />
                  </div>
                </div>
                {wo.ScrappedQty > 0 && (
                  <p className="font-doodle text-xs text-doodle-accent mt-2">⚠ {wo.ScrappedQty} scrapped</p>
                )}
              </Link>
            );
          })}
        </div>
      )}

      {/* Station detail drawer */}
      <Sheet open={drawerStationId != null} onOpenChange={(o) => !o && setDrawerStationId(null)}>
        <SheetContent side="right" className="doodle-dialog w-full sm:max-w-lg overflow-y-auto">
          {(() => {
            if (drawerStationId == null) return null;
            const station = stations.find(s => s.locationId === drawerStationId);
            const stationName = station?.locationName || locationNameMap.get(drawerStationId) || `Location ${drawerStationId}`;
            const activeHere = activeOrders.filter(wo => {
              const op = (activeOps || []).find(o => o.workOrderId === wo.WorkOrderID);
              return op?.locationId === drawerStationId;
            });
            const queuedHere = activeOrders.filter(wo => {
              const info = woInfoMap.get(wo.WorkOrderID);
              return info?.nextLocationId === drawerStationId;
            });

            const renderWoBlock = (wo: WorkOrder, kind: 'active' | 'queued') => {
              const routing = woRoutingMap.get(wo.WorkOrderID) || [];
              const op = (activeOps || []).find(o => o.workOrderId === wo.WorkOrderID);
              const activeSeq = op?.operationSequence;
              const remaining = routing.filter(r => r.ActualEndDate == null);
              return (
                <div key={wo.WorkOrderID} className="border-2 border-dashed border-doodle-text/30 rounded-sm p-3 bg-card">
                  <div className="flex justify-between items-start mb-1">
                    <Link to={`/execute/work-order/${wo.WorkOrderID}`} className="font-doodle text-xs font-bold text-doodle-blue hover:underline">
                      WO #{wo.WorkOrderID}
                    </Link>
                    <span className="font-doodle text-[10px] text-muted-foreground">Due {new Date(wo.DueDate).toLocaleDateString()}</span>
                  </div>
                  <p className="font-doodle text-sm font-bold text-doodle-text mb-2">
                    {productMap.get(wo.ProductID) || `Product #${wo.ProductID}`} <span className="font-normal text-muted-foreground">· Qty {wo.OrderQty}</span>
                  </p>
                  <p className="font-doodle text-[11px] text-muted-foreground mb-1.5">
                    {kind === 'active' ? 'Running here now' : 'Heading here next'} · {remaining.length} step{remaining.length === 1 ? '' : 's'} remaining
                  </p>
                  <ol className="space-y-1">
                    {remaining.map(r => {
                      const isActive = r.OperationSequence === activeSeq;
                      const isTarget = r.LocationID === drawerStationId && !isActive;
                      const locName = locationNameMap.get(r.LocationID) || `Location ${r.LocationID}`;
                      return (
                        <li
                          key={r.OperationSequence}
                          className={`flex items-center gap-2 font-doodle text-xs px-2 py-1 rounded-sm ${
                            isActive ? 'bg-doodle-green/10 text-doodle-green' :
                            isTarget ? 'bg-doodle-blue/10 text-doodle-blue font-bold' :
                            'text-muted-foreground'
                          }`}
                        >
                          {isActive ? <Activity className="w-3 h-3 shrink-0 animate-pulse" /> : <CircleDot className="w-3 h-3 shrink-0" />}
                          <span className="shrink-0">Op {r.OperationSequence}</span>
                          <span className="truncate">{locName}</span>
                          {isActive && op && (
                            <span className="ml-auto shrink-0">{op.elapsedMinutes.toFixed(1)} min</span>
                          )}
                        </li>
                      );
                    })}
                    {remaining.length === 0 && (
                      <li className="font-doodle text-xs text-muted-foreground italic">No remaining steps</li>
                    )}
                  </ol>
                </div>
              );
            };

            return (
              <>
                <SheetHeader>
                  <SheetTitle className="font-doodle text-lg font-bold text-doodle-text">{stationName}</SheetTitle>
                  <SheetDescription className="font-doodle text-xs text-muted-foreground">
                    Active {station?.activeCount ?? 0}{station?.capacity ? ` / ${station.capacity}` : ''} · {station?.queueCount ?? queuedHere.length} queued
                    {station?.earliestFreeSlotUtc && (() => {
                      const lbl = formatFreeIn(station.earliestFreeSlotUtc);
                      return lbl ? ` · ${lbl}` : '';
                    })()}
                  </SheetDescription>
                </SheetHeader>

                <div className="mt-5 space-y-5">
                  <div>
                    <h3 className="font-doodle text-xs font-bold text-doodle-text mb-2 uppercase tracking-wide">
                      Active here ({activeHere.length})
                    </h3>
                    {activeHere.length === 0 ? (
                      <p className="font-doodle text-xs text-muted-foreground italic">No work orders running here right now.</p>
                    ) : (
                      <div className="space-y-2">{activeHere.map(wo => renderWoBlock(wo, 'active'))}</div>
                    )}
                  </div>
                  <div>
                    <h3 className="font-doodle text-xs font-bold text-doodle-text mb-2 uppercase tracking-wide">
                      Queued ({queuedHere.length})
                    </h3>
                    {queuedHere.length === 0 ? (
                      <p className="font-doodle text-xs text-muted-foreground italic">No work orders waiting for this station.</p>
                    ) : (
                      <div className="space-y-2">{queuedHere.map(wo => renderWoBlock(wo, 'queued'))}</div>
                    )}
                  </div>
                </div>
              </>
            );
          })()}
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default ExecuteShopFloor;
