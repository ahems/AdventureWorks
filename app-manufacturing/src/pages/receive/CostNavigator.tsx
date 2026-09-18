import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, Search, X } from 'lucide-react';

import { fetchCurrentCost, fetchPlanCatalog, type FinishedGoodSnapshot } from '@/services/planningApi';
import {
  fetchManufacturedProducts,
  fetchProductCategories,
  fetchProductSubcategories,
} from '@/services/api';
import { SidebarListSkeleton } from '@/components/LoadingSkeletons';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

type SignalKey = 'all' | 'loss-making' | 'thin-margin' | 'healthy' | 'no-price';
type SortKey = 'margin-asc' | 'margin-desc' | 'name' | 'list-desc';

interface Row extends FinishedGoodSnapshot {
  categoryName: string;
  subcategoryName: string;
  /** Live margin from /plan/cost/{id}/current as a fraction (e.g. -0.13). undefined while loading. */
  currentMarginPct?: number;
  /** Signal derived from currentMarginPct when available, else falls back to catalog signal. */
  effectiveSignal: 'loss-making' | 'thin-margin' | 'healthy' | 'no-price';
  /** Margin used for sorting/display: current when loaded, else catalog. */
  effectiveMarginPct: number;
  costLoading: boolean;
}

interface Props {
  selectedProduct: number | null;
  onSelect: (id: number) => void;
}

const SIGNAL_DOT: Record<string, string> = {
  'loss-making': 'bg-destructive',
  'thin-margin': 'bg-amber-500',
  'healthy': 'bg-doodle-green',
  'no-price': 'bg-muted-foreground/40',
};

const marginColor = (pct: number, signal: string) => {
  if (signal === 'no-price') return 'text-muted-foreground';
  if (pct < 0) return 'text-destructive';
  if (pct < 0.20) return 'text-amber-600';
  return 'text-doodle-green';
};

const fmtPct = (p: number) => `${(p * 100).toFixed(1)}%`;
const fmt$ = (n: number) => `$${n.toFixed(2)}`;

