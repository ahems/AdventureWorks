import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { AlertTriangle, ShieldAlert, Shield, ShieldCheck, Building2, ArrowRight, Package } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { fetchCatalog, type SupplyQuote } from '@/services/supplyChainApi';
import { fetchProductInventory } from '@/services/api';

interface ComponentRisk {
  productId: number;
  productName: string;
  vendorCount: number;
  stockOnHand: number;
  vendors: { vendorId: string; vendorName: string; unitCost: number; stockAvailable: number; leadTimeDays: number; reliabilityPct: number }[];
}

interface VendorExposure {
  vendorId: string;
  vendorName: string;
  exclusiveComponents: number;
  totalComponents: number;
  componentNames: string[];
  exclusiveNames: string[];
}

const SupplyChainRiskAnalysis: React.FC = () => {
  const [filter, setFilter] = useState<'all' | 'single' | 'dual' | 'multi'>('all');

  const { data: catalog, isLoading } = useQuery({
    queryKey: ['supply-catalog-all'],
    queryFn: () => fetchCatalog(),
    staleTime: 60_000,
  });
  const { data: inventory } = useQuery({
    queryKey: ['product-inventory'],
    queryFn: () => fetchProductInventory(),
    staleTime: 60_000,
  });

  const { componentRisks, vendorExposures, stats } = useMemo(() => {
    if (!catalog) return { componentRisks: [], vendorExposures: [], stats: { total: 0, single: 0, dual: 0, multi: 0 } };

    // Inventory lookup
    const invMap = new Map<number, number>();
    inventory?.forEach(inv => {
      invMap.set(inv.ProductID, (invMap.get(inv.ProductID) || 0) + inv.Quantity);
    });

    // Group by product
    const byProduct = new Map<number, SupplyQuote[]>();
    catalog.forEach(q => {
      const arr = byProduct.get(q.productId) || [];
      arr.push(q);
      byProduct.set(q.productId, arr);
    });

    const risks: ComponentRisk[] = [];
    byProduct.forEach((quotes, productId) => {
      // Dedupe vendors per product
      const vendorMap = new Map<string, SupplyQuote>();
      quotes.forEach(q => { if (!vendorMap.has(q.vendorId)) vendorMap.set(q.vendorId, q); });
      risks.push({
        productId,
        productName: quotes[0].productName,
        vendorCount: vendorMap.size,
        stockOnHand: invMap.get(productId) || 0,
        vendors: Array.from(vendorMap.values()).map(q => ({
          vendorId: q.vendorId, vendorName: q.vendorName,
          unitCost: q.unitCost, stockAvailable: q.stockAvailable,
          leadTimeDays: q.leadTimeDays, reliabilityPct: q.reliabilityPct,
        })),
      });
    });

    risks.sort((a, b) => a.vendorCount - b.vendorCount || a.productName.localeCompare(b.productName));

    const single = risks.filter(r => r.vendorCount === 1).length;
    const dual = risks.filter(r => r.vendorCount === 2).length;
    const multi = risks.filter(r => r.vendorCount >= 3).length;

    // Vendor exposure
    const vendorMap = new Map<string, { name: string; components: Set<string>; exclusive: Set<string> }>();
    risks.forEach(r => {
      r.vendors.forEach(v => {
        if (!vendorMap.has(v.vendorId)) vendorMap.set(v.vendorId, { name: v.vendorName, components: new Set(), exclusive: new Set() });
        vendorMap.get(v.vendorId)!.components.add(r.productName);
        if (r.vendorCount === 1) vendorMap.get(v.vendorId)!.exclusive.add(r.productName);
      });
    });

    const exposures: VendorExposure[] = Array.from(vendorMap.entries())
      .map(([id, d]) => ({
        vendorId: id, vendorName: d.name,
        exclusiveComponents: d.exclusive.size, totalComponents: d.components.size,
        componentNames: Array.from(d.components).sort(),
        exclusiveNames: Array.from(d.exclusive).sort(),
      }))
      .filter(v => v.exclusiveComponents > 0)
      .sort((a, b) => b.exclusiveComponents - a.exclusiveComponents);

    return { componentRisks: risks, vendorExposures: exposures, stats: { total: risks.length, single, dual, multi } };
  }, [catalog, inventory]);

  const filtered = useMemo(() => {
    if (filter === 'single') return componentRisks.filter(r => r.vendorCount === 1);
    if (filter === 'dual') return componentRisks.filter(r => r.vendorCount === 2);
    if (filter === 'multi') return componentRisks.filter(r => r.vendorCount >= 3);
    return componentRisks;
  }, [componentRisks, filter]);

  if (isLoading) {
    return <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Risk Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="cursor-pointer hover:ring-2 hover:ring-primary/30 transition-shadow" onClick={() => setFilter('all')}>
          <CardContent className="p-4 flex items-center gap-3">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-bold font-doodle">{stats.total}</p>
              <p className="text-xs text-muted-foreground">Total Components</p>
            </div>
          </CardContent>
        </Card>
        <Card className={`cursor-pointer hover:ring-2 hover:ring-destructive/30 transition-shadow ${filter === 'single' ? 'ring-2 ring-destructive' : ''}`} onClick={() => setFilter(f => f === 'single' ? 'all' : 'single')}>
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            <div>
              <p className="text-2xl font-bold font-doodle text-destructive">{stats.single}</p>
              <p className="text-xs text-muted-foreground">Single-Sourced</p>
              <p className="text-xs text-destructive font-medium">{stats.total > 0 ? Math.round(stats.single / stats.total * 100) : 0}% at risk</p>
            </div>
          </CardContent>
        </Card>
        <Card className={`cursor-pointer hover:ring-2 hover:ring-yellow-500/30 transition-shadow ${filter === 'dual' ? 'ring-2 ring-yellow-500' : ''}`} onClick={() => setFilter(f => f === 'dual' ? 'all' : 'dual')}>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600" />
            <div>
              <p className="text-2xl font-bold font-doodle">{stats.dual}</p>
              <p className="text-xs text-muted-foreground">Dual-Sourced</p>
            </div>
          </CardContent>
        </Card>
        <Card className={`cursor-pointer hover:ring-2 hover:ring-accent/30 transition-shadow ${filter === 'multi' ? 'ring-2 ring-accent' : ''}`} onClick={() => setFilter(f => f === 'multi' ? 'all' : 'multi')}>
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-accent" />
            <div>
              <p className="text-2xl font-bold font-doodle">{stats.multi}</p>
              <p className="text-xs text-muted-foreground">3+ Sources</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Vendor Concentration Risk */}
      <Card>
        <CardHeader>
          <CardTitle className="font-doodle flex items-center gap-2">
            <Building2 className="h-5 w-5 text-destructive" /> Vendor Concentration Risk
          </CardTitle>
          <CardDescription>
            Vendors with exclusive supply of components — a disruption would halt production of these parts
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Exclusive Parts</TableHead>
                <TableHead className="text-right">Total Parts</TableHead>
                <TableHead>Concentration</TableHead>
                <TableHead>Exclusive Components</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendorExposures.slice(0, 20).map(v => {
                const pct = Math.round(v.exclusiveComponents / v.totalComponents * 100);
                return (
                  <TableRow key={v.vendorId}>
                    <TableCell className="font-medium">{v.vendorName}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="destructive" className="font-mono">{v.exclusiveComponents}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{v.totalComponents}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <Progress value={pct} className="h-2 flex-1" />
                        <span className="text-xs text-muted-foreground w-8">{pct}%</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {v.exclusiveNames.slice(0, 4).map(n => (
                          <Badge key={n} variant="outline" className="text-xs">{n}</Badge>
                        ))}
                        {v.exclusiveNames.length > 4 && (
                          <Badge variant="secondary" className="text-xs">+{v.exclusiveNames.length - 4} more</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link to={`/supply/vendors/${v.vendorId}`}>
                        <ArrowRight className="h-4 w-4 text-muted-foreground hover:text-primary" />
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Component Sourcing Detail */}
      <Card>
        <CardHeader>
          <CardTitle className="font-doodle flex items-center gap-2">
            {filter === 'single' ? <ShieldAlert className="h-5 w-5 text-destructive" /> :
             filter === 'dual' ? <AlertTriangle className="h-5 w-5 text-yellow-600" /> :
             filter === 'multi' ? <ShieldCheck className="h-5 w-5 text-accent" /> :
             <Shield className="h-5 w-5" />}
            {filter === 'single' ? 'Single-Sourced Components — Critical Risk' :
             filter === 'dual' ? 'Dual-Sourced Components — Moderate Risk' :
             filter === 'multi' ? 'Multi-Sourced Components — Low Risk' :
             'All Components by Source Count'}
          </CardTitle>
          <CardDescription>
            {filtered.length} components · Click to expand vendor details
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" className="space-y-1">
            {filtered.map(r => (
              <AccordionItem key={r.productId} value={String(r.productId)} className="border rounded-md px-3">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex items-center gap-3 text-left flex-1">
                    {r.vendorCount === 1 ? <ShieldAlert className="h-4 w-4 text-destructive shrink-0" /> :
                     r.vendorCount === 2 ? <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" /> :
                     <ShieldCheck className="h-4 w-4 text-accent shrink-0" />}
                    <span className="font-medium text-sm">{r.productName}</span>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-1 text-xs">
                            <Package className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className={`font-mono ${r.stockOnHand === 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                              {r.stockOnHand}
                            </span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>Current inventory stock on hand</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <Badge variant={r.vendorCount === 1 ? 'destructive' : r.vendorCount === 2 ? 'secondary' : 'default'} className="text-xs ml-auto mr-4">
                      {r.vendorCount} vendor{r.vendorCount !== 1 ? 's' : ''}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Vendor</TableHead>
                        <TableHead className="text-right">Unit Cost</TableHead>
                        <TableHead className="text-right">Stock</TableHead>
                        <TableHead className="text-right">Lead Time</TableHead>
                        <TableHead className="text-right">Reliability</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.vendors.map(v => (
                        <TableRow key={v.vendorId}>
                          <TableCell className="font-medium">{v.vendorName}</TableCell>
                          <TableCell className="text-right font-mono">${v.unitCost.toFixed(2)}</TableCell>
                          <TableCell className="text-right font-mono">{v.stockAvailable}</TableCell>
                          <TableCell className="text-right">{v.leadTimeDays}d</TableCell>
                          <TableCell className="text-right">{(v.reliabilityPct * 100).toFixed(0)}%</TableCell>
                          <TableCell>
                            <Link to={`/supply/vendors/${v.vendorId}`}>
                              <ArrowRight className="h-4 w-4 text-muted-foreground hover:text-primary" />
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
};

export default SupplyChainRiskAnalysis;
