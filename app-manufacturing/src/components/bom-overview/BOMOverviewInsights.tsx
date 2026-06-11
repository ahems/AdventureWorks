import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Layers, Wrench, DollarSign, Search, RefreshCw } from 'lucide-react';
import {
  fetchWorkOrders,
  fetchActiveOperations,
  fetchProductInventory,
  fetchProductCostHistory,
  fetchWorkOrderRouting,
} from '@/services/api';
import { fetchCatalog, fetchOrders } from '@/services/supplyChainApi';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { BillOfMaterials, Product } from '@/types/production';
import {
  buildAllAssemblyStats,
  buildComponentUsage,
  flattenForExplosion,
  classifyWorkOrder,
  fmtMoney,
  fmtDate,
  type AssemblyStats,
} from './utils';
import RowDrillDownDialog from './RowDrillDownDialog';
import ShortageDrillDownDialog, { type ShortageContext } from './ShortageDrillDownDialog';

interface Props {
  bom: BillOfMaterials[];
  products: Product[];
}

type SectionKey = 'cross' | 'cost' | 'ops';

const SECTIONS: { key: SectionKey; label: string; icon: React.ElementType }[] = [
  { key: 'cross', label: 'Cross-BOM Intelligence', icon: Layers },
  { key: 'cost', label: 'Cost & Risk', icon: DollarSign },
  { key: 'ops', label: 'Operations', icon: Wrench },
];

const TOP_N = 12;

