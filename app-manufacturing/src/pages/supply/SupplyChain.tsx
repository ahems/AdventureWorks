import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Truck, Star, AlertTriangle, Package, ShoppingCart, Clock,
  RefreshCw, ArrowRight, CheckCircle2, XCircle, Timer, TrendingUp, ShieldAlert, Factory, Layers, PackageX
} from 'lucide-react';
import SupplyChainRiskAnalysis from '@/components/SupplyChainRiskAnalysis';
import FinishedGoodRiskAnalysis from '@/components/FinishedGoodRiskAnalysis';
import VendorBlockerAnalysis from '@/components/VendorBlockerAnalysis';
import {
  fetchVendors, fetchOrders, fetchOrderHistory,
  cancelOrder, fetchCatalog, type VendorSummary, type PurchaseOrder, type SupplyQuote
} from '@/services/supplyChainApi';
import { toast } from 'sonner';

const statusColors: Record<string, string> = {
  pending: 'bg-blue-100 text-blue-800',
  approved: 'bg-indigo-100 text-indigo-800',
  complete: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
};

function creditBadge(rating: number) {
  const colors = ['', 'bg-green-100 text-green-800', 'bg-emerald-100 text-emerald-800', 'bg-yellow-100 text-yellow-800', 'bg-orange-100 text-orange-800', 'bg-red-100 text-red-800'];
  return <Badge className={`${colors[rating]} text-xs`}>Rating {rating}/5</Badge>;
}

