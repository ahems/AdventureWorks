import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ArrowLeft, Factory, ShoppingCart } from 'lucide-react';
import { fetchProductInventory, fetchProduct, fetchLocations } from '@/services/api';
import { fetchCatalog } from '@/services/supplyChainApi';
import { CardGridSkeleton } from '@/components/LoadingSkeletons';
import { Button } from '@/components/ui/button';
import CreateProductionOrderDialog from '@/components/CreateProductionOrderDialog';

const ReceiveProductInventory = () => {
  const { productId } = useParams();
  const pid = Number(productId);

  const { data: product } = useQuery({ queryKey: ['product', pid], queryFn: () => fetchProduct(pid) });
  const { data: inventory, isLoading } = useQuery({ queryKey: ['product-inventory', pid], queryFn: () => fetchProductInventory(pid) });
  const { data: locations } = useQuery({ queryKey: ['locations'], queryFn: fetchLocations });
  const { data: catalog } = useQuery({
    queryKey: ['supply-catalog', pid],
    queryFn: () => fetchCatalog(pid),
    enabled: !!pid && !!product && !product.MakeFlag,
  });

  // Pick preferred vendor: cheapest in-stock; fall back to cheapest overall
  const preferredVendorId = useMemo(() => {
    if (!catalog || catalog.length === 0) return null;
    const inStock = catalog.filter(q => q.stockAvailable > 0);
    const pool = inStock.length > 0 ? inStock : catalog;
    return [...pool].sort((a, b) => a.unitCost - b.unitCost)[0]?.vendorId ?? null;
  }, [catalog]);

  const locationMap = useMemo(() => {
    const map = new Map<number, string>();
    locations?.forEach(l => map.set(l.LocationID, l.Name));
    return map;
  }, [locations]);

  const totalQty = inventory?.reduce((s, i) => s + i.Quantity, 0) || 0;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/receive" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Inventory
      </Link>

      <div className="doodle-card-static p-6">
        <h1 className="font-doodle text-2xl font-bold text-doodle-text">{product?.Name || `Product #${pid}`}</h1>
        <p className="font-doodle text-sm text-muted-foreground">Total inventory: <span className="font-bold text-doodle-green">{totalQty}</span> units</p>
        {product && totalQty < product.SafetyStockLevel && (
          <div className="mt-3 p-3 rounded-lg border-2 border-doodle-accent/30 bg-doodle-accent/5 space-y-2">
            <p className="font-doodle text-sm text-doodle-accent font-bold">
              ⚠ Below safety stock — {totalQty} / {product.SafetyStockLevel} ({product.SafetyStockLevel - totalQty} deficit)
            </p>
            <div className="flex gap-2 flex-wrap">
              {product.MakeFlag && (
                <CreateProductionOrderDialog
                  prefillProductId={product.ProductID}
                  prefillQty={product.SafetyStockLevel - totalQty}
                  trigger={
                    <Button size="sm" variant="default" className="gap-1.5 text-xs">
                      <Factory className="h-3.5 w-3.5" /> Schedule Production
                    </Button>
                  }
                />
              )}
              {!product.MakeFlag && (
                <Link
                  to={
                    preferredVendorId
                      ? `/supply/product/${product.ProductID}?supplierId=${preferredVendorId}`
                      : `/supply/product/${product.ProductID}`
                  }
                >
                  <Button size="sm" variant="default" className="gap-1.5 text-xs">
                    <ShoppingCart className="h-3.5 w-3.5" /> Purchase from Vendor
                  </Button>
                </Link>
              )}
            </div>
          </div>
        )}
      </div>

      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {inventory?.map((inv, idx) => (
            <div key={idx} className="doodle-card p-4">
              <h3 className="font-doodle text-sm font-bold text-doodle-text">{locationMap.get(inv.LocationID) || `Location #${inv.LocationID}`}</h3>
              <div className="mt-2 space-y-1 font-doodle text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Shelf</span><span className="font-bold">{inv.Shelf}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Bin</span><span className="font-bold">{inv.Bin}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span className="font-bold text-doodle-green">{inv.Quantity}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ReceiveProductInventory;
