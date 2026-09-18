import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  ShieldAlert, ShieldCheck, AlertTriangle, Shield, Factory, Layers, PlayCircle, Package
} from 'lucide-react';
import { fetchProducts, fetchActiveBOM, fetchProductCategories, fetchProductSubcategories, fetchProductInventory, fetchWorkOrders, fetchAllProducts } from '@/services/api';
import CreateProductionOrderDialog from '@/components/CreateProductionOrderDialog';
import { fetchCatalog } from '@/services/supplyChainApi';
import type { Product, BillOfMaterials, ProductSubcategory, WorkOrder } from '@/types/production';

interface FinishedGoodRisk {
  product: Product;
  categoryName: string;
  subcategoryName: string;
  totalComponents: number;
  singleSourced: number;
  dualSourced: number;
  multiSourced: number;
  riskScore: number;
  stockOnHand: number;
  inProduction: number;
  components: {
    componentId: number;
    componentName: string;
    vendorCount: number;
    vendors: { vendorName: string; vendorId: string }[];
    perAssemblyQty: number;
    stockOnHand: number;
  }[];
}

function buildComponentTree(
  productId: number,
  bomMap: Map<number, BillOfMaterials[]>,
  visited: Set<number> = new Set()
): { componentId: number; perAssemblyQty: number }[] {
  if (visited.has(productId)) return [];
  visited.add(productId);
  const children = bomMap.get(productId) || [];
  const result: { componentId: number; perAssemblyQty: number }[] = [];
  for (const bom of children) {
    const subChildren = bomMap.get(bom.ComponentID);
    if (subChildren && subChildren.length > 0) {
      const nested = buildComponentTree(bom.ComponentID, bomMap, visited);
      nested.forEach(n => result.push({ componentId: n.componentId, perAssemblyQty: n.perAssemblyQty * bom.PerAssemblyQty }));
    } else {
      result.push({ componentId: bom.ComponentID, perAssemblyQty: bom.PerAssemblyQty });
    }
  }
  return result;
}

