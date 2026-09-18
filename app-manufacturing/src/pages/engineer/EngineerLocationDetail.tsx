import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchLocation, fetchProductInventory, fetchAllProducts } from '@/services/api';
import { DetailPageSkeleton, TableSkeleton } from '@/components/LoadingSkeletons';
import LocationCapabilityPanel from '@/components/workforce/LocationCapabilityPanel';

const EngineerLocationDetail = () => {
  const { id } = useParams<{ id: string }>();
  const locationId = Number(id);

  const { data: location, isLoading: locLoading } = useQuery({
    queryKey: ['location', locationId],
    queryFn: () => fetchLocation(locationId),
    enabled: !!locationId,
  });

  const { data: inventory, isLoading: invLoading } = useQuery({
    queryKey: ['product-inventory'],
    queryFn: () => fetchProductInventory(),
  });

  const { data: products } = useQuery({
    queryKey: ['all-products'],
    queryFn: fetchAllProducts,
  });

  const productMap = useMemo(() => {
    const map = new Map<number, string>();
    products?.forEach(p => map.set(p.ProductID, p.Name));
    return map;
  }, [products]);

  const locationItems = useMemo(() =>
    (inventory || []).filter(i => i.LocationID === locationId)
      .sort((a, b) => b.Quantity - a.Quantity),
    [inventory, locationId]
  );

  const totalQty = useMemo(() => locationItems.reduce((s, i) => s + i.Quantity, 0), [locationItems]);
  const uniqueProducts = useMemo(() => new Set(locationItems.map(i => i.ProductID)).size, [locationItems]);

  if (locLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;

  if (!location) return (
    <div className="container mx-auto px-4 py-8">
      <p className="font-doodle text-muted-foreground">Location not found.</p>
      <Link to="/engineer/locations" className="doodle-button doodle-button-primary text-sm mt-4 inline-block">← Back</Link>
    </div>
  );

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <Link to="/engineer/locations" className="font-doodle text-sm text-doodle-blue hover:underline">← All Locations</Link>
          <h1 className="font-doodle text-2xl font-bold text-doodle-text mt-1">{location.Name}</h1>
          <p className="font-doodle text-sm text-muted-foreground">Inventory stored at this location</p>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="doodle-card p-4 text-center">
          <p className="font-doodle text-xs text-muted-foreground">Total Items</p>
          <p className="font-doodle text-2xl font-bold text-doodle-text">{totalQty.toLocaleString()}</p>
        </div>
        <div className="doodle-card p-4 text-center">
          <p className="font-doodle text-xs text-muted-foreground">Unique Products</p>
          <p className="font-doodle text-2xl font-bold text-doodle-text">{uniqueProducts}</p>
        </div>
        <div className="doodle-card p-4 text-center">
          <p className="font-doodle text-xs text-muted-foreground">Cost Rate</p>
          <p className="font-doodle text-2xl font-bold text-doodle-text">${location.CostRate.toFixed(2)}/hr</p>
        </div>
        <div className="doodle-card p-4 text-center">
          <p className="font-doodle text-xs text-muted-foreground">Availability</p>
          <p className="font-doodle text-2xl font-bold text-doodle-text">{location.Availability.toFixed(1)} hrs</p>
        </div>
      </div>

      {/* BOMs / products routed through this location */}
      <div className="doodle-card-static p-4">
        <LocationCapabilityPanel locationId={locationId} locationName={location.Name} />
      </div>

      {/* Inventory table */}
      {invLoading ? (
        <TableSkeleton rows={10} cols={5} />
      ) : locationItems.length === 0 ? (
        <div className="doodle-card p-8 text-center">
          <p className="font-doodle text-muted-foreground">No inventory stored at this location.</p>
        </div>
      ) : (
        <div className="doodle-card-static overflow-x-auto">
          <table className="w-full font-doodle text-sm">
            <thead>
              <tr className="border-b-2 border-doodle-text/20">
                <th className="text-left py-3 px-4">Product</th>
                <th className="text-left py-3 px-4">Shelf</th>
                <th className="text-right py-3 px-4">Bin</th>
                <th className="text-right py-3 px-4">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {locationItems.map((item, idx) => (
                <tr key={idx} className="border-b border-doodle-text/10 hover:bg-secondary/30">
                  <td className="py-3 px-4">
                    <Link to={`/receive/inventory/${item.ProductID}`} className="text-doodle-blue hover:underline font-bold">
                      {productMap.get(item.ProductID) || `#${item.ProductID}`}
                    </Link>
                  </td>
                  <td className="py-3 px-4">{item.Shelf}</td>
                  <td className="text-right py-3 px-4">{item.Bin}</td>
                  <td className="text-right py-3 px-4 font-bold">{item.Quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-3 text-center font-doodle text-xs text-muted-foreground">
            {locationItems.length} items at {location.Name}
          </div>
        </div>
      )}
    </div>
  );
};

export default EngineerLocationDetail;