const CostNavigator = ({ selectedProduct, onSelect }: Props) => {
  const [search, setSearch] = useState('');
  const [signal, setSignal] = useState<SignalKey>('all');
  const [sort, setSort] = useState<SortKey>('margin-asc');
  const [showUnpriced, setShowUnpriced] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['plan-catalog'],
    queryFn: () => fetchPlanCatalog(),
  });
  const { data: products } = useQuery({
    queryKey: ['products-meta'],
    queryFn: fetchManufacturedProducts,
  });
  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: fetchProductCategories,
  });
  const { data: subcategories } = useQuery({
    queryKey: ['subcategories'],
    queryFn: fetchProductSubcategories,
  });

  // Fetch live current cost for every catalog item so the nav reflects the same
  // numbers shown on the detail panel. The catalog's `pricingSignal` is based on
  // ProductCostHistory snapshots and can disagree with the live BOM rollup.
  const currentCostQueries = useQueries({
    queries: (catalog ?? []).map(fg => ({
      queryKey: ['current-cost', fg.productId],
      queryFn: () => fetchCurrentCost(fg.productId),
      enabled: !!catalog,
      retry: false,
      staleTime: 5 * 60 * 1000,
    })),
  });

  const currentByProduct = useMemo(() => {
    const map = new Map<number, { marginPct: number; signal: Row['effectiveSignal']; loading: boolean }>();
    (catalog ?? []).forEach((fg, i) => {
      const q = currentCostQueries[i];
      if (!q) return;
      if (q.isLoading) {
        map.set(fg.productId, { marginPct: fg.grossMarginPct, signal: fg.pricingSignal, loading: true });
      } else if (q.data && fg.listPrice > 0 && q.data.totalManufacturingCost != null) {
        const margin = (fg.listPrice - q.data.totalManufacturingCost) / fg.listPrice;
        let signal: Row['effectiveSignal'];
        if (margin < 0) signal = 'loss-making';
        else if (margin < 0.20) signal = 'thin-margin';
        else signal = 'healthy';
        map.set(fg.productId, { marginPct: margin, signal, loading: false });
      } else {
        map.set(fg.productId, { marginPct: fg.grossMarginPct, signal: fg.pricingSignal, loading: false });
      }
    });
    return map;
  }, [catalog, currentCostQueries]);

  const currentLoadingCount = currentCostQueries.filter(q => q.isLoading).length;

  const rows: Row[] = useMemo(() => {
    if (!catalog || !products) return [];
    const productById = new Map(products.map(p => [p.ProductID, p]));
    const subById = new Map((subcategories || []).map(s => [s.ProductSubcategoryID, s]));
    const catById = new Map((categories || []).map(c => [c.ProductCategoryID, c]));

    return catalog.map(fg => {
      const p = productById.get(fg.productId);
      const sub = p?.ProductSubcategoryID ? subById.get(p.ProductSubcategoryID) : undefined;
      const cat = sub ? catById.get(sub.ProductCategoryID) : undefined;
      const live = currentByProduct.get(fg.productId);
      return {
        ...fg,
        categoryName: cat?.Name || 'Uncategorized',
        subcategoryName: sub?.Name || '—',
        currentMarginPct: live && !live.loading ? live.marginPct : undefined,
        effectiveSignal: live ? live.signal : fg.pricingSignal,
        effectiveMarginPct: live ? live.marginPct : fg.grossMarginPct,
        costLoading: live?.loading ?? false,
      };
    });
  }, [catalog, products, subcategories, categories, currentByProduct]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter(r => showUnpriced || r.effectiveSignal !== 'no-price')
      .filter(r => signal === 'all' || r.effectiveSignal === signal)
      .filter(r => !q || r.name.toLowerCase().includes(q) || (r.productNumber || '').toLowerCase().includes(q));
  }, [rows, search, signal, showUnpriced]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sort) {
      case 'margin-asc': arr.sort((a, b) => a.effectiveMarginPct - b.effectiveMarginPct); break;
      case 'margin-desc': arr.sort((a, b) => b.effectiveMarginPct - a.effectiveMarginPct); break;
      case 'name': arr.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'list-desc': arr.sort((a, b) => b.listPrice - a.listPrice); break;
    }
    return arr;
  }, [filtered, sort]);

  // Group by Category › Subcategory
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; category: string; subcategory: string; items: Row[] }>();
    sorted.forEach(r => {
      const key = `${r.categoryName} › ${r.subcategoryName}`;
      if (!map.has(key)) map.set(key, { key, category: r.categoryName, subcategory: r.subcategoryName, items: [] });
      map.get(key)!.items.push(r);
    });
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [sorted]);

  // Counts for the chip bar (use live signal)
  const counts = useMemo(() => {
    const base = rows.filter(r => showUnpriced || r.effectiveSignal !== 'no-price');
    return {
      all: base.length,
      'loss-making': base.filter(r => r.effectiveSignal === 'loss-making').length,
      'thin-margin': base.filter(r => r.effectiveSignal === 'thin-margin').length,
      'healthy': base.filter(r => r.effectiveSignal === 'healthy').length,
      'no-price': rows.filter(r => r.effectiveSignal === 'no-price').length,
    };
  }, [rows, showUnpriced]);

  // Expand loss-making groups by default; collapse others.
  const isOpen = (g: { items: Row[]; key: string }) => {
    if (collapsed[g.key] !== undefined) return !collapsed[g.key];
    return g.items.some(i => i.effectiveSignal === 'loss-making');
  };
  const toggleGroup = (key: string, currentlyOpen: boolean) =>
    setCollapsed(c => ({ ...c, [key]: currentlyOpen }));

  const expandAll = () => setCollapsed(Object.fromEntries(groups.map(g => [g.key, false])));
  const collapseAll = () => setCollapsed(Object.fromEntries(groups.map(g => [g.key, true])));
  const clearFilters = () => { setSearch(''); setSignal('all'); };

  if (catalogLoading) {
    return (
      <div className="doodle-card-static p-4">
        <SidebarListSkeleton count={12} />
      </div>
    );
  }

  return (
    <div className="doodle-card-static p-3 space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or number..."
          className="w-full pl-8 pr-8 py-2 font-doodle text-sm border-2 border-dashed border-doodle-text/30 rounded bg-background focus:outline-none focus:border-doodle-accent"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2">
            <X className="w-3.5 h-3.5 text-muted-foreground hover:text-doodle-text" />
          </button>
        )}
      </div>

      {/* Signal chips */}
      <div className="flex flex-wrap gap-1.5">
        {([
          ['all', 'All'],
          ['loss-making', 'Loss'],
          ['thin-margin', 'Thin'],
          ['healthy', 'Healthy'],
          ['no-price', 'No price'],
        ] as [SignalKey, string][]).map(([key, label]) => {
          const active = signal === key;
          const dot = key !== 'all' ? SIGNAL_DOT[key] : '';
          return (
            <button
              key={key}
              onClick={() => setSignal(key)}
              className={`px-2 py-1 font-doodle text-xs rounded inline-flex items-center gap-1.5 transition-colors ${
                active
                  ? 'border-2 border-dashed border-doodle-accent text-doodle-accent bg-doodle-accent/10'
                  : 'border border-doodle-text/20 text-muted-foreground hover:bg-secondary/40'
              }`}
            >
              {dot && <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />}
              {label}
              <span className="opacity-70">({counts[key]})</span>
            </button>
          );
        })}
      </div>

      {/* Sort + expand controls */}
      <div className="flex items-center justify-between gap-2 text-xs font-doodle">
        <select
          value={sort}
          onChange={e => setSort(e.target.value as SortKey)}
          className="px-2 py-1 border border-doodle-text/20 rounded bg-background text-doodle-text"
        >
          <option value="margin-asc">Margin: worst first</option>
          <option value="margin-desc">Margin: best first</option>
          <option value="name">Name (A→Z)</option>
          <option value="list-desc">List price (high→low)</option>
        </select>
        <div className="flex items-center gap-2">
          <button onClick={expandAll} className="text-doodle-blue hover:underline">Expand</button>
          <span className="text-muted-foreground">/</span>
          <button onClick={collapseAll} className="text-doodle-blue hover:underline">Collapse</button>
        </div>
      </div>

      {/* Show-unpriced toggle + live-cost progress */}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 font-doodle text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showUnpriced}
            onChange={e => setShowUnpriced(e.target.checked)}
            className="accent-doodle-accent"
          />
          Show unpriced items
        </label>
        {currentLoadingCount > 0 && (
          <span className="inline-flex items-center gap-1 font-doodle text-[11px] text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            Refreshing live margins ({currentLoadingCount})
          </span>
        )}
      </div>

      {/* List */}
      <div className="max-h-[36rem] overflow-y-auto -mx-1 px-1 space-y-2">
        {groups.length === 0 ? (
          <div className="text-center py-8 font-doodle text-sm text-muted-foreground">
            No products match these filters.
            <button onClick={clearFilters} className="block mx-auto mt-2 text-doodle-blue hover:underline">
              Clear filters
            </button>
          </div>
        ) : (
          groups.map(g => {
            const open = isOpen(g);
            const lossN = g.items.filter(i => i.effectiveSignal === 'loss-making').length;
            const thinN = g.items.filter(i => i.effectiveSignal === 'thin-margin').length;
            return (
              <Collapsible key={g.key} open={open} onOpenChange={(v) => toggleGroup(g.key, !v)}>
                <CollapsibleTrigger className="w-full">
                  <div className="flex items-center justify-between px-2 py-1.5 font-doodle text-xs bg-secondary/30 hover:bg-secondary/60 rounded border border-dashed border-doodle-text/20">
                    <div className="flex items-center gap-1.5 text-doodle-text">
                      {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      <span className="font-bold">{g.category}</span>
                      <span className="text-muted-foreground">›</span>
                      <span>{g.subcategory}</span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>{g.items.length}</span>
                      {lossN > 0 && <span className="text-destructive">{lossN} loss</span>}
                      {thinN > 0 && <span className="text-amber-600">{thinN} thin</span>}
                    </div>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-1 space-y-0.5">
                    {g.items.map(r => {
                      const active = selectedProduct === r.productId;
                      const dot = SIGNAL_DOT[r.effectiveSignal] || SIGNAL_DOT['no-price'];
                      const showLive = r.currentMarginPct !== undefined;
                      return (
                        <button
                          key={r.productId}
                          onClick={() => onSelect(r.productId)}
                          className={`w-full text-left px-2 py-1.5 rounded transition-colors ${
                            active
                              ? 'bg-doodle-accent/15 border-l-4 border-doodle-accent'
                              : 'hover:bg-secondary/40 border-l-4 border-transparent'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className={`font-doodle text-sm truncate ${active ? 'font-bold text-doodle-accent' : 'text-doodle-text'}`}>
                              {r.name}
                            </span>
                            <span className={`flex-shrink-0 inline-block w-2 h-2 rounded-full ${dot}`} />
                          </div>
                          <div className="font-doodle text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
                            {r.effectiveSignal === 'no-price' ? (
                              <span>No list price</span>
                            ) : (
                              <>
                                <span>{fmt$(r.listPrice)} list</span>
                                <span>·</span>
                                <span
                                  className={`font-bold ${marginColor(r.effectiveMarginPct, r.effectiveSignal)}`}
                                  title={
                                    showLive
                                      ? `Live BOM rollup margin. Catalog snapshot: ${fmtPct(r.grossMarginPct)}.`
                                      : r.costLoading
                                        ? 'Live margin loading…'
                                        : 'Catalog snapshot margin.'
                                  }
                                >
                                  {fmtPct(r.effectiveMarginPct)}
                                </span>
                                {r.costLoading && <Loader2 className="w-2.5 h-2.5 animate-spin text-muted-foreground" />}
                                {showLive && Math.abs(r.effectiveMarginPct - r.grossMarginPct) > 0.01 && (
                                  <span className="text-[10px] text-muted-foreground/70" title="Live margin differs from catalog snapshot">live</span>
                                )}
                              </>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })
        )}
      </div>
    </div>
  );
};

export default CostNavigator;
