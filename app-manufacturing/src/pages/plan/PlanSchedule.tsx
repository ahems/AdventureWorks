import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Clock, PlayCircle, CheckCircle2 } from 'lucide-react';
import { fetchWorkOrderRouting, fetchLocations, fetchManufacturedProducts } from '@/services/api';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScheduleSkeleton } from '@/components/LoadingSkeletons';

type TimePhase = 'upcoming' | 'inprogress' | 'completed';

const PlanSchedule = () => {
  const { data: routing, isLoading } = useQuery({ queryKey: ['all-routing'], queryFn: () => fetchWorkOrderRouting() });
  const { data: locations } = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });
  const { data: products } = useQuery({ queryKey: ['manufactured-products'], queryFn: fetchManufacturedProducts });

  const locationMap = useMemo(() => {
    const map = new Map<number, string>();
    locations?.forEach(l => map.set(l.LocationID, l.Name));
    return map;
  }, [locations]);

  const productMap = useMemo(() => {
    const map = new Map<number, string>();
    products?.forEach(p => map.set(p.ProductID, p.Name));
    return map;
  }, [products]);

  const now = useMemo(() => new Date(), []);

  const phased = useMemo(() => {
    if (!routing) return { upcoming: [], inprogress: [], completed: [] };
    const result: Record<TimePhase, typeof routing> = { upcoming: [], inprogress: [], completed: [] };
    routing.forEach(r => {
      const start = new Date(r.ScheduledStartDate);
      const end = new Date(r.ScheduledEndDate);
      if (end < now && r.ActualCost != null && r.ActualCost > 0) {
        result.completed.push(r);
      } else if (start <= now && end >= now) {
        result.inprogress.push(r);
      } else {
        result.upcoming.push(r);
      }
    });
    // Upcoming: soonest first
    result.upcoming.sort((a, b) => new Date(a.ScheduledStartDate).getTime() - new Date(b.ScheduledStartDate).getTime());
    // In progress: earliest start first
    result.inprogress.sort((a, b) => new Date(a.ScheduledStartDate).getTime() - new Date(b.ScheduledStartDate).getTime());
    // Completed: most recent first
    result.completed.sort((a, b) => new Date(b.ScheduledEndDate).getTime() - new Date(a.ScheduledEndDate).getTime());
    return result;
  }, [routing, now]);

  const groupByLocation = (items: typeof routing) => {
    if (!items) return [];
    const groups = new Map<number, typeof routing>();
    items.forEach(r => {
      const list = groups.get(r.LocationID) || [];
      list.push(r);
      groups.set(r.LocationID, list);
    });
    return Array.from(groups.entries())
      .map(([locId, ops]) => ({
        locationId: locId,
        locationName: locationMap.get(locId) || `Location #${locId}`,
        items: ops.slice(0, 30),
        total: ops.length,
      }))
      .sort((a, b) => b.total - a.total);
  };

  const counts = { upcoming: phased.upcoming.length, inprogress: phased.inprogress.length, completed: phased.completed.length };

  const renderLocationGroups = (items: typeof routing) => {
    const groups = groupByLocation(items || []);
    if (groups.length === 0) return (
      <div className="doodle-card-static p-8 text-center font-doodle text-muted-foreground">No operations in this phase</div>
    );
    return (
      <div className="space-y-6">
        {groups.map((loc) => (
          <div key={loc.locationId} className="doodle-card-static p-4">
            <h3 className="font-doodle text-lg font-bold text-doodle-text mb-3">
              📍 {loc.locationName} <span className="text-sm text-muted-foreground font-normal">({loc.total} operations{loc.total > 30 ? `, showing 30` : ''})</span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full font-doodle text-sm">
                <thead>
                  <tr className="border-b-2 border-doodle-text/20">
                    <th className="text-left py-2 px-3">WO#</th>
                    <th className="text-left py-2 px-3">Product</th>
                    <th className="text-left py-2 px-3">Op#</th>
                    <th className="text-left py-2 px-3">Scheduled Start</th>
                    <th className="text-left py-2 px-3">Scheduled End</th>
                    <th className="text-right py-2 px-3">Planned $</th>
                    <th className="text-right py-2 px-3">Actual $</th>
                  </tr>
                </thead>
                <tbody>
                  {loc.items.map((r) => (
                    <tr key={`${r.WorkOrderID}-${r.OperationSequence}`} className="border-b border-doodle-text/10 hover:bg-secondary/30">
                      <td className="py-2 px-3">
                        <Link to={`/plan/work-orders/${r.WorkOrderID}`} className="text-doodle-blue hover:underline">{r.WorkOrderID}</Link>
                      </td>
                      <td className="py-2 px-3">{productMap.get(r.ProductID) || `#${r.ProductID}`}</td>
                      <td className="py-2 px-3">{r.OperationSequence}</td>
                      <td className="py-2 px-3">{new Date(r.ScheduledStartDate).toLocaleDateString()}</td>
                      <td className="py-2 px-3">{new Date(r.ScheduledEndDate).toLocaleDateString()}</td>
                      <td className="text-right py-2 px-3">${r.PlannedCost.toFixed(2)}</td>
                      <td className="text-right py-2 px-3">{r.ActualCost != null ? `$${r.ActualCost.toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text">Production Schedule</h1>
          <p className="font-doodle text-sm text-muted-foreground">Routing operations by timeline phase and location</p>
        </div>
        <Link to="/plan" className="doodle-button text-sm">← Work Orders</Link>
      </div>

      {isLoading ? (
        <ScheduleSkeleton />
      ) : (
        <Tabs defaultValue="upcoming" className="space-y-4">
          <TabsList className="font-doodle">
            <TabsTrigger value="inprogress" className="flex items-center gap-1.5">
              <PlayCircle className="w-3.5 h-3.5" /> In Progress
              <span className="ml-1 text-xs opacity-70">({counts.inprogress})</span>
            </TabsTrigger>
            <TabsTrigger value="upcoming" className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> Upcoming
              <span className="ml-1 text-xs opacity-70">({counts.upcoming})</span>
            </TabsTrigger>
            <TabsTrigger value="completed" className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> Completed
              <span className="ml-1 text-xs opacity-70">({counts.completed})</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="inprogress">{renderLocationGroups(phased.inprogress)}</TabsContent>
          <TabsContent value="upcoming">{renderLocationGroups(phased.upcoming)}</TabsContent>
          <TabsContent value="completed">{renderLocationGroups(phased.completed)}</TabsContent>
        </Tabs>
      )}
    </div>
  );
};

export default PlanSchedule;
