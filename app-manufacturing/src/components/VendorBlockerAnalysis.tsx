import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { ShieldAlert, Building2, ArrowRight, PackageX, PackageOpen, Factory, Wrench } from 'lucide-react';
import { fetchCatalog, type SupplyQuote } from '@/services/supplyChainApi';
import { fetchManufacturingStatus, type ShortageData } from '@/services/api';

interface BlockedComponent {
  productId: number;
  componentName: string;
  totalShortfall: number;
  blockedWorkOrders: number;
  workOrderIds: number[];
  vendorStock: number;
  unitCost: number;
  leadTimeDays: number;
  status: 'out' | 'low';
}

interface VendorBlockerRow {
  vendorId: string;
  vendorName: string;
  outOfStockCount: number;
  lowStockCount: number;
  totalBlockedWorkOrders: number;
  totalShortfall: number;
  blockedComponents: BlockedComponent[];
  impactScore: number;
}

const VendorBlockerAnalysis: React.FC = () => {
  const { data: status, isLoading: stLoading } = useQuery({
    queryKey: ['manufacturing-status-vendor-blockers'],
    queryFn: fetchManufacturingStatus,
    refetchInterval: 5_000,
  });
  const { data: catalog, isLoading: catLoading } = useQuery({
    queryKey: ['supply-catalog-all'],
    queryFn: () => fetchCatalog(),
    staleTime: 60_000,
  });

  const { rows, totalBlockedWOs } = useMemo(() => {
    if (!status?.shortages || !catalog) return { rows: [] as VendorBlockerRow[], totalBlockedWOs: 0 };

    // Aggregate shortages per component (a component can block many work orders)
    const byComp = new Map<number, { name: string; shortfall: number; wos: Set<number> }>();
    status.shortages.forEach((s: ShortageData) => {
      if (!byComp.has(s.productId)) {
        byComp.set(s.productId, { name: s.productName, shortfall: 0, wos: new Set() });
      }
      const e = byComp.get(s.productId)!;
      e.shortfall += s.shortfall;
      e.wos.add(s.workOrderId);
    });

    // Group catalog quotes by vendor — only quotes for components that are blocking production
    const byVendor = new Map<string, { name: string; quotes: SupplyQuote[] }>();
    catalog.forEach(q => {
      if (!byComp.has(q.productId)) return;
      if (!byVendor.has(q.vendorId)) byVendor.set(q.vendorId, { name: q.vendorName, quotes: [] });
      byVendor.get(q.vendorId)!.quotes.push(q);
    });

    const result: VendorBlockerRow[] = [];
    byVendor.forEach((v, vendorId) => {
      // Dedupe per component (one row per component for this vendor)
      const perComp = new Map<number, SupplyQuote>();
      v.quotes.forEach(q => { if (!perComp.has(q.productId)) perComp.set(q.productId, q); });

      const blocked: BlockedComponent[] = [];
      let impact = 0;
      perComp.forEach((q, productId) => {
        const compInfo = byComp.get(productId)!;
        const lowThreshold = Math.max(q.minOrderQty || 0, 10);
        const status: 'out' | 'low' | null =
          q.stockAvailable <= 0 ? 'out' :
          q.stockAvailable < lowThreshold ? 'low' : null;
        if (!status) return;

        blocked.push({
          productId,
          componentName: compInfo.name,
          totalShortfall: compInfo.shortfall,
          blockedWorkOrders: compInfo.wos.size,
          workOrderIds: Array.from(compInfo.wos),
          vendorStock: q.stockAvailable,
          unitCost: q.unitCost,
          leadTimeDays: q.leadTimeDays,
          status,
        });
        // Impact = blocked work orders × shortfall weight × stock-status weight
        impact += compInfo.wos.size * Math.log10(Math.max(compInfo.shortfall, 10)) * (status === 'out' ? 2 : 1);
      });

      if (blocked.length === 0) return;
      blocked.sort((a, b) => b.blockedWorkOrders - a.blockedWorkOrders || b.totalShortfall - a.totalShortfall);

      const allWos = new Set<number>();
      blocked.forEach(b => b.workOrderIds.forEach(w => allWos.add(w)));

      result.push({
        vendorId,
        vendorName: v.name,
        outOfStockCount: blocked.filter(b => b.status === 'out').length,
        lowStockCount: blocked.filter(b => b.status === 'low').length,
        totalBlockedWorkOrders: allWos.size,
        totalShortfall: blocked.reduce((s, b) => s + b.totalShortfall, 0),
        blockedComponents: blocked,
        impactScore: impact,
      });
    });

    result.sort((a, b) => b.impactScore - a.impactScore);
    const totalBlockedWOs = new Set(status.shortages.map(s => s.workOrderId)).size;
    return { rows: result, totalBlockedWOs };
  }, [status, catalog]);

  if (stLoading || catLoading) {
    return <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>;
  }

  const totalOut = rows.reduce((s, r) => s + r.outOfStockCount, 0);
  const totalLow = rows.reduce((s, r) => s + r.lowStockCount, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Building2 className="h-5 w-5 text-destructive" />
            <div>
              <p className="text-2xl font-bold font-doodle">{rows.length}</p>
              <p className="text-xs text-muted-foreground">Blocking Vendors</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <PackageX className="h-5 w-5 text-destructive" />
            <div>
              <p className="text-2xl font-bold font-doodle text-destructive">{totalOut}</p>
              <p className="text-xs text-muted-foreground">Out-of-Stock Lines</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <PackageOpen className="h-5 w-5 text-yellow-600" />
            <div>
              <p className="text-2xl font-bold font-doodle">{totalLow}</p>
              <p className="text-xs text-muted-foreground">Low-Stock Lines</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Wrench className="h-5 w-5 text-accent" />
            <div>
              <p className="text-2xl font-bold font-doodle">{totalBlockedWOs}</p>
              <p className="text-xs text-muted-foreground">Stalled Work Orders</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-doodle flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" /> Vendors Blocking Production
          </CardTitle>
          <CardDescription>
            Vendors of components that are actively stalling work orders on the shop floor — and who themselves are out of stock or below safe levels.
            Ranked by production impact (blocked work orders × shortfall × stock status).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-6">
              No vendor blockers detected — all vendors of stalled components have sufficient stock.
            </p>
          ) : (
            <Accordion type="multiple" className="space-y-1">
              {rows.map(r => (
                <AccordionItem key={r.vendorId} value={r.vendorId} className="border rounded-md px-3">
                  <AccordionTrigger className="py-3 hover:no-underline">
                    <div className="flex items-center gap-3 text-left flex-1 flex-wrap">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-sm">{r.vendorName}</span>
                      {r.outOfStockCount > 0 && (
                        <Badge variant="destructive" className="text-xs gap-1">
                          <PackageX className="h-3 w-3" /> {r.outOfStockCount} out
                        </Badge>
                      )}
                      {r.lowStockCount > 0 && (
                        <Badge variant="secondary" className="text-xs gap-1 bg-yellow-100 text-yellow-800">
                          <PackageOpen className="h-3 w-3" /> {r.lowStockCount} low
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-xs ml-auto mr-4 gap-1">
                        <Wrench className="h-3 w-3" /> {r.totalBlockedWorkOrders} work order{r.totalBlockedWorkOrders !== 1 ? 's' : ''} stalled
                      </Badge>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="flex justify-end mb-2">
                      <Link to={`/supply/vendors/${r.vendorId}`} className="text-xs text-primary hover:underline flex items-center gap-1">
                        View vendor <ArrowRight className="h-3 w-3" />
                      </Link>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Component</TableHead>
                          <TableHead className="text-right">Vendor Stock</TableHead>
                          <TableHead className="text-right">Total Shortfall</TableHead>
                          <TableHead className="text-right">Stalled WOs</TableHead>
                          <TableHead className="text-right">Unit Cost</TableHead>
                          <TableHead className="text-right">Lead Time</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.blockedComponents.map(b => (
                          <TableRow key={b.productId}>
                            <TableCell>
                              <Link to={`/receive/inventory/${b.productId}`} className="text-sm hover:underline text-primary">
                                {b.componentName}
                              </Link>
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge variant={b.status === 'out' ? 'destructive' : 'secondary'} className={`font-mono text-xs ${b.status === 'low' ? 'bg-yellow-100 text-yellow-800' : ''}`}>
                                {b.vendorStock}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">{b.totalShortfall.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{b.blockedWorkOrders}</TableCell>
                            <TableCell className="text-right font-mono text-xs">${b.unitCost.toFixed(2)}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{b.leadTimeDays}d</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default VendorBlockerAnalysis;
