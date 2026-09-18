import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { fetchRoutingByProduct, fetchLocations, fetchProduct } from '@/services/api';
import { CardGridSkeleton, TableSkeleton } from '@/components/LoadingSkeletons';

const EngineerRouting = () => {
  const { productId } = useParams();
  const pid = Number(productId);

  const { data: product } = useQuery({ queryKey: ['product', pid], queryFn: () => fetchProduct(pid) });
  const { data: routing, isLoading } = useQuery({ queryKey: ['routing-product', pid], queryFn: () => fetchRoutingByProduct(pid) });
  const { data: locations } = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });

  const locationMap = useMemo(() => {
    const map = new Map<number, string>();
    locations?.forEach(l => map.set(l.LocationID, l.Name));
    return map;
  }, [locations]);

  // Group by OperationSequence + LocationID to get distinct routing steps
  const routingSteps = useMemo(() => {
    if (!routing) return [];
    const seen = new Map<string, { opSeq: number; locationId: number; count: number; avgHrs: number }>();
    routing.forEach(r => {
      const key = `${r.OperationSequence}-${r.LocationID}`;
      const existing = seen.get(key);
      if (existing) {
        existing.count++;
        if (r.ActualResourceHrs) existing.avgHrs += r.ActualResourceHrs;
      } else {
        seen.set(key, { opSeq: r.OperationSequence, locationId: r.LocationID, count: 1, avgHrs: r.ActualResourceHrs || 0 });
      }
    });
    return Array.from(seen.values())
      .sort((a, b) => a.opSeq - b.opSeq)
      .map(s => ({ ...s, avgHrs: s.count > 0 ? s.avgHrs / s.count : 0 }));
  }, [routing]);

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/engineer" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Engineer
      </Link>

      <h1 className="font-doodle text-2xl font-bold text-doodle-text">Routing: {product?.Name || `Product #${pid}`}</h1>
      <p className="font-doodle text-sm text-muted-foreground">Standard manufacturing operations derived from historical work order routing</p>

      {isLoading ? (
        <><CardGridSkeleton count={4} /><TableSkeleton rows={4} cols={4} /></>
      ) : routingSteps.length === 0 ? (
        <p className="font-doodle text-muted-foreground">No routing data found.</p>
      ) : (
        <>
          {/* Visual flow */}
          <div className="flex flex-wrap items-center gap-3">
            {routingSteps.map((step, i) => (
              <div key={`${step.opSeq}-${step.locationId}`} className="flex items-center gap-3">
                <div className="doodle-card p-4 text-center min-w-[120px]">
                  <p className="font-doodle text-xs text-muted-foreground">Op {step.opSeq}</p>
                  <p className="font-doodle text-sm font-bold text-doodle-text">{locationMap.get(step.locationId) || `Loc #${step.locationId}`}</p>
                  <p className="font-doodle text-xs text-doodle-green mt-1">{step.avgHrs.toFixed(1)} hrs avg</p>
                </div>
                {i < routingSteps.length - 1 && <span className="font-doodle text-doodle-text/30 text-xl">→</span>}
              </div>
            ))}
          </div>

          {/* Table */}
          <div className="doodle-card-static overflow-x-auto">
            <table className="w-full font-doodle text-sm">
              <thead>
                <tr className="border-b-2 border-doodle-text/20">
                  <th className="text-left py-3 px-4">Op Sequence</th>
                  <th className="text-left py-3 px-4">Location</th>
                  <th className="text-right py-3 px-4">Avg Resource Hrs</th>
                  <th className="text-right py-3 px-4">Work Orders</th>
                </tr>
              </thead>
              <tbody>
                {routingSteps.map((step) => (
                  <tr key={`${step.opSeq}-${step.locationId}`} className="border-b border-doodle-text/10">
                    <td className="py-3 px-4 font-bold">{step.opSeq}</td>
                    <td className="py-3 px-4">{locationMap.get(step.locationId) || `#${step.locationId}`}</td>
                    <td className="text-right py-3 px-4">{step.avgHrs.toFixed(2)}</td>
                    <td className="text-right py-3 px-4">{step.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default EngineerRouting;