const Card: React.FC<{
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  loading?: boolean;
}> = ({ title, subtitle, children, loading }) => (
  <div className="doodle-card-static p-4 flex flex-col">
    <div className="mb-3">
      <h3 className="font-doodle text-sm font-bold text-doodle-text">{title}</h3>
      {subtitle && (
        <p className="font-doodle text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      )}
    </div>
    {loading ? (
      <div className="space-y-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    ) : (
      children
    )}
  </div>
);

const Th: React.FC<{ className?: string; children?: React.ReactNode }> = ({ className = '', children }) => (
  <th className={`py-1.5 px-2 text-left font-doodle text-[11px] text-muted-foreground font-normal ${className}`}>
    {children}
  </th>
);

function SortableTh<K extends string>({
  sortKey, current, onSort, align = 'left', children,
}: {
  sortKey: K;
  current: { key: K; dir: 'asc' | 'desc' };
  onSort: (s: { key: K; dir: 'asc' | 'desc' }) => void;
  align?: 'left' | 'right';
  children: React.ReactNode;
}) {
  const active = current.key === sortKey;
  const arrow = active ? (current.dir === 'asc' ? '▲' : '▼') : '↕';
  return (
    <th className={`py-1.5 px-2 font-doodle text-[11px] font-normal ${align === 'right' ? 'text-right' : 'text-left'} ${active ? 'text-doodle-accent' : 'text-muted-foreground'}`}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-doodle-text transition-colors"
        onClick={() => onSort({ key: sortKey, dir: active && current.dir === 'desc' ? 'asc' : 'desc' })}
      >
        <span>{children}</span>
        <span className="text-[9px] opacity-70">{arrow}</span>
      </button>
    </th>
  );
}

const Td: React.FC<{ className?: string; children?: React.ReactNode; colSpan?: number }> = ({
  className = '',
  children,
  colSpan,
}) => (
  <td colSpan={colSpan} className={`py-1.5 px-2 font-doodle text-xs text-doodle-text ${className}`}>
    {children}
  </td>
);

const ALink: React.FC<{ to: string; children: React.ReactNode }> = ({ to, children }) => (
  <Link to={to} className="text-doodle-blue hover:underline font-bold">
    {children}
  </Link>
);

export type InspectTarget = {
  productId: number;
  productName: string;
  kind: 'component' | 'assembly';
  initialTab?: 'bom' | 'wos' | 'cost' | 'vendors';
};

export const InspectButton: React.FC<{ onClick: () => void; label?: string }> = ({ onClick, label = 'Inspect' }) => (
  <button
    onClick={onClick}
    className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-doodle-accent/15 text-muted-foreground hover:text-doodle-accent border border-dashed border-transparent hover:border-doodle-accent/30 transition-colors"
    aria-label={label}
    title={label}
  >
    <Search className="w-3 h-3" />
  </button>
);

const AUTO_REFRESH_OPTIONS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
];

const LiveControls: React.FC<{
  autoMs: number;
  onChangeAutoMs: (ms: number) => void;
  onRefresh: () => void;
  isFetching: boolean;
  lastUpdatedAt: number;
}> = ({ autoMs, onChangeAutoMs, onRefresh, isFetching, lastUpdatedAt }) => {
  // Tick once a second so the "x ago" label stays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const ago = lastUpdatedAt ? Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / 1000)) : null;
  const agoLabel =
    ago === null ? 'never'
      : ago < 5 ? 'just now'
        : ago < 60 ? `${ago}s ago`
          : ago < 3600 ? `${Math.floor(ago / 60)}m ago`
            : `${Math.floor(ago / 3600)}h ago`;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded border-2 border-dashed border-doodle-text/15 bg-secondary/20">
      <button
        onClick={onRefresh}
        disabled={isFetching}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded font-doodle text-xs font-bold border-2 border-dashed border-doodle-accent/40 text-doodle-accent hover:bg-doodle-accent/15 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title="Refresh now"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        Refresh
      </button>

      <div className="flex items-center gap-1 ml-1">
        <span className="font-doodle text-[11px] text-muted-foreground">Auto:</span>
        {AUTO_REFRESH_OPTIONS.map(opt => {
          const active = autoMs === opt.ms;
          return (
            <button
              key={opt.ms}
              onClick={() => onChangeAutoMs(opt.ms)}
              className={`px-2 py-0.5 rounded font-doodle text-[11px] border border-dashed transition-colors ${
                active
                  ? 'bg-doodle-accent/15 text-doodle-accent border-doodle-accent/40 font-bold'
                  : 'border-transparent text-muted-foreground hover:text-doodle-text hover:border-doodle-text/20'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="ml-auto font-doodle text-[11px] text-muted-foreground">
        {isFetching ? 'Refreshing…' : `Updated ${agoLabel}`}
      </div>
    </div>
  );
};

type WIPSummary = { planned: number; released: number; completed30: number; scrapped: number; remaining: number; dueSoon: number };

const WIPStat: React.FC<{ label: string; value: React.ReactNode; tone?: 'default' | 'accent' | 'warn' | 'muted'; hint?: string }> = ({
  label, value, tone = 'default', hint,
}) => {
  const toneCls =
    tone === 'accent' ? 'text-doodle-accent'
      : tone === 'warn' ? 'text-destructive'
        : tone === 'muted' ? 'text-muted-foreground'
          : 'text-doodle-text';
  return (
    <div className="flex flex-col px-3 py-1.5 min-w-[88px]" title={hint}>
      <span className="font-doodle text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`font-doodle text-lg font-bold leading-tight ${toneCls}`}>{value}</span>
    </div>
  );
};

const WIPSummaryStrip: React.FC<{ summary: WIPSummary; loading?: boolean }> = ({ summary, loading }) => {
  const openCount = summary.planned + summary.released;
  return (
    <div className="doodle-card-static p-2 flex flex-wrap items-center gap-1 divide-x-2 divide-dashed divide-doodle-text/10">
      <WIPStat label="Open WOs" value={loading ? '…' : openCount.toLocaleString()} tone="accent" hint="Planned + Released" />
      <WIPStat label="Remaining qty" value={loading ? '…' : Math.round(summary.remaining).toLocaleString()} hint="Σ (OrderQty − StockedQty) across open WOs" />
      <WIPStat label="Planned" value={loading ? '…' : summary.planned.toLocaleString()} tone="muted" />
      <WIPStat label="Released" value={loading ? '…' : summary.released.toLocaleString()} tone="accent" />
      <WIPStat label="Due ≤ 7d" value={loading ? '…' : summary.dueSoon.toLocaleString()} tone={summary.dueSoon > 0 ? 'warn' : 'muted'} hint="Open WOs with DueDate within 7 days" />
      <WIPStat label="Done 30d" value={loading ? '…' : summary.completed30.toLocaleString()} tone="muted" />
      <WIPStat label="Scrapped" value={loading ? '…' : summary.scrapped.toLocaleString()} tone={summary.scrapped > 0 ? 'warn' : 'muted'} />
    </div>
  );
};

const BOMOverviewInsights: React.FC<Props> = ({ bom, products }) => {
  const [section, setSection] = useState<SectionKey>('cross');
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const onInspect = (t: InspectTarget) => setInspect(t);

  // ── Common derived data ────────────────────────────────────────────────
  const productMap = useMemo(() => {
    const m = new Map<number, Product>();
    products.forEach(p => m.set(p.ProductID, p));
    return m;
  }, [products]);

  const assemblies = useMemo(
    () => buildAllAssemblyStats(bom, productMap),
    [bom, productMap],
  );
  const assemblyById = useMemo(() => {
    const m = new Map<number, AssemblyStats>();
    assemblies.forEach(a => m.set(a.assemblyId, a));
    return m;
  }, [assemblies]);

  const componentUsage = useMemo(() => buildComponentUsage(bom), [bom]);

  // ── Queries (gated by section) ────────────────────────────────────────
  const wantOps = section === 'ops';
  const wantCost = section === 'cost';
  // Cost & Risk also needs WO + inventory data to compute exposure / stock vs ROP.
  const wantWoData = wantOps || wantCost;
  const wantInventory = wantOps || wantCost;

  // Auto-refresh controls (per-lens, ops/cost only)
  const queryClient = useQueryClient();
  const [autoMsByLens, setAutoMsByLens] = useState<Record<'ops' | 'cost', number>>({
    ops: 0,
    cost: 0,
  });
  const liveLens: 'ops' | 'cost' | null = wantOps ? 'ops' : wantCost ? 'cost' : null;
  const autoMs = liveLens ? autoMsByLens[liveLens] : 0;
  const opsInterval = wantOps && autoMs > 0 ? autoMs : false;
  const costInterval = wantCost && autoMs > 0 ? autoMs : false;

  const woQ = useQuery({
    queryKey: ['all-recent-wos'],
    queryFn: fetchWorkOrders,
    enabled: wantWoData,
    staleTime: 60_000,
    refetchInterval: wantWoData && autoMs > 0 ? autoMs : false,
  });
  const aoQ = useQuery({
    queryKey: ['active-operations'],
    queryFn: fetchActiveOperations,
    enabled: wantWoData,
    staleTime: 30_000,
    refetchInterval: wantWoData && autoMs > 0 ? autoMs : false,
  });
  const invQ = useQuery({
    queryKey: ['all-product-inventory'],
    queryFn: () => fetchProductInventory(),
    enabled: wantInventory,
    staleTime: 60_000,
    refetchInterval: wantInventory && autoMs > 0 ? autoMs : false,
  });
  const rtQ = useQuery({
    queryKey: ['recent-routings'],
    queryFn: () => fetchWorkOrderRouting(),
    enabled: wantOps,
    staleTime: 60_000,
    refetchInterval: opsInterval,
  });
  const poQ = useQuery({
    queryKey: ['open-purchase-orders'],
    queryFn: fetchOrders,
    enabled: wantOps,
    staleTime: 60_000,
    refetchInterval: opsInterval,
  });
  const catQ = useQuery({
    queryKey: ['supply-catalog-all'],
    queryFn: () => fetchCatalog(),
    enabled: wantCost,
    staleTime: 60_000,
    refetchInterval: costInterval,
  });
  const chQ = useQuery({
    queryKey: ['all-cost-history'],
    queryFn: () => fetchProductCostHistory(),
    enabled: wantCost,
    staleTime: 60_000,
    refetchInterval: costInterval,
  });

  const { data: workOrders, isLoading: woLoading } = woQ;
  const { data: activeOps } = aoQ;
  const { data: inventory } = invQ;
  const { data: routings } = rtQ;
  const { data: openPOs } = poQ;
  const { data: catalog, isLoading: catalogLoading } = catQ;
  const { data: costHistory, isLoading: chLoading } = chQ;

  // Lens-specific live state
  const lensQueries = wantOps
    ? [woQ, aoQ, invQ, rtQ, poQ]
    : wantCost
      ? [woQ, aoQ, invQ, catQ, chQ]
      : [];
  const lensQueryKeys = wantOps
    ? [['all-recent-wos'], ['active-operations'], ['all-product-inventory'], ['recent-routings'], ['open-purchase-orders']]
    : wantCost
      ? [['all-recent-wos'], ['active-operations'], ['all-product-inventory'], ['supply-catalog-all'], ['all-cost-history']]
      : [];
  const lastUpdatedAt = lensQueries.reduce((max, q) => Math.max(max, q.dataUpdatedAt || 0), 0);
  const isFetching = lensQueries.some(q => q.isFetching);

  const handleManualRefresh = () => {
    lensQueryKeys.forEach(k => queryClient.invalidateQueries({ queryKey: k }));
  };


  return (
    <div className="space-y-4">
      {/* Section tabs */}
      <div className="flex flex-wrap gap-2 border-b-2 border-dashed border-doodle-text/15 pb-2">
        {SECTIONS.map(s => {
          const Icon = s.icon;
          const active = section === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded font-doodle text-sm transition-colors ${
                active
                  ? 'bg-doodle-accent/15 text-doodle-accent border-2 border-dashed border-doodle-accent/40 font-bold'
                  : 'hover:bg-secondary/50 text-doodle-text border-2 border-transparent'
              }`}
            >
              <Icon className="w-4 h-4" />
              {s.label}
            </button>
          );
        })}
      </div>

      {liveLens && (
        <LiveControls
          autoMs={autoMs}
          onChangeAutoMs={(ms) =>
            setAutoMsByLens(prev => ({ ...prev, [liveLens]: ms }))
          }
          onRefresh={handleManualRefresh}
          isFetching={isFetching}
          lastUpdatedAt={lastUpdatedAt}
        />
      )}

      {section === 'cross' && (
        <CrossBOMSection
          assemblies={assemblies}
          componentUsage={componentUsage}
          productMap={productMap}
          assemblyById={assemblyById}
          onInspect={onInspect}
        />
      )}
      {section === 'cost' && (
        <CostRiskSection
          assemblies={assemblies}
          componentUsage={componentUsage}
          productMap={productMap}
          catalog={catalog}
          costHistory={costHistory}
          workOrders={workOrders}
          activeOps={activeOps}
          inventory={inventory}
          loading={catalogLoading || chLoading}
          onInspect={onInspect}
        />
      )}
      {section === 'ops' && (
        <OperationsSection
          assemblies={assemblies}
          assemblyById={assemblyById}
          productMap={productMap}
          bom={bom}
          workOrders={workOrders}
          activeOps={activeOps}
          inventory={inventory}
          routings={routings}
          openPOs={openPOs}
          loading={woLoading}
          onInspect={onInspect}
        />
      )}

      {inspect && (
        <RowDrillDownDialog
          open={!!inspect}
          onOpenChange={(o) => !o && setInspect(null)}
          productId={inspect.productId}
          productName={inspect.productName}
          kind={inspect.kind}
          initialTab={inspect.initialTab}
        />
      )}
    </div>
  );
};

