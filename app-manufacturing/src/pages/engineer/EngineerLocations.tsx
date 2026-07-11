import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Warehouse } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  fetchLocations,
  fetchProductInventory,
  fetchWorkOrders,
  fetchWorkOrderRouting,
} from "@/services/api";
import { fetchWarehouseStatus } from "@/services/warehouseApi";
import { CardGridSkeleton } from "@/components/LoadingSkeletons";

const EngineerLocations = () => {
  const { data: locations, isLoading } = useQuery({
    queryKey: ["locations"],
    queryFn: fetchLocations,
  });
  const { data: inventory } = useQuery({
    queryKey: ["product-inventory"],
    queryFn: () => fetchProductInventory(),
  });
  const { data: workOrders } = useQuery({
    queryKey: ["work-orders"],
    queryFn: fetchWorkOrders,
  });
  const { data: routing } = useQuery({
    queryKey: ["work-order-routing"],
    queryFn: () => fetchWorkOrderRouting(),
  });
  const { data: warehouseStatus } = useQuery({
    queryKey: ["warehouse-status"],
    queryFn: fetchWarehouseStatus,
    refetchInterval: 10000,
  });

  const locationCounts = useMemo(() => {
    const map = new Map<number, { qty: number; products: number }>();
    const prodSets = new Map<number, Set<number>>();
    inventory?.forEach((i) => {
      map.set(i.LocationID, {
        qty: (map.get(i.LocationID)?.qty || 0) + i.Quantity,
        products: 0,
      });
      if (!prodSets.has(i.LocationID)) prodSets.set(i.LocationID, new Set());
      prodSets.get(i.LocationID)!.add(i.ProductID);
    });
    prodSets.forEach((set, id) => {
      const entry = map.get(id);
      if (entry) entry.products = set.size;
    });
    return map;
  }, [inventory]);

  const productionStats = useMemo(() => {
    const result = new Map<
      number,
      { madeUnits: number; madeOrders: number; scheduled: number }
    >();
    if (!workOrders || !routing) return result;
    const woById = new Map(workOrders.map((w) => [w.WorkOrderID, w]));

    // Anchor "this month" to the simulation clock: use the latest ActualEndDate seen
    let simNow = 0;
    routing.forEach((r) => {
      if (r.ActualEndDate) {
        const t = new Date(r.ActualEndDate).getTime();
        if (t > simNow) simNow = t;
      }
    });
    const anchor = simNow ? new Date(simNow) : new Date();
    const monthStart = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      1,
    ).getTime();
    const monthEnd = anchor.getTime();

    const madeAtLoc = new Map<number, Set<number>>();
    const scheduledAtLoc = new Map<number, Set<number>>();

    routing.forEach((r) => {
      const wo = woById.get(r.WorkOrderID);
      if (r.ActualEndDate) {
        const t = new Date(r.ActualEndDate).getTime();
        if (t >= monthStart && t <= monthEnd) {
          if (!madeAtLoc.has(r.LocationID))
            madeAtLoc.set(r.LocationID, new Set());
          madeAtLoc.get(r.LocationID)!.add(r.WorkOrderID);
        }
      }
      if (wo && wo.StockedQty < wo.OrderQty) {
        if (!scheduledAtLoc.has(r.LocationID))
          scheduledAtLoc.set(r.LocationID, new Set());
        scheduledAtLoc.get(r.LocationID)!.add(r.WorkOrderID);
      }
    });

    const allLocs = new Set<number>([
      ...madeAtLoc.keys(),
      ...scheduledAtLoc.keys(),
    ]);
    allLocs.forEach((locId) => {
      const madeSet = madeAtLoc.get(locId) || new Set<number>();
      let madeUnits = 0;
      madeSet.forEach((woId) => {
        const wo = woById.get(woId);
        if (wo) madeUnits += wo.StockedQty;
      });
      result.set(locId, {
        madeUnits,
        madeOrders: madeSet.size,
        scheduled: scheduledAtLoc.get(locId)?.size || 0,
      });
    });
    return result;
  }, [workOrders, routing]);

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <h1 className="font-doodle text-2xl font-bold text-doodle-text">
        Manufacturing Locations
      </h1>
      <p className="font-doodle text-sm text-muted-foreground">
        Shop floor locations where manufacturing operations occur — click to
        view stored inventory
      </p>

      {isLoading ? (
        <CardGridSkeleton count={6} />
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {locations?.map((loc) => {
            const counts = locationCounts.get(loc.LocationID);
            const prod = productionStats.get(loc.LocationID);
            return (
              <Link
                key={loc.LocationID}
                to={`/engineer/locations/${loc.LocationID}`}
                className="doodle-card p-5 block hover:border-doodle-blue transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-doodle text-lg font-bold text-doodle-text">
                    {loc.Name}
                  </h3>
                  {loc.LocationID === 7 && (
                    <Link
                      to="/warehouse"
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0"
                    >
                      <Badge className="text-xs gap-1 bg-blue-100 text-blue-800 hover:bg-blue-200">
                        <Warehouse className="h-3 w-3" />
                        {warehouseStatus
                          ? `${warehouseStatus.activeOperations} active`
                          : "Warehouse"}
                      </Badge>
                    </Link>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  <div className="flex justify-between">
                    <span className="font-doodle text-sm text-muted-foreground">
                      Cost Rate
                    </span>
                    <span className="font-doodle text-sm font-bold">
                      ${loc.CostRate.toFixed(2)}/hr
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="font-doodle text-sm text-muted-foreground">
                      Availability
                    </span>
                    <span className="font-doodle text-sm font-bold">
                      {loc.Availability.toFixed(1)} hrs
                    </span>
                  </div>
                  {counts && (
                    <>
                      <div className="flex justify-between">
                        <span className="font-doodle text-sm text-muted-foreground">
                          Products
                        </span>
                        <span className="font-doodle text-sm font-bold">
                          {counts.products}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="font-doodle text-sm text-muted-foreground">
                          Total Qty
                        </span>
                        <span className="font-doodle text-sm font-bold">
                          {counts.qty.toLocaleString()}
                        </span>
                      </div>
                    </>
                  )}
                  {prod && (
                    <>
                      <div className="flex justify-between">
                        <span className="font-doodle text-sm text-muted-foreground">
                          Made this month
                        </span>
                        <span className="font-doodle text-sm font-bold">
                          {prod.madeUnits.toLocaleString()}
                          <span className="ml-1 font-normal text-muted-foreground">
                            ({prod.madeOrders}{" "}
                            {prod.madeOrders === 1 ? "order" : "orders"})
                          </span>
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="font-doodle text-sm text-muted-foreground">
                          Scheduled
                        </span>
                        <span className="font-doodle text-sm font-bold">
                          {prod.scheduled}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default EngineerLocations;