const FinishedGoodRiskAnalysis: React.FC = () => {
  const [sortBy, setSortBy] = useState<'risk' | 'name' | 'single'>('risk');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedSubcategory, setSelectedSubcategory] = useState<string | null>(null);

  const { data: products, isLoading: productsLoading } = useQuery({
    queryKey: ['products-all'], queryFn: () => fetchProducts(), staleTime: 120_000,
  });
  const { data: bom, isLoading: bomLoading } = useQuery({
    queryKey: ['active-bom'], queryFn: fetchActiveBOM, staleTime: 120_000,
  });
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['supply-catalog-all'], queryFn: () => fetchCatalog(), staleTime: 60_000,
  });
  const { data: categories } = useQuery({
    queryKey: ['product-categories'], queryFn: fetchProductCategories, staleTime: 300_000,
  });
  const { data: subcategories } = useQuery({
    queryKey: ['product-subcategories'], queryFn: fetchProductSubcategories, staleTime: 300_000,
  });
  const { data: inventory } = useQuery({
    queryKey: ['product-inventory'], queryFn: () => fetchProductInventory(), staleTime: 60_000,
  });
  const { data: workOrders } = useQuery({
    queryKey: ['work-orders'], queryFn: fetchWorkOrders, staleTime: 30_000,
  });

  const isLoading = productsLoading || bomLoading || catalogLoading;

  const { catSubGroups, overallStats } = useMemo(() => {
    if (!products || !bom || !catalog) return { catSubGroups: new Map<string, Map<string, FinishedGoodRisk[]>>(), overallStats: { total: 0, highRisk: 0, medRisk: 0, lowRisk: 0, avgScore: 0 } };

    const productMap = new Map<number, Product>();
    products.forEach(p => productMap.set(p.ProductID, p));

    const catMap = new Map<number, string>();
    categories?.forEach(c => catMap.set(c.ProductCategoryID, c.Name));
    const subMap = new Map<number, ProductSubcategory>();
    subcategories?.forEach(s => subMap.set(s.ProductSubcategoryID, s));

    const bomMap = new Map<number, BillOfMaterials[]>();
    bom.forEach(b => {
      if (b.ProductAssemblyID != null) {
        const arr = bomMap.get(b.ProductAssemblyID) || [];
        arr.push(b);
        bomMap.set(b.ProductAssemblyID, arr);
      }
    });

    // Inventory lookup: productId -> total qty
    const invMap = new Map<number, number>();
    inventory?.forEach(inv => {
      invMap.set(inv.ProductID, (invMap.get(inv.ProductID) || 0) + inv.Quantity);
    });

    // Active work orders (no EndDate = still in progress): productId -> total ordered qty
    const woMap = new Map<number, number>();
    workOrders?.filter((wo: WorkOrder) => !wo.EndDate)
      .forEach((wo: WorkOrder) => {
        woMap.set(wo.ProductID, (woMap.get(wo.ProductID) || 0) + wo.OrderQty);
      });

    const vendorsByProduct = new Map<number, Map<string, { vendorName: string; vendorId: string }>>();
    catalog.forEach(q => {
      if (!vendorsByProduct.has(q.productId)) vendorsByProduct.set(q.productId, new Map());
      vendorsByProduct.get(q.productId)!.set(q.vendorId, { vendorName: q.vendorName, vendorId: q.vendorId });
    });

    const fgProducts = products.filter(p => p.FinishedGoodsFlag && bomMap.has(p.ProductID));

    const results: FinishedGoodRisk[] = fgProducts.map(fg => {
      const leafComponents = buildComponentTree(fg.ProductID, bomMap);
      const compMap = new Map<number, number>();
      leafComponents.forEach(c => {
        compMap.set(c.componentId, (compMap.get(c.componentId) || 0) + c.perAssemblyQty);
      });

      const components = Array.from(compMap.entries()).map(([compId, qty]) => {
        const compProduct = productMap.get(compId);
        const vendors = vendorsByProduct.get(compId);
        const vendorList = vendors ? Array.from(vendors.values()) : [];
        return {
          componentId: compId,
          componentName: compProduct?.Name || `Product ${compId}`,
          vendorCount: vendorList.length,
          vendors: vendorList,
          perAssemblyQty: qty,
          stockOnHand: invMap.get(compId) || 0,
        };
      });

      const purchasable = components.filter(c => c.vendorCount > 0);
      const singleSourced = purchasable.filter(c => c.vendorCount === 1).length;
      const dualSourced = purchasable.filter(c => c.vendorCount === 2).length;
      const multiSourced = purchasable.filter(c => c.vendorCount >= 3).length;
      const total = purchasable.length;

      const singleRatio = total > 0 ? singleSourced / total : 0;
      const riskScore = total > 0
        ? Math.round(singleRatio * 70 + (singleSourced > 0 ? 20 : 0) + (dualSourced > 0 && singleSourced === 0 ? 10 : 0))
        : 0;

      const sub = fg.ProductSubcategoryID ? subMap.get(fg.ProductSubcategoryID) : null;
      const catName = sub ? (catMap.get(sub.ProductCategoryID) || 'Uncategorized') : 'Uncategorized';
      const subName = sub?.Name || 'Other';

      return {
        product: fg,
        categoryName: catName,
        subcategoryName: subName,
        totalComponents: total,
        singleSourced, dualSourced, multiSourced, riskScore,
        stockOnHand: invMap.get(fg.ProductID) || 0,
        inProduction: woMap.get(fg.ProductID) || 0,
        components: components.filter(c => c.vendorCount > 0).sort((a, b) => a.vendorCount - b.vendorCount),
      };
    });

    results.sort((a, b) => {
      if (sortBy === 'risk') return b.riskScore - a.riskScore || b.singleSourced - a.singleSourced;
      if (sortBy === 'single') return b.singleSourced - a.singleSourced || b.riskScore - a.riskScore;
      return a.product.Name.localeCompare(b.product.Name);
    });

    // Group by category -> subcategory
    const catSubGroups = new Map<string, Map<string, FinishedGoodRisk[]>>();
    results.forEach(r => {
      if (!catSubGroups.has(r.categoryName)) catSubGroups.set(r.categoryName, new Map());
      const subMap2 = catSubGroups.get(r.categoryName)!;
      if (!subMap2.has(r.subcategoryName)) subMap2.set(r.subcategoryName, []);
      subMap2.get(r.subcategoryName)!.push(r);
    });

    const highRisk = results.filter(r => r.riskScore >= 60).length;
    const medRisk = results.filter(r => r.riskScore >= 30 && r.riskScore < 60).length;
    const lowRisk = results.filter(r => r.riskScore < 30).length;
    const avgScore = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.riskScore, 0) / results.length) : 0;

    return { catSubGroups, overallStats: { total: results.length, highRisk, medRisk, lowRisk, avgScore } };
  }, [products, bom, catalog, categories, subcategories, sortBy, inventory, workOrders]);

  if (isLoading) {
    return <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>;
  }

  const riskColor = (score: number) => {
    if (score >= 60) return 'text-destructive';
    if (score >= 30) return 'text-yellow-600';
    return 'text-accent';
  };

  const riskBadge = (score: number) => {
    if (score >= 60) return <Badge variant="destructive" className="text-xs">High Risk</Badge>;
    if (score >= 30) return <Badge className="bg-yellow-100 text-yellow-800 text-xs">Medium</Badge>;
    return <Badge className="bg-accent/20 text-accent text-xs">Low</Badge>;
  };

  const riskIcon = (score: number) => {
    if (score >= 60) return <ShieldAlert className="h-4 w-4 text-destructive shrink-0" />;
    if (score >= 30) return <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" />;
    return <ShieldCheck className="h-4 w-4 text-accent shrink-0" />;
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Factory className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-bold font-doodle">{overallStats.total}</p>
              <p className="text-xs text-muted-foreground">Finished Goods</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-destructive/30">
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            <div>
              <p className="text-2xl font-bold font-doodle text-destructive">{overallStats.highRisk}</p>
              <p className="text-xs text-muted-foreground">High Risk</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600" />
            <div>
              <p className="text-2xl font-bold font-doodle">{overallStats.medRisk}</p>
              <p className="text-xs text-muted-foreground">Medium Risk</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-accent" />
            <div>
              <p className="text-2xl font-bold font-doodle">{overallStats.lowRisk}</p>
              <p className="text-xs text-muted-foreground">Low Risk</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-bold font-doodle">{overallStats.avgScore}</p>
              <p className="text-xs text-muted-foreground">Avg Risk Score</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sort Controls */}
      <div className="flex gap-2 items-center">
        <span className="text-xs text-muted-foreground">Sort by:</span>
        {(['risk', 'single', 'name'] as const).map(s => (
          <Badge
            key={s}
            variant={sortBy === s ? 'default' : 'outline'}
            className="cursor-pointer text-xs"
            onClick={() => setSortBy(s)}
          >
            {s === 'risk' ? 'Risk Score' : s === 'single' ? 'Single-Sourced Count' : 'Name'}
          </Badge>
        ))}
      </div>

      {/* Breadcrumb Navigation */}
      {(selectedCategory || selectedSubcategory) && (
        <div className="flex items-center gap-2 text-sm">
          <button className="text-primary hover:underline font-medium" onClick={() => { setSelectedCategory(null); setSelectedSubcategory(null); }}>
            All Categories
          </button>
          {selectedCategory && (
            <>
              <span className="text-muted-foreground">/</span>
              <button
                className={`font-medium ${selectedSubcategory ? 'text-primary hover:underline' : 'text-foreground'}`}
                onClick={() => setSelectedSubcategory(null)}
              >
                {selectedCategory}
              </button>
            </>
          )}
          {selectedSubcategory && (
            <>
              <span className="text-muted-foreground">/</span>
              <span className="font-medium text-foreground">{selectedSubcategory}</span>
            </>
          )}
        </div>
      )}

      {/* Level 1: Categories */}
      {!selectedCategory && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from(catSubGroups.entries())
            .sort((a, b) => {
              const allA = Array.from(a[1].values()).flat();
              const allB = Array.from(b[1].values()).flat();
              const maxA = Math.max(...allA.map(r => r.riskScore));
              const maxB = Math.max(...allB.map(r => r.riskScore));
              return maxB - maxA;
            })
            .map(([catName, subMap2]) => {
              const allItems = Array.from(subMap2.values()).flat();
              const catHighRisk = allItems.filter(r => r.riskScore >= 60).length;
              const catAvg = Math.round(allItems.reduce((s, r) => s + r.riskScore, 0) / allItems.length);
              return (
                <Card
                  key={catName}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setSelectedCategory(catName)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-primary" />
                        <span className="font-medium">{catName}</span>
                      </div>
                      {riskIcon(catAvg)}
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{allItems.length} products · {subMap2.size} subcategories</span>
                      {catHighRisk > 0 && (
                        <Badge variant="destructive" className="text-xs">{catHighRisk} high risk</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Progress value={catAvg} className="h-2 flex-1" />
                      <span className={`text-xs font-mono ${riskColor(catAvg)}`}>{catAvg}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

      {/* Level 2: Subcategories */}
      {selectedCategory && !selectedSubcategory && catSubGroups.has(selectedCategory) && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from(catSubGroups.get(selectedCategory)!.entries())
            .sort((a, b) => {
              const maxA = Math.max(...a[1].map(r => r.riskScore));
              const maxB = Math.max(...b[1].map(r => r.riskScore));
              return maxB - maxA;
            })
            .map(([subName, items]) => {
              const subHighRisk = items.filter(r => r.riskScore >= 60).length;
              const subAvg = Math.round(items.reduce((s, r) => s + r.riskScore, 0) / items.length);
              return (
                <Card
                  key={subName}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setSelectedSubcategory(subName)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">{subName}</span>
                      {riskIcon(subAvg)}
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{items.length} products</span>
                      {subHighRisk > 0 && (
                        <Badge variant="destructive" className="text-xs">{subHighRisk} high risk</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Progress value={subAvg} className="h-2 flex-1" />
                      <span className={`text-xs font-mono ${riskColor(subAvg)}`}>{subAvg}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

      {/* Level 3: Products in selected subcategory */}
      {selectedCategory && selectedSubcategory && (
        <div className="space-y-2">
          {(catSubGroups.get(selectedCategory)?.get(selectedSubcategory) || []).map(fg => (
            <FinishedGoodRow key={fg.product.ProductID} fg={fg} riskBadge={riskBadge} riskIcon={riskIcon} />
          ))}
        </div>
      )}
    </div>
  );
};

const FinishedGoodRow: React.FC<{
  fg: FinishedGoodRisk;
  riskBadge: (score: number) => React.ReactNode;
  riskIcon: (score: number) => React.ReactNode;
}> = ({ fg, riskBadge, riskIcon }) => {
  const [expanded, setExpanded] = useState(false);
  const isHighRisk = fg.riskScore >= 60;

  return (
    <div className="border rounded-md">
      <button
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {riskIcon(fg.riskScore)}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{fg.product.Name}</span>
            <Badge variant="outline" className="text-xs">{fg.subcategoryName}</Badge>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>{fg.totalComponents} purchasable components</span>
            {fg.singleSourced > 0 && (
              <span className="text-destructive font-medium">{fg.singleSourced} single-sourced</span>
            )}
            {fg.dualSourced > 0 && (
              <span className="text-yellow-600">{fg.dualSourced} dual-sourced</span>
            )}
          </div>
        </div>
        {/* Stock & Production Info */}
        <div className="flex items-center gap-3 shrink-0">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1 text-xs">
                  <Package className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className={`font-mono ${fg.stockOnHand === 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                    {fg.stockOnHand}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>Current stock on hand</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {fg.inProduction > 0 && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 text-xs">
                    <PlayCircle className="h-3.5 w-3.5 text-primary" />
                    <span className="font-mono text-primary">{fg.inProduction}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>Units currently in production (active work orders)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {riskBadge(fg.riskScore)}
          <span className="text-xs font-mono text-muted-foreground w-6 text-right">{fg.riskScore}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 border-t">
          {/* Action bar for high-risk items */}
          {isHighRisk && (
            <div className="flex items-center gap-3 py-3 border-b mb-2">
              <div className="flex-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{fg.stockOnHand}</span> in stock
                {fg.inProduction > 0 && <> · <span className="font-medium text-primary">{fg.inProduction}</span> in production</>}
              </div>
              <CreateProductionOrderDialog
                prefillProductId={fg.product.ProductID}
                prefillQty={Math.max(fg.product.SafetyStockLevel - fg.stockOnHand, 10)}
                trigger={
                  <Button size="sm" variant="default" className="h-7 text-xs gap-1.5">
                    <PlayCircle className="h-3.5 w-3.5" />
                    Produce More
                  </Button>
                }
              />
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Component</TableHead>
                <TableHead className="text-right">Qty/Assembly</TableHead>
                <TableHead className="text-right">In Stock</TableHead>
                <TableHead className="text-right">Vendors</TableHead>
                <TableHead>Sourcing</TableHead>
                <TableHead>Supplier(s)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fg.components.map(c => (
                <TableRow key={c.componentId}>
                  <TableCell className="text-sm">{c.componentName}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{c.perAssemblyQty}</TableCell>
                  <TableCell className="text-right">
                    <span className={`font-mono text-sm ${c.stockOnHand === 0 ? 'text-destructive font-medium' : ''}`}>
                      {c.stockOnHand}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant={c.vendorCount === 1 ? 'destructive' : c.vendorCount === 2 ? 'secondary' : 'default'}
                      className="font-mono text-xs"
                    >
                      {c.vendorCount}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.vendorCount === 1 ? (
                      <span className="text-xs text-destructive font-medium">Single-source ⚠️</span>
                    ) : c.vendorCount === 2 ? (
                      <span className="text-xs text-yellow-600">Dual-source</span>
                    ) : (
                      <span className="text-xs text-accent">Multi-source</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {c.vendors.slice(0, 3).map(v => (
                        <Link key={v.vendorId} to={`/supply/vendors/${v.vendorId}`}>
                          <Badge variant="outline" className="text-xs hover:bg-primary/10 cursor-pointer">
                            {v.vendorName}
                          </Badge>
                        </Link>
                      ))}
                      {c.vendors.length > 3 && (
                        <Badge variant="secondary" className="text-xs">+{c.vendors.length - 3}</Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

export default FinishedGoodRiskAnalysis;