// ── Section 1: Cross-BOM Intelligence ──────────────────────────────────
const CrossBOMSection: React.FC<{
  assemblies: AssemblyStats[];
  componentUsage: Map<number, Set<number>>;
  productMap: Map<number, Product>;
  assemblyById: Map<number, AssemblyStats>;
  onInspect: (t: InspectTarget) => void;
}> = ({ assemblies, componentUsage, productMap, assemblyById, onInspect }) => {
  // 1a. Shared / High-Reuse Components
  const sharedRows = useMemo(() => {
    const rows = Array.from(componentUsage.entries()).map(([cid, parents]) => {
      const p = productMap.get(cid);
      return {
        cid,
        name: p?.Name || `#${cid}`,
        bomCount: parents.size,
        unitCost: p?.StandardCost ?? 0,
        parents: Array.from(parents),
      };
    });
    rows.sort((a, b) => b.bomCount - a.bomCount);
    return rows.filter(r => r.bomCount >= 2).slice(0, TOP_N);
  }, [componentUsage, productMap]);

  // 1b. Most Complex BOMs
  const complexRows = useMemo(() => {
    return [...assemblies]
      .sort((a, b) => b.depth - a.depth || b.nodeCount - a.nodeCount)
      .slice(0, TOP_N);
  }, [assemblies]);

  // 1c. Recently Modified BOMs
  const recentRows = useMemo(() => {
    return [...assemblies]
      .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1))
      .slice(0, TOP_N);
  }, [assemblies]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card title="Shared Components" subtitle="Used across the most assemblies">
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <Th>Component</Th>
              <Th className="!text-right">BOMs</Th>
              <Th className="!text-right">Unit $</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {sharedRows.map(r => (
              <tr key={r.cid} className="border-b border-doodle-text/5 hover:bg-secondary/30">
                <Td>
                  <ALink to={`/define/products/${r.cid}`}>{r.name}</ALink>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="ml-1 text-[10px] text-muted-foreground cursor-help">
                          ({r.bomCount})
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="font-doodle text-xs max-w-xs">
                        <div className="font-bold mb-1">Used in:</div>
                        <ul className="space-y-0.5">
                          {r.parents.slice(0, 8).map(pid => (
                            <li key={pid}>• {assemblyById.get(pid)?.assemblyName || `#${pid}`}</li>
                          ))}
                          {r.parents.length > 8 && (
                            <li className="text-muted-foreground">…and {r.parents.length - 8} more</li>
                          )}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Td>
                <Td className="!text-right font-bold">{r.bomCount}</Td>
                <Td className="!text-right">${r.unitCost.toFixed(2)}</Td>
                <Td className="!text-right">
                  <InspectButton onClick={() => onInspect({ productId: r.cid, productName: r.name, kind: 'component', initialTab: 'bom' })} />
                </Td>
              </tr>
            ))}
            {sharedRows.length === 0 && (
              <tr><Td className="text-muted-foreground" colSpan={4}>No shared components.</Td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Most Complex BOMs" subtitle="Deepest trees with the most components">
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <Th>Assembly</Th>
              <Th className="!text-right">Depth</Th>
              <Th className="!text-right">Nodes</Th>
              <Th className="!text-right">Rolled-up $</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {complexRows.map(r => (
              <tr key={r.assemblyId} className="border-b border-doodle-text/5 hover:bg-secondary/30">
                <Td><ALink to={`/engineer/bom/${r.assemblyId}`}>{r.assemblyName}</ALink></Td>
                <Td className="!text-right font-bold">{r.depth}</Td>
                <Td className="!text-right">{r.nodeCount}</Td>
                <Td className="!text-right text-doodle-green font-bold">{fmtMoney(r.rolledUpCost)}</Td>
                <Td className="!text-right">
                  <InspectButton onClick={() => onInspect({ productId: r.assemblyId, productName: r.assemblyName, kind: 'assembly', initialTab: 'bom' })} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Recently Modified BOMs" subtitle="Most recent line edits across active BOMs">
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <Th>Assembly</Th>
              <Th className="!text-right">Last edit</Th>
              <Th className="!text-right">Lines (90d)</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {recentRows.map(r => (
              <tr key={r.assemblyId} className="border-b border-doodle-text/5 hover:bg-secondary/30">
                <Td><ALink to={`/engineer/bom/${r.assemblyId}`}>{r.assemblyName}</ALink></Td>
                <Td className="!text-right">{fmtDate(r.lastModified)}</Td>
                <Td className="!text-right font-bold">{r.recentLineCount}</Td>
                <Td className="!text-right">
                  <InspectButton onClick={() => onInspect({ productId: r.assemblyId, productName: r.assemblyName, kind: 'assembly', initialTab: 'bom' })} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

// ── Section 2: Cost & Risk Lenses ──────────────────────────────────────
const CostRiskSection: React.FC<{
  assemblies: AssemblyStats[];
  componentUsage: Map<number, Set<number>>;
  productMap: Map<number, Product>;
  catalog: Awaited<ReturnType<typeof fetchCatalog>> | undefined;
  costHistory: Awaited<ReturnType<typeof fetchProductCostHistory>> | undefined;
  workOrders: Awaited<ReturnType<typeof fetchWorkOrders>> | undefined;
  activeOps: Awaited<ReturnType<typeof fetchActiveOperations>> | undefined;
  inventory: Awaited<ReturnType<typeof fetchProductInventory>> | undefined;
  loading: boolean;
  onInspect: (t: InspectTarget) => void;
}> = ({ assemblies, componentUsage, productMap, catalog, costHistory, workOrders, activeOps, inventory, loading, onInspect }) => {
  const activeIds = useMemo(() => {
    const s = new Set<number>();
    activeOps?.forEach(op => s.add(op.workOrderId));
    return s;
  }, [activeOps]);

  // For every component used anywhere in any assembly tree, track which finished
  // assemblies depend on it (transitively) — needed for "# finished goods downstream".
  const downstreamFG = useMemo(() => {
    const map = new Map<number, Set<number>>(); // componentId → set of root-assembly IDs
    for (const a of assemblies) {
      const explosion = flattenForExplosion(a.tree);
      explosion.forEach((_qty, cid) => {
        const set = map.get(cid) || new Set<number>();
        set.add(a.assemblyId);
        map.set(cid, set);
      });
    }
    return map;
  }, [assemblies]);

  // Open-WO exposure $ per component, plus the top-affected parent assembly.
  // Exposure = Σ over open WOs of (remainingAssy × per-assembly explosion qty × unitCost).
  const exposureByComponent = useMemo(() => {
    const exp = new Map<number, { total: number; byParent: Map<number, number> }>();
    if (!workOrders) return exp;
    const assemblyById = new Map(assemblies.map(a => [a.assemblyId, a]));
    for (const wo of workOrders) {
      const a = assemblyById.get(wo.ProductID);
      if (!a) continue;
      const status = classifyWorkOrder(wo, activeIds);
      if (status !== 'Planned' && status !== 'Released') continue;
      const remainingAssy = Math.max(0, wo.OrderQty - wo.StockedQty);
      if (remainingAssy === 0) continue;
      const explosion = flattenForExplosion(a.tree);
      explosion.forEach((perAssy, cid) => {
        const unitCost = productMap.get(cid)?.StandardCost ?? 0;
        const dollars = perAssy * remainingAssy * unitCost;
        if (dollars === 0) return;
        const slot = exp.get(cid) || { total: 0, byParent: new Map<number, number>() };
        slot.total += dollars;
        slot.byParent.set(a.assemblyId, (slot.byParent.get(a.assemblyId) || 0) + dollars);
        exp.set(cid, slot);
      });
    }
    return exp;
  }, [workOrders, activeIds, assemblies, productMap]);

  // On-hand qty per product
  const onHandByProduct = useMemo(() => {
    const m = new Map<number, number>();
    inventory?.forEach(i => m.set(i.ProductID, (m.get(i.ProductID) || 0) + i.Quantity));
    return m;
  }, [inventory]);

  // 2a. Most Expensive Rollups
  const expensiveRows = useMemo(() => {
    return [...assemblies]
      .map(a => {
        const margin = a.listPrice - a.rolledUpCost;
        const marginPct = a.listPrice > 0 ? margin / a.listPrice : 0;
        return { ...a, margin, marginPct };
      })
      .sort((a, b) => b.rolledUpCost - a.rolledUpCost)
      .slice(0, TOP_N);
  }, [assemblies]);

  // 2b. Volatile cost-source components — backed by ProductCostHistory + vendor catalog.
  const volatileRows = useMemo(() => {
    if (!catalog && !costHistory) return [];
    const histByProduct = new Map<number, NonNullable<typeof costHistory>>();
    costHistory?.forEach(h => {
      const arr = histByProduct.get(h.ProductID) || [];
      arr.push(h);
      histByProduct.set(h.ProductID, arr);
    });
    const catalogByProduct = new Map<number, NonNullable<typeof catalog>[number]>();
    catalog?.forEach(q => {
      // Keep the cheapest quote per product as "current"
      const prev = catalogByProduct.get(q.productId);
      if (!prev || q.unitCost < prev.unitCost) catalogByProduct.set(q.productId, q);
    });

    const rows: Array<{
      cid: number;
      name: string;
      source: 'Cost History' | 'Last Receipt';
      currentCost: number;
      lastDelta: number;
      bomCount: number;
      exposure: number;
      topParentId: number | null;
      topParentName: string;
    }> = [];
    componentUsage.forEach((parents, cid) => {
      const p = productMap.get(cid);
      const hist = (histByProduct.get(cid) || []).slice().sort((a, b) =>
        a.StartDate < b.StartDate ? 1 : -1,
      );
      const hasHist = hist.length >= 2;
      const catalogQuote = catalogByProduct.get(cid);
      if (!hasHist && !catalogQuote) return;
      const lastDelta = hasHist ? hist[0].StandardCost - hist[1].StandardCost : 0;
      const currentCost = catalogQuote?.unitCost ?? hist[0]?.StandardCost ?? p?.StandardCost ?? 0;
      const expSlot = exposureByComponent.get(cid);
      let topParentId: number | null = null;
      let topParentDollars = 0;
      expSlot?.byParent.forEach((d, pid) => {
        if (d > topParentDollars) { topParentDollars = d; topParentId = pid; }
      });
      rows.push({
        cid,
        name: p?.Name || `#${cid}`,
        source: hasHist ? 'Cost History' : 'Last Receipt',
        currentCost,
        lastDelta,
        bomCount: parents.size,
        exposure: expSlot?.total ?? 0,
        topParentId,
        topParentName: topParentId != null ? (productMap.get(topParentId)?.Name || `#${topParentId}`) : '',
      });
    });
    // Sort by open-WO exposure first (real $ at risk), then by |Δ| × BOM count.
    rows.sort((a, b) => {
      if (b.exposure !== a.exposure) return b.exposure - a.exposure;
      return Math.abs(b.lastDelta) * b.bomCount - Math.abs(a.lastDelta) * a.bomCount;
    });
    return rows.slice(0, TOP_N);
  }, [catalog, costHistory, componentUsage, productMap, exposureByComponent]);

  // 2c. Single-sourced components in BOMs
  const singleSourcedRows = useMemo(() => {
    if (!catalog) return [];
    const byProduct = new Map<number, NonNullable<typeof catalog>>();
    catalog.forEach(q => {
      const arr = byProduct.get(q.productId) || [];
      arr.push(q);
      byProduct.set(q.productId, arr);
    });
    const rows: Array<{
      cid: number;
      name: string;
      vendorId: string;
      vendor: string;
      leadTime: number;
      bomCount: number;
      finishedGoods: number;
      onHand: number;
      reorderPoint: number;
      belowROP: boolean;
    }> = [];
    componentUsage.forEach((parents, cid) => {
      const quotes = byProduct.get(cid);
      if (!quotes) return;
      const distinctVendors = new Set(quotes.map(q => q.vendorId));
      if (distinctVendors.size !== 1) return;
      const quote = quotes[0];
      const product = productMap.get(cid);
      const onHand = onHandByProduct.get(cid) ?? 0;
      const rop = product?.ReorderPoint ?? 0;
      rows.push({
        cid,
        name: product?.Name || `#${cid}`,
        vendorId: quote.vendorId,
        vendor: quote.vendorName,
        leadTime: quote.leadTimeDays,
        bomCount: parents.size,
        finishedGoods: downstreamFG.get(cid)?.size ?? parents.size,
        onHand,
        reorderPoint: rop,
        belowROP: rop > 0 && onHand < rop,
      });
    });
    rows.sort((a, b) => {
      if (a.belowROP !== b.belowROP) return a.belowROP ? -1 : 1;
      return b.finishedGoods - a.finishedGoods;
    });
    return rows.slice(0, TOP_N);
  }, [catalog, componentUsage, productMap, downstreamFG, onHandByProduct]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card title="Most Expensive Rollups" subtitle="Highest material cost per finished assembly">
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <Th>Assembly</Th>
              <Th className="!text-right">Cost</Th>
              <Th className="!text-right">List</Th>
              <Th className="!text-right">Margin %</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {expensiveRows.map(r => (
              <tr key={r.assemblyId} className="border-b border-doodle-text/5 hover:bg-secondary/30">
                <Td><ALink to={`/engineer/bom/${r.assemblyId}`}>{r.assemblyName}</ALink></Td>
                <Td className="!text-right">{fmtMoney(r.rolledUpCost)}</Td>
                <Td className="!text-right">{r.listPrice > 0 ? fmtMoney(r.listPrice) : '—'}</Td>
                <Td className={`!text-right font-bold ${r.marginPct < 0 ? 'text-doodle-accent' : r.marginPct < 0.2 ? 'text-doodle-text' : 'text-doodle-green'}`}>
                  {r.listPrice > 0 ? `${(r.marginPct * 100).toFixed(0)}%` : '—'}
                </Td>
                <Td className="!text-right">
                  <InspectButton onClick={() => onInspect({ productId: r.assemblyId, productName: r.assemblyName, kind: 'assembly', initialTab: 'bom' })} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Volatile Cost Sources"
        subtitle="Components priced by Cost History or vendor receipts — sorted by open-WO $ exposure"
        loading={loading}
      >
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <Th>Component</Th>
              <Th>Source</Th>
              <Th className="!text-right">Unit $</Th>
              <Th className="!text-right">Last Δ$</Th>
              <Th className="!text-right">BOMs</Th>
              <Th className="!text-right">Open WO $</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {volatileRows.map(r => (
              <tr key={r.cid} className="border-b border-doodle-text/5 hover:bg-secondary/30 bg-doodle-accent/5">
                <Td>
                  <ALink to={`/receive/costing/${r.cid}`}>{r.name}</ALink>
                </Td>
                <Td>
                  <Badge variant="outline" className={`text-[10px] px-1 py-0 ${r.source === 'Cost History' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
                    {r.source}
                  </Badge>
                </Td>
                <Td className="!text-right">${r.currentCost.toFixed(2)}</Td>
                <Td className={`!text-right font-bold ${r.lastDelta > 0 ? 'text-doodle-accent' : r.lastDelta < 0 ? 'text-doodle-green' : ''}`}>
                  {r.lastDelta === 0 ? '—' : `${r.lastDelta > 0 ? '+' : ''}$${r.lastDelta.toFixed(2)}`}
                </Td>
                <Td className="!text-right">{r.bomCount}</Td>
                <Td className={`!text-right font-bold ${r.exposure > 0 ? 'text-doodle-accent' : 'text-muted-foreground'}`}>
                  {r.exposure > 0 ? fmtMoney(r.exposure) : '—'}
                </Td>
                <Td className="!text-right">
                  <InspectButton
                    onClick={() => onInspect({ productId: r.cid, productName: r.name, kind: 'component', initialTab: 'cost' })}
                    label="Cost history & open WO impact"
                  />
                </Td>
              </tr>
            ))}
            {!loading && volatileRows.length === 0 && (
              <tr><Td className="text-muted-foreground" colSpan={7}>No volatile cost sources.</Td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card
        title="Single-Sourced In BOMs"
        subtitle="Components with only one active vendor — flagged when on-hand &lt; ROP"
        loading={loading}
      >
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <Th>Component</Th>
              <Th>Vendor</Th>
              <Th className="!text-right">Lead</Th>
              <Th className="!text-right">FG</Th>
              <Th className="!text-right">On-hand / ROP</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {singleSourcedRows.map(r => (
              <tr key={r.cid} className={`border-b border-doodle-text/5 hover:bg-secondary/30 ${r.belowROP ? 'bg-doodle-accent/5' : ''}`}>
                <Td><ALink to={`/define/products/${r.cid}`}>{r.name}</ALink></Td>
                <Td>
                  <Link to={`/supply/vendors/${r.vendorId}`} className="text-doodle-blue hover:underline">
                    {r.vendor}
                  </Link>
                </Td>
                <Td className="!text-right">{r.leadTime}d</Td>
                <Td className="!text-right font-bold">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help">{r.finishedGoods}</span>
                      </TooltipTrigger>
                      <TooltipContent className="font-doodle text-xs max-w-xs">
                        Finished goods that depend on this component (transitively).
                        Direct BOMs: {r.bomCount}.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Td>
                <Td className={`!text-right ${r.belowROP ? 'text-doodle-accent font-bold' : ''}`}>
                  {r.belowROP && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                  {r.onHand.toFixed(0)} / {r.reorderPoint > 0 ? r.reorderPoint : '—'}
                </Td>
                <Td className="!text-right">
                  <InspectButton
                    onClick={() => onInspect({ productId: r.cid, productName: r.name, kind: 'component', initialTab: 'vendors' })}
                    label="Vendors, BOM lines & cost history"
                  />
                </Td>
              </tr>
            ))}
            {!loading && singleSourcedRows.length === 0 && (
              <tr><Td className="text-muted-foreground" colSpan={6}>None.</Td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

// ── Section 3: Operational Connection ──────────────────────────────────
const OperationsSection: React.FC<{
  assemblies: AssemblyStats[];
  assemblyById: Map<number, AssemblyStats>;
  productMap: Map<number, Product>;
  bom: BillOfMaterials[];
  workOrders: Awaited<ReturnType<typeof fetchWorkOrders>> | undefined;
  activeOps: Awaited<ReturnType<typeof fetchActiveOperations>> | undefined;
  inventory: Awaited<ReturnType<typeof fetchProductInventory>> | undefined;
  routings: Awaited<ReturnType<typeof fetchWorkOrderRouting>> | undefined;
  openPOs: Awaited<ReturnType<typeof fetchOrders>> | undefined;
  loading: boolean;
  onInspect: (t: InspectTarget) => void;
}> = ({ assemblies, assemblyById, productMap, bom, workOrders, activeOps, inventory, routings, openPOs, loading, onInspect }) => {
  const [shortageDrill, setShortageDrill] = useState<ShortageContext | null>(null);
  type WOSortKey = 'name' | 'planned' | 'released' | 'completed30' | 'remaining' | 'earliestDue';
  const [woSort, setWoSort] = useState<{ key: WOSortKey; dir: 'asc' | 'desc' }>({ key: 'remaining', dir: 'desc' });
  const [woFilter, setWoFilter] = useState<'all' | 'planned' | 'released' | 'done30'>('all');
  const activeIds = useMemo(() => {
    const s = new Set<number>();
    activeOps?.forEach(op => s.add(op.workOrderId));
    return s;
  }, [activeOps]);

  // 3a. Open WOs by BOM Assembly
  const openWORows = useMemo(() => {
    if (!workOrders) return [];
    const byProduct = new Map<number, { planned: number; released: number; completed30: number; remaining: number; earliestDue: string | null }>();
    const cutoff = Date.now() - 30 * 86400_000;
    workOrders.forEach(wo => {
      if (!assemblyById.has(wo.ProductID)) return;
      const status = classifyWorkOrder(wo, activeIds);
      const slot = byProduct.get(wo.ProductID) || {
        planned: 0, released: 0, completed30: 0, remaining: 0, earliestDue: null,
      };
      if (status === 'Planned') {
        slot.planned += 1;
        slot.remaining += Math.max(0, wo.OrderQty - wo.StockedQty);
      } else if (status === 'Released') {
        slot.released += 1;
        slot.remaining += Math.max(0, wo.OrderQty - wo.StockedQty);
      } else if (status === 'Completed' && Date.parse(wo.ModifiedDate) >= cutoff) {
        slot.completed30 += 1;
      }
      if (status === 'Planned' || status === 'Released') {
        if (!slot.earliestDue || wo.DueDate < slot.earliestDue) slot.earliestDue = wo.DueDate;
      }
      byProduct.set(wo.ProductID, slot);
    });
    return Array.from(byProduct.entries())
      .map(([pid, v]) => ({
        assemblyId: pid,
        assemblyName: assemblyById.get(pid)?.assemblyName || `#${pid}`,
        ...v,
      }))
      .filter(r => r.planned + r.released + r.completed30 > 0);
  }, [workOrders, activeIds, assemblyById]);

  const filteredSortedWORows = useMemo(() => {
    const filtered = openWORows.filter(r => {
      if (woFilter === 'planned') return r.planned > 0;
      if (woFilter === 'released') return r.released > 0;
      if (woFilter === 'done30') return r.completed30 > 0;
      return r.planned + r.released > 0 || r.completed30 > 0;
    });
    const dir = woSort.dir === 'asc' ? 1 : -1;
    const cmp = (a: typeof filtered[number], b: typeof filtered[number]) => {
      switch (woSort.key) {
        case 'name': return a.assemblyName.localeCompare(b.assemblyName) * dir;
        case 'earliestDue': {
          const av = a.earliestDue ? Date.parse(a.earliestDue) : Number.POSITIVE_INFINITY;
          const bv = b.earliestDue ? Date.parse(b.earliestDue) : Number.POSITIVE_INFINITY;
          return (av - bv) * dir;
        }
        default: return ((a[woSort.key] as number) - (b[woSort.key] as number)) * dir;
      }
    };
    return [...filtered].sort(cmp).slice(0, TOP_N);
  }, [openWORows, woFilter, woSort]);


  // Aggregated incoming PO qty per component (pending or approved POs not yet delivered).
  const incomingByProduct = useMemo(() => {
    const m = new Map<number, number>();
    openPOs?.forEach(o => {
      if (o.status !== 'pending' && o.status !== 'approved') return;
      m.set(o.productId, (m.get(o.productId) || 0) + (o.qty || 0));
    });
    return m;
  }, [openPOs]);

  // 3b. Material Shortages affecting BOMs (effective stock = on-hand + incoming PO qty)
  const shortageRows = useMemo(() => {
    if (!workOrders || !inventory) return [];
    const onHand = new Map<number, number>();
    inventory.forEach(i => onHand.set(i.ProductID, (onHand.get(i.ProductID) || 0) + i.Quantity));

    const required = new Map<number, { qty: number; parents: Set<number> }>();
    workOrders.forEach(wo => {
      const status = classifyWorkOrder(wo, activeIds);
      if (status !== 'Planned' && status !== 'Released') return;
      const a = assemblyById.get(wo.ProductID);
      if (!a) return;
      const remainingAssy = Math.max(0, wo.OrderQty - wo.StockedQty);
      if (remainingAssy === 0) return;
      const explosion = flattenForExplosion(a.tree);
      explosion.forEach((perAssy, cid) => {
        const slot = required.get(cid) || { qty: 0, parents: new Set<number>() };
        slot.qty += perAssy * remainingAssy;
        slot.parents.add(wo.ProductID);
        required.set(cid, slot);
      });
    });

    const rows: Array<{
      cid: number; name: string; required: number; onHand: number; incoming: number; shortage: number; parents: number[];
    }> = [];
    required.forEach((v, cid) => {
      const oh = onHand.get(cid) || 0;
      const inc = incomingByProduct.get(cid) || 0;
      const shortage = v.qty - oh - inc;
      if (shortage <= 0) return;
      rows.push({
        cid,
        name: productMap.get(cid)?.Name || `#${cid}`,
        required: v.qty,
        onHand: oh,
        incoming: inc,
        shortage,
        parents: Array.from(v.parents),
      });
    });
    rows.sort((a, b) => b.shortage - a.shortage);
    return rows.slice(0, TOP_N);
  }, [workOrders, inventory, activeIds, assemblyById, productMap, incomingByProduct]);

  // 3c. Routing Coverage Check + UoM inconsistency
  const coverageRows = useMemo(() => {
    const productsWithRouting = new Set<number>();
    routings?.forEach(r => productsWithRouting.add(r.ProductID));
    const bomAssemblyIds = new Set(assemblies.map(a => a.assemblyId));

    const noRouting = assemblies.filter(a => !productsWithRouting.has(a.assemblyId));
    const orphanRouting: { pid: number; name: string }[] = [];
    productsWithRouting.forEach(pid => {
      if (!bomAssemblyIds.has(pid)) {
        orphanRouting.push({ pid, name: productMap.get(pid)?.Name || `#${pid}` });
      }
    });

    // UoM inconsistency: same component referenced in BOMs with multiple distinct UoMs.
    const uomByComponent = new Map<number, Set<string>>();
    bom.forEach(b => {
      if (!b.ProductAssemblyID || !b.UnitMeasureCode) return;
      const set = uomByComponent.get(b.ComponentID) || new Set<string>();
      set.add(b.UnitMeasureCode);
      uomByComponent.set(b.ComponentID, set);
    });
    const uomMismatches: { cid: number; name: string; uoms: string[] }[] = [];
    uomByComponent.forEach((uoms, cid) => {
      if (uoms.size <= 1) return;
      uomMismatches.push({
        cid,
        name: productMap.get(cid)?.Name || `#${cid}`,
        uoms: Array.from(uoms),
      });
    });
    uomMismatches.sort((a, b) => b.uoms.length - a.uoms.length);

    return {
      noRouting: noRouting.slice(0, TOP_N),
      orphanRouting: orphanRouting.slice(0, TOP_N),
      uomMismatches: uomMismatches.slice(0, TOP_N),
    };
  }, [routings, assemblies, productMap, bom]);

  // WIP summary: counts by state + total remaining qty across all open WOs
  const wipSummary = useMemo(() => {
    const s = { planned: 0, released: 0, completed30: 0, scrapped: 0, remaining: 0, dueSoon: 0 };
    if (!workOrders) return s;
    const cutoff = Date.now() - 30 * 86400_000;
    const dueSoonCutoff = Date.now() + 7 * 86400_000;
    workOrders.forEach(wo => {
      const status = classifyWorkOrder(wo, activeIds);
      if (status === 'Planned') {
        s.planned += 1;
        s.remaining += Math.max(0, wo.OrderQty - wo.StockedQty);
        if (wo.DueDate && Date.parse(wo.DueDate) <= dueSoonCutoff) s.dueSoon += 1;
      } else if (status === 'Released') {
        s.released += 1;
        s.remaining += Math.max(0, wo.OrderQty - wo.StockedQty);
        if (wo.DueDate && Date.parse(wo.DueDate) <= dueSoonCutoff) s.dueSoon += 1;
      } else if (status === 'Completed' && Date.parse(wo.ModifiedDate) >= cutoff) {
        s.completed30 += 1;
      } else if (status === 'Scrapped') {
        s.scrapped += 1;
      }
    });
    return s;
  }, [workOrders, activeIds]);

  return (
    <div className="space-y-4">
      <WIPSummaryStrip summary={wipSummary} loading={loading} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card title="Open Work Orders by Assembly" subtitle="Filter & sort by status, remaining qty, or due date" loading={loading}>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {([
            { id: 'all', label: 'All open' },
            { id: 'planned', label: 'Planned' },
            { id: 'released', label: 'Released' },
            { id: 'done30', label: 'Done 30d' },
          ] as const).map(f => (
            <button
              key={f.id}
              onClick={() => setWoFilter(f.id)}
              className={`font-doodle text-xs px-2 py-0.5 rounded border-2 border-dashed transition-colors ${
                woFilter === f.id
                  ? 'bg-doodle-accent/20 border-doodle-accent text-doodle-accent font-bold'
                  : 'border-doodle-text/20 text-muted-foreground hover:bg-secondary/40'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <SortableTh sortKey="name" align="left" current={woSort} onSort={setWoSort}>Assembly</SortableTh>
              <SortableTh sortKey="planned" align="right" current={woSort} onSort={setWoSort}>Plan</SortableTh>
              <SortableTh sortKey="released" align="right" current={woSort} onSort={setWoSort}>Rel</SortableTh>
              <SortableTh sortKey="completed30" align="right" current={woSort} onSort={setWoSort}>Done 30d</SortableTh>
              <SortableTh sortKey="remaining" align="right" current={woSort} onSort={setWoSort}>Rem</SortableTh>
              <SortableTh sortKey="earliestDue" align="right" current={woSort} onSort={setWoSort}>Due</SortableTh>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {filteredSortedWORows.map(r => (
              <tr key={r.assemblyId} className="border-b border-doodle-text/5 hover:bg-secondary/30">
                <Td><ALink to={`/engineer/bom/${r.assemblyId}`}>{r.assemblyName}</ALink></Td>
                <Td className="!text-right">{r.planned}</Td>
                <Td className="!text-right text-doodle-green font-bold">{r.released}</Td>
                <Td className="!text-right text-muted-foreground">{r.completed30}</Td>
                <Td className="!text-right font-bold">{r.remaining}</Td>
                <Td className="!text-right text-muted-foreground">{r.earliestDue ? fmtDate(r.earliestDue) : '—'}</Td>
                <Td className="!text-right">
                  <InspectButton
                    onClick={() => onInspect({ productId: r.assemblyId, productName: r.assemblyName, kind: 'assembly', initialTab: 'wos' })}
                    label="Open work orders for this assembly"
                  />
                </Td>
              </tr>
            ))}
            {!loading && filteredSortedWORows.length === 0 && (
              <tr><Td className="text-muted-foreground" colSpan={7}>No work orders match this filter.</Td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Material Shortages" subtitle="Required by open WOs vs on-hand + incoming POs" loading={loading}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-doodle-text/10">
              <Th>Component</Th>
              <Th className="!text-right">Need</Th>
              <Th className="!text-right">Have</Th>
              <Th className="!text-right">PO in</Th>
              <Th className="!text-right">Short</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {shortageRows.map(r => (
              <tr key={r.cid} className="border-b border-doodle-text/5 hover:bg-secondary/30 bg-doodle-accent/5">
                <Td>
                  <ALink to={`/define/products/${r.cid}`}>{r.name}</ALink>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="ml-1 text-[10px] text-muted-foreground cursor-help">
                          ({r.parents.length})
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="font-doodle text-xs max-w-xs">
                        <div className="font-bold mb-1">Affects:</div>
                        <ul className="space-y-0.5">
                          {r.parents.slice(0, 6).map(pid => (
                            <li key={pid}>• {assemblyById.get(pid)?.assemblyName || `#${pid}`}</li>
                          ))}
                          {r.parents.length > 6 && (
                            <li className="text-muted-foreground">…and {r.parents.length - 6} more</li>
                          )}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Td>
                <Td className="!text-right">{r.required.toFixed(0)}</Td>
                <Td className="!text-right">{r.onHand.toFixed(0)}</Td>
                <Td className={`!text-right ${r.incoming > 0 ? 'text-doodle-green' : 'text-muted-foreground'}`}>
                  {r.incoming > 0 ? `+${r.incoming.toFixed(0)}` : '—'}
                </Td>
                <Td className="!text-right font-bold text-doodle-accent">
                  <AlertTriangle className="inline w-3 h-3 mr-1" />
                  {r.shortage.toFixed(0)}
                </Td>
                <Td className="!text-right">
                  <div className="inline-flex items-center gap-1">
                    <InspectButton
                      onClick={() => setShortageDrill(r)}
                      label="Show shortage breakdown"
                    />
                    <InspectButton
                      onClick={() => onInspect({ productId: r.cid, productName: r.name, kind: 'component', initialTab: 'vendors' })}
                      label="Vendors & cost history"
                    />
                  </div>
                </Td>
              </tr>
            ))}
            {!loading && shortageRows.length === 0 && (
              <tr><Td className="text-muted-foreground" colSpan={6}>No material shortages detected.</Td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Routing Coverage" subtitle="Data-quality checks across BOM and routing" loading={loading}>
        <RoutingCoverageTabs coverage={coverageRows} />
      </Card>
      </div>
      <ShortageDrillDownDialog
        open={!!shortageDrill}
        onOpenChange={(o) => !o && setShortageDrill(null)}
        shortage={shortageDrill}
        workOrders={workOrders}
        activeIds={activeIds}
        inventory={inventory}
        assemblyById={assemblyById}
      />
    </div>
  );
};

const RoutingCoverageTabs: React.FC<{
  coverage: {
    noRouting: AssemblyStats[];
    orphanRouting: { pid: number; name: string }[];
    uomMismatches: { cid: number; name: string; uoms: string[] }[];
  };
}> = ({ coverage }) => {
  type Tab = 'noRouting' | 'orphan' | 'uom';
  const [tab, setTab] = useState<Tab>('noRouting');
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'noRouting', label: 'BOM · no routing', count: coverage.noRouting.length },
    { key: 'orphan', label: 'Routing · no BOM', count: coverage.orphanRouting.length },
    { key: 'uom', label: 'UoM mismatch', count: coverage.uomMismatches.length },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-2 py-1 rounded font-doodle text-[11px] border-2 border-dashed transition-colors ${
              tab === t.key
                ? 'border-doodle-accent/50 bg-doodle-accent/10 text-doodle-accent font-bold'
                : 'border-transparent text-muted-foreground hover:bg-secondary/50'
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>
      <table className="w-full">
        <tbody>
          {tab === 'noRouting' && (
            coverage.noRouting.length === 0 ? (
              <tr><Td className="text-muted-foreground">All BOM assemblies have routing.</Td></tr>
            ) : (
              coverage.noRouting.map(r => (
                <tr key={r.assemblyId} className="border-b border-doodle-text/5">
                  <Td><ALink to={`/engineer/routing/${r.assemblyId}`}>{r.assemblyName}</ALink></Td>
                  <Td className="!text-right text-muted-foreground">{r.depth} lvl · {r.nodeCount} nodes</Td>
                </tr>
              ))
            )
          )}
          {tab === 'orphan' && (
            coverage.orphanRouting.length === 0 ? (
              <tr><Td className="text-muted-foreground">None.</Td></tr>
            ) : (
              coverage.orphanRouting.map(r => (
                <tr key={r.pid} className="border-b border-doodle-text/5">
                  <Td><ALink to={`/engineer/routing/${r.pid}`}>{r.name}</ALink></Td>
                </tr>
              ))
            )
          )}
          {tab === 'uom' && (
            coverage.uomMismatches.length === 0 ? (
              <tr><Td className="text-muted-foreground">All BOM lines use consistent units.</Td></tr>
            ) : (
              coverage.uomMismatches.map(r => (
                <tr key={r.cid} className="border-b border-doodle-text/5">
                  <Td><ALink to={`/define/products/${r.cid}`}>{r.name}</ALink></Td>
                  <Td className="!text-right">
                    {r.uoms.map(u => (
                      <Badge key={u} variant="outline" className="ml-1 text-[10px] px-1 py-0">{u}</Badge>
                    ))}
                  </Td>
                </tr>
              ))
            )
          )}
        </tbody>
      </table>
    </div>
  );
};

export default BOMOverviewInsights;