const SupplyChain: React.FC = () => {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const productFilter = searchParams.get('product') ? Number(searchParams.get('product')) : null;
  const [tab, setTab] = useState('vendors');
  const { data: vendors, isLoading: vendorsLoading, error: vendorsError } = useQuery({
    queryKey: ['supply-vendors'],
    queryFn: fetchVendors,
  });
  const { data: orders, isLoading: ordersLoading } = useQuery({
    queryKey: ['supply-orders'],
    queryFn: fetchOrders,
    refetchInterval: 5000,
  });
  const { data: orderHistory } = useQuery({
    queryKey: ['supply-orders-history'],
    queryFn: fetchOrderHistory,
  });

  // When a product filter is active, fetch catalog to find which vendors carry it
  const { data: catalogQuotes } = useQuery({
    queryKey: ['supply-catalog', productFilter],
    queryFn: () => fetchCatalog(productFilter!),
    enabled: !!productFilter,
  });

  const productName = catalogQuotes?.[0]?.productName;
  const vendorIdsForProduct = useMemo(() => {
    if (!catalogQuotes) return new Set<string>();
    return new Set(catalogQuotes.map(q => q.vendorId));
  }, [catalogQuotes]);


  const cancelMutation = useMutation({
    mutationFn: (orderId: string) => cancelOrder(orderId),
    onSuccess: () => {
      toast.success('Order cancelled');
      qc.invalidateQueries({ queryKey: ['supply-orders'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const activeOrders = orders ?? [];
  const completedOrders = orderHistory?.filter(o => ['complete', 'rejected'].includes(o.status)) ?? [];

  if (vendorsError) {
    return (
      <div className="container mx-auto p-6">
        <Card className="border-destructive">
          <CardContent className="p-6 text-center space-y-3">
            <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
            <p className="text-lg font-semibold">Failed to load supply chain data</p>
            <p className="text-sm text-muted-foreground">Could not connect to the supply chain API. Please try again.</p>
            <Button variant="destructive" onClick={() => qc.invalidateQueries({ queryKey: ['supply-vendors'] })}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
            <Truck className="h-7 w-7 text-primary" /> Supply Chain
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Procurement — 63 active vendors</p>
        </div>
      </div>

      {/* Product filter banner */}
      {productFilter && (
        <Card className="border-primary/50 bg-primary/5">
          <CardContent className="p-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Package className="h-4 w-4 text-primary" />
              <span>Showing vendors that supply <strong>{productName || `Product #${productFilter}`}</strong></span>
              <Badge variant="secondary" className="text-xs">{vendorIdsForProduct.size} vendor{vendorIdsForProduct.size !== 1 ? 's' : ''}</Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSearchParams({})}>
              <XCircle className="h-4 w-4 mr-1" /> Clear filter
            </Button>
          </CardContent>
        </Card>
      )}

      {vendorsLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      ) : vendors && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Package className="h-5 w-5 text-primary" />
              <div>
                <p className="text-2xl font-bold font-doodle">{vendors.length}</p>
                <p className="text-xs text-muted-foreground">Active Vendors</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Star className="h-5 w-5 text-[hsl(var(--doodle-green))]" />
              <div>
                <p className="text-2xl font-bold font-doodle">{vendors.filter(v => v.vendor.preferredVendorStatus).length}</p>
                <p className="text-xs text-muted-foreground">Preferred</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <ShoppingCart className="h-5 w-5 text-[hsl(var(--doodle-blue))]" />
              <div>
                <p className="text-2xl font-bold font-doodle">{activeOrders.length}</p>
                <p className="text-xs text-muted-foreground">Active Orders</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-accent" />
              <div>
                <p className="text-2xl font-bold font-doodle">{vendors.reduce((s, v) => s + v.deliveredToday, 0)}</p>
                <p className="text-xs text-muted-foreground">Delivered Today</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="vendors"><Package className="h-4 w-4 mr-1 hidden sm:inline" /> Vendors</TabsTrigger>
          <TabsTrigger value="risk"><ShieldAlert className="h-4 w-4 mr-1 hidden sm:inline" /> Risk Analysis</TabsTrigger>
          <TabsTrigger value="active"><ShoppingCart className="h-4 w-4 mr-1 hidden sm:inline" /> Active Orders{activeOrders.length ? ` (${activeOrders.length})` : ''}</TabsTrigger>
          <TabsTrigger value="history"><Clock className="h-4 w-4 mr-1 hidden sm:inline" /> History</TabsTrigger>
        </TabsList>

        {/* Vendors Tab */}
        <TabsContent value="vendors">
          {vendorsLoading ? (
            <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>
          ) : (
            <div className="grid gap-3">
              {vendors
                ?.slice()
                .sort((a, b) => {
                  // When filtering by product, show matching vendors first
                  if (productFilter && vendorIdsForProduct.size > 0) {
                    const aMatch = vendorIdsForProduct.has(a.vendor.vendorId) ? 0 : 1;
                    const bMatch = vendorIdsForProduct.has(b.vendor.vendorId) ? 0 : 1;
                    if (aMatch !== bMatch) return aMatch - bMatch;
                  }
                  return a.vendor.creditRating - b.vendor.creditRating;
                })
                .map(vs => (
                  <VendorCard
                    key={vs.vendor.vendorId}
                    vs={vs}
                    highlighted={productFilter ? vendorIdsForProduct.has(vs.vendor.vendorId) : false}
                    productFilter={productFilter}
                  />
                ))}
            </div>
          )}
        </TabsContent>

        {/* Risk Analysis Tab */}
        <TabsContent value="risk">
          <Tabs defaultValue="vendor-blockers" className="space-y-4">
            <TabsList>
              <TabsTrigger value="vendor-blockers"><PackageX className="h-4 w-4 mr-1" /> Vendor Blockers</TabsTrigger>
              <TabsTrigger value="finished-goods"><Factory className="h-4 w-4 mr-1" /> Finished Good Risk</TabsTrigger>
              <TabsTrigger value="components"><Layers className="h-4 w-4 mr-1" /> Component Sourcing</TabsTrigger>
            </TabsList>
            <TabsContent value="vendor-blockers">
              <VendorBlockerAnalysis />
            </TabsContent>
            <TabsContent value="finished-goods">
              <FinishedGoodRiskAnalysis />
            </TabsContent>
            <TabsContent value="components">
              <SupplyChainRiskAnalysis />
            </TabsContent>
          </Tabs>
        </TabsContent>

        {/* Active Orders Tab */}
        <TabsContent value="active">
          {/* KPI cards */}
          {!ordersLoading && activeOrders.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <Card>
                <CardContent className="p-3 flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4 text-primary" />
                  <div>
                    <p className="text-lg font-bold font-doodle">{activeOrders.length}</p>
                    <p className="text-[11px] text-muted-foreground">Open Orders</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-[hsl(var(--doodle-blue))]" />
                  <div>
                    <p className="text-lg font-bold font-doodle">${activeOrders.reduce((s, o) => s + o.totalCost, 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    <p className="text-[11px] text-muted-foreground">Total Value</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 flex items-center gap-2">
                  <Timer className="h-4 w-4 text-[hsl(var(--doodle-green))]" />
                  <div>
                    <p className="text-lg font-bold font-doodle">{activeOrders.filter(o => o.status === 'pending').length}</p>
                    <p className="text-[11px] text-muted-foreground">Pending Approval</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 flex items-center gap-2">
                  <Package className="h-4 w-4 text-accent" />
                  <div>
                    <p className="text-lg font-bold font-doodle">{activeOrders.reduce((s, o) => s + o.qty, 0)}</p>
                    <p className="text-[11px] text-muted-foreground">Total Units</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">Active Purchase Orders</CardTitle>
              <CardDescription>Live order tracking — auto-refreshes every 5 seconds</CardDescription>
            </CardHeader>
            <CardContent>
              {ordersLoading ? (
                <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-12 rounded" />)}</div>
              ) : !activeOrders.length ? (
                <p className="text-muted-foreground text-sm text-center py-6">No active orders. Place orders from a vendor's detail page.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO #</TableHead>
                      <TableHead>Vendor</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>ETA</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...activeOrders]
                      .sort((a, b) => {
                        const statusOrder: Record<string, number> = { pending: 0, approved: 1, complete: 2, rejected: 3 };
                        const sDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
                        if (sDiff !== 0) return sDiff;
                        return new Date(a.estimatedDeliveryUtc).getTime() - new Date(b.estimatedDeliveryUtc).getTime();
                      })
                      .map(o => (
                      <TableRow key={o.orderId}>
                        <TableCell>
                          <Link to={`/supply/orders/${o.orderId}`} className="font-mono text-xs text-primary hover:underline font-medium">
                            PO #{o.orderId}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link to={`/supply/vendors/${o.vendorId}`} className="text-sm hover:underline text-primary">
                            {o.vendorName}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link to={`/receive/inventory/${o.productId}`} className="text-sm hover:underline text-primary">
                            {o.productName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-mono">{o.qty}</TableCell>
                        <TableCell className="text-right font-mono">${o.totalCost.toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge className={statusColors[o.status] || ''} variant="secondary">{o.status}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(o.estimatedDeliveryUtc).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {o.status === 'pending' && (
                            <Button variant="ghost" size="sm" onClick={(e) => { e.preventDefault(); cancelMutation.mutate(o.orderId); }} disabled={cancelMutation.isPending}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle className="font-doodle">Order History</CardTitle>
              <CardDescription>Completed and rejected orders</CardDescription>
            </CardHeader>
            <CardContent>
              {!completedOrders.length ? (
                <p className="text-muted-foreground text-sm text-center py-6">No completed orders yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO #</TableHead>
                      <TableHead>Vendor</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Delivered</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {completedOrders.slice(0, 50).map(o => (
                      <TableRow key={o.orderId}>
                        <TableCell>
                          <Link to={`/supply/orders/${o.orderId}`} className="font-mono text-xs text-primary hover:underline font-medium">
                            PO #{o.orderId}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link to={`/supply/vendors/${o.vendorId}`} className="text-sm hover:underline text-primary">
                            {o.vendorName}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link to={`/receive/inventory/${o.productId}`} className="text-sm hover:underline text-primary">
                            {o.productName}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-mono">{o.qty}</TableCell>
                        <TableCell className="text-right font-mono">${o.totalCost.toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge className={statusColors[o.status] || ''} variant="secondary">{o.status}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {o.actualDeliveryUtc ? new Date(o.actualDeliveryUtc).toLocaleString() : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

function VendorCard({ vs, highlighted, productFilter }: { vs: VendorSummary; highlighted?: boolean; productFilter?: number | null }) {
  const v = vs.vendor;
  const stockPct = vs.totalComponents > 0 ? Math.round((vs.inStockComponents / vs.totalComponents) * 100) : 0;
  const linkTo = productFilter ? `/supply/vendors/${v.vendorId}?product=${productFilter}` : `/supply/vendors/${v.vendorId}`;
  return (
    <Link to={linkTo}>
      <Card className={`hover:ring-2 hover:ring-primary/30 transition-shadow cursor-pointer ${highlighted ? 'ring-2 ring-primary border-primary' : ''} ${highlighted === false && productFilter ? 'opacity-40' : ''}`}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="font-doodle font-bold text-base truncate">{v.name}</h3>
                {v.preferredVendorStatus && <Star className="h-4 w-4 text-yellow-500 fill-yellow-500 shrink-0" />}
                {highlighted && <Badge className="bg-primary/10 text-primary text-[10px] px-1.5">Stocks this product</Badge>}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                {creditBadge(v.creditRating)}
                <span>{(v.reliabilityPct * 100).toFixed(0)}% reliable</span>
                <span>·</span>
                <span>{v.defaultLeadTimeDays}d avg lead</span>
                <span>·</span>
                <span>{v.shipMethodName}</span>
              </div>
              {v.strengths.length > 0 && (
                <div className="flex gap-1 mt-2 flex-wrap">
                  {v.strengths.map((s, i) => <Badge key={i} variant="secondary" className="text-xs">{s}</Badge>)}
                </div>
              )}
            </div>
            <div className="text-right shrink-0 space-y-1">
              <div className="text-sm">
                <span className="font-mono font-bold">{vs.inStockComponents}</span>
                <span className="text-muted-foreground">/{vs.totalComponents} in stock</span>
              </div>
              <Progress value={stockPct} className="h-1.5 w-24" />
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>{vs.activeOrders} active</span>
                <span>{vs.deliveredToday} delivered</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default SupplyChain;
