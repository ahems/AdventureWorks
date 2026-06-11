import { useMemo, useEffect } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, TrendingUp, TrendingDown, Minus, Package, ShoppingCart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fetchOrders, fetchOrderHistory, fetchCatalog, type PurchaseOrder } from '@/services/supplyChainApi';
import { fetchProduct } from '@/services/api';

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  approved: 'secondary',
  complete: 'default',
  rejected: 'destructive',
};

const ProductPurchaseOrders = () => {
  const { productId } = useParams();
  const pid = Number(productId);
  const [searchParams] = useSearchParams();
  const supplierId = searchParams.get('supplierId');
  const navigate = useNavigate();

  // Deep-link: if a supplier is specified, jump straight to ordering on that vendor's page
  useEffect(() => {
    if (supplierId && pid) {
      navigate(`/supply/vendors/${supplierId}?product=${pid}&order=1`, { replace: true });
    }
  }, [supplierId, pid, navigate]);

  const { data: product } = useQuery({ queryKey: ['product', pid], queryFn: () => fetchProduct(pid), enabled: !!pid });
  const { data: active } = useQuery({ queryKey: ['supply-orders'], queryFn: fetchOrders });
  const { data: history } = useQuery({ queryKey: ['supply-orders-history'], queryFn: fetchOrderHistory });
  const { data: catalog } = useQuery({ queryKey: ['supply-catalog', pid], queryFn: () => fetchCatalog(pid), enabled: !!pid });

  const orders: PurchaseOrder[] = useMemo(() => {
    const all = [...(active || []), ...(history || [])];
    const seen = new Set<string>();
    return all
      .filter(o => Number(o.productId) === pid)
      .filter(o => {
        const key = `${o.orderId}-${o.vendorId}-${o.productId}-${o.qty}-${o.placedAtUtc}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => new Date(b.placedAtUtc).getTime() - new Date(a.placedAtUtc).getTime());
  }, [active, history, pid]);

  const stats = useMemo(() => {
    const completed = orders.filter(o => o.status === 'complete' && o.unitCost > 0);
    if (completed.length === 0) return null;
    const costs = completed.map(o => o.unitCost);
    const avg = costs.reduce((s, c) => s + c, 0) / costs.length;
    const min = Math.min(...costs);
    const max = Math.max(...costs);
    const latest = completed[0].unitCost;
    const totalQty = completed.reduce((s, o) => s + o.qty, 0);
    const totalSpend = completed.reduce((s, o) => s + o.totalCost, 0);
    return { avg, min, max, latest, totalQty, totalSpend, count: completed.length };
  }, [orders]);

  const trend = stats ? (stats.latest > stats.avg * 1.05 ? 'up' : stats.latest < stats.avg * 0.95 ? 'down' : 'flat') : null;

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/receive/costing" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Cost Analysis
      </Link>

      <div className="doodle-card-static p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="font-doodle text-xs text-muted-foreground uppercase tracking-wide">Purchase History</p>
            <h1 className="font-doodle text-2xl font-bold text-doodle-text">{product?.Name || `Product #${pid}`}</h1>
            <p className="font-doodle text-sm text-muted-foreground mt-1">
              What we've paid suppliers for this component over time
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link to={`/receive/inventory/${pid}`} className="doodle-button text-xs">Inventory</Link>
            <Link to={`/supply?product=${pid}`} className="doodle-button text-xs">Vendors & Quotes</Link>
          </div>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="doodle-card-static p-3 text-center">
            <p className="font-doodle text-[11px] text-muted-foreground">Latest Paid</p>
            <div className={`flex items-center justify-center gap-1 ${trend === 'up' ? 'text-red-600' : trend === 'down' ? 'text-green-600' : 'text-muted-foreground'}`}>
              {trend === 'up' ? <TrendingUp className="h-4 w-4" /> : trend === 'down' ? <TrendingDown className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
              <p className="font-doodle text-lg font-bold">${stats.latest.toFixed(2)}</p>
            </div>
          </div>
          <div className="doodle-card-static p-3 text-center">
            <p className="font-doodle text-[11px] text-muted-foreground">Avg Unit Cost</p>
            <p className="font-doodle text-lg font-bold text-doodle-text">${stats.avg.toFixed(2)}</p>
          </div>
          <div className="doodle-card-static p-3 text-center">
            <p className="font-doodle text-[11px] text-muted-foreground">Min / Max</p>
            <p className="font-doodle text-sm font-bold text-doodle-text">${stats.min.toFixed(2)} – ${stats.max.toFixed(2)}</p>
          </div>
          <div className="doodle-card-static p-3 text-center">
            <p className="font-doodle text-[11px] text-muted-foreground">Total Qty</p>
            <p className="font-doodle text-lg font-bold text-doodle-text">{stats.totalQty.toLocaleString()}</p>
          </div>
          <div className="doodle-card-static p-3 text-center">
            <p className="font-doodle text-[11px] text-muted-foreground">Total Spend</p>
            <p className="font-doodle text-lg font-bold text-doodle-text">${stats.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>
        </div>
      )}

      {catalog && catalog.length > 0 && (
        <div className="doodle-card-static p-4">
          <h3 className="font-doodle text-sm font-bold text-muted-foreground mb-2">Current Vendor Quotes</h3>
          <div className="grid md:grid-cols-2 gap-2">
            {catalog.map((q, i) => (
              <div key={i} className="flex items-center justify-between gap-2 border border-border/50 rounded p-2 font-doodle text-xs">
                <Link to={`/supply/vendors/${q.vendorId}`} className="text-doodle-blue hover:underline truncate">
                  {q.vendorName}
                </Link>
                <div className="flex items-center gap-3 text-doodle-text">
                  <span className="font-bold">${q.unitCost.toFixed(2)}</span>
                  <span className="text-muted-foreground">{q.leadTimeDays}d</span>
                  <Link
                    to={`/supply/vendors/${q.vendorId}?product=${pid}&order=1`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-doodle-blue/10 text-doodle-blue hover:bg-doodle-blue/20"
                    title={q.stockAvailable > 0 ? `Order from ${q.vendorName}` : 'Out of stock — view vendor'}
                  >
                    <ShoppingCart className="h-3 w-3" /> Order
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="doodle-card-static p-4">
        <h3 className="font-doodle text-sm font-bold text-muted-foreground mb-3">Purchase Order History</h3>
        {orders.length === 0 ? (
          <div className="text-center py-10 font-doodle text-muted-foreground">
            <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No purchase orders found for this component.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-doodle text-xs">
              <thead className="text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left py-2">Order</th>
                  <th className="text-left py-2">Date</th>
                  <th className="text-left py-2">Vendor</th>
                  <th className="text-right py-2">Qty</th>
                  <th className="text-right py-2">Unit Cost</th>
                  <th className="text-right py-2">Shipping</th>
                  <th className="text-right py-2">Total</th>
                  <th className="text-left py-2 pl-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={i} className="border-b border-border/40 hover:bg-secondary/30">
                    <td className="py-2">
                      <Link to={`/supply/orders/${o.orderId}`} className="text-doodle-blue hover:underline font-mono">
                        {o.orderId}
                      </Link>
                    </td>
                    <td className="py-2 text-muted-foreground">{new Date(o.placedAtUtc).toLocaleDateString()}</td>
                    <td className="py-2">
                      <Link to={`/supply/vendors/${o.vendorId}`} className="text-doodle-text hover:underline">
                        {o.vendorName}
                      </Link>
                    </td>
                    <td className="py-2 text-right">{o.qty}</td>
                    <td className="py-2 text-right font-bold">${o.unitCost.toFixed(2)}</td>
                    <td className="py-2 text-right text-muted-foreground">${o.shippingCost.toFixed(2)}</td>
                    <td className="py-2 text-right font-bold">${o.totalCost.toFixed(2)}</td>
                    <td className="py-2 pl-2">
                      <Badge variant={statusVariant[o.status] || 'outline'} className="text-[10px]">{o.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProductPurchaseOrders;
