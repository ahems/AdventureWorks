import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchActiveBOM, fetchWorkOrderRouting } from '@/services/api';

/**
 * Strict definition of "manufactured in the factory":
 *   - has at least one ACTIVE BOM record (we know how to assemble it), AND
 *   - has at least one WorkOrderRouting step on file (the factory has actually run it).
 *
 * Combine with `MakeFlag && FinishedGoodsFlag` on the Product itself for the
 * full "really manufactured finished good" filter used across the app.
 */
export function useManufacturedProductIds() {
  const { data: activeBom, isLoading: bomLoading } = useQuery({
    queryKey: ['active-bom'],
    queryFn: fetchActiveBOM,
  });
  const { data: allRouting, isLoading: routingLoading } = useQuery({
    queryKey: ['work-order-routing-all'],
    queryFn: () => fetchWorkOrderRouting(),
  });

  const assembledIds = useMemo(() => {
    const s = new Set<number>();
    activeBom?.forEach(b => s.add(b.ProductAssemblyID));
    return s;
  }, [activeBom]);

  const routedIds = useMemo(() => {
    const s = new Set<number>();
    allRouting?.forEach(r => s.add(r.ProductID));
    return s;
  }, [allRouting]);

  const manufacturedIds = useMemo(() => {
    const s = new Set<number>();
    assembledIds.forEach(id => { if (routedIds.has(id)) s.add(id); });
    return s;
  }, [assembledIds, routedIds]);

  return {
    /** Strict: products with both BOM + routing. Use for catalog filters. */
    manufacturedIds,
    /** Products with active BOM (any level). */
    assembledIds,
    /** Products with routing history. */
    routedIds,
    isLoading: bomLoading || routingLoading,
  };
}
