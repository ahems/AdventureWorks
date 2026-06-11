import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchActiveBOM,
  fetchAllProducts,
  fetchWorkOrdersByProduct,
  fetchProductCostHistory,
  fetchActiveOperations,
} from '@/services/api';
import { fetchCatalog } from '@/services/supplyChainApi';
import type { BillOfMaterials, Product, WorkOrder } from '@/types/production';
import { classifyWorkOrder, fmtMoney, fmtDate } from './utils';

export type DrillKind = 'component' | 'assembly';
type Tab = 'bom' | 'wos' | 'cost' | 'vendors';

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  productId: number;
  productName: string;
  kind: DrillKind;
  /** Initial tab; defaults to first relevant tab for the kind. */
  initialTab?: Tab;
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'bom', label: 'BOM lines' },
  { key: 'wos', label: 'Work orders' },
  { key: 'cost', label: 'Cost history' },
  { key: 'vendors', label: 'Vendors' },
];

const RowDrillDownDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  productId,
  productName,
  kind,
  initialTab,
}) => {
  const [tab, setTab] = useState<Tab>(initialTab ?? (kind === 'assembly' ? 'wos' : 'bom'));

  // Always-cached project data
  const { data: bom } = useQuery({ queryKey: ['active-bom'], queryFn: fetchActiveBOM, enabled: open });
  const { data: products } = useQuery({ queryKey: ['all-products'], queryFn: fetchAllProducts, enabled: open });

  // Targeted queries (only fire when the dialog is open)
  const { data: wos, isLoading: wosLoading } = useQuery({
    queryKey: ['wos-for-product', productId],
    queryFn: () => fetchWorkOrdersByProduct(productId),
    enabled: open,
    staleTime: 30_000,
  });
  const { data: activeOps } = useQuery({
    queryKey: ['active-operations'],
    queryFn: fetchActiveOperations,
    enabled: open && tab === 'wos',
    staleTime: 30_000,
  });
  const { data: history, isLoading: histLoading } = useQuery({
    queryKey: ['product-cost-history', productId],
    queryFn: () => fetchProductCostHistory(productId),
    enabled: open && tab === 'cost',
    staleTime: 60_000,
  });
  const { data: catalog, isLoading: catLoading } = useQuery({
    queryKey: ['supply-catalog-product', productId],
    queryFn: () => fetchCatalog(productId),
    enabled: open && tab === 'vendors',
    staleTime: 60_000,
  });

  const productMap = useMemo(() => {
    const m = new Map<number, Product>();
    products?.forEach(p => m.set(p.ProductID, p));
    return m;
  }, [products]);

  const activeIds = useMemo(() => {
    const s = new Set<number>();
    activeOps?.forEach(op => s.add(op.workOrderId));
    return s;
  }, [activeOps]);

  // BOM lines for this row: parents (where component) or children (where assembly)
  const bomLines = useMemo<BillOfMaterials[]>(() => {
    if (!bom) return [];
    return kind === 'component'
      ? bom.filter(b => b.ComponentID === productId)
      : bom.filter(b => b.ProductAssemblyID === productId);
  }, [bom, kind, productId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="doodle-dialog max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-doodle text-lg font-bold text-doodle-text">
            {productName}
            <span className="ml-2 font-doodle text-xs text-muted-foreground font-normal">
              · {kind === 'assembly' ? 'Assembly' : 'Component'} #{productId}
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* Tab strip */}
        <div className="flex flex-wrap gap-1.5 border-b-2 border-dashed border-doodle-text/15 pb-2">
          {TABS.map(t => {
            const count =
              t.key === 'bom' ? bomLines.length :
              t.key === 'wos' ? (wos?.length ?? 0) :
              t.key === 'cost' ? (history?.length ?? 0) :
              (catalog?.length ?? 0);
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-2.5 py-1 rounded font-doodle text-xs border-2 border-dashed transition-colors ${
                  active
                    ? 'border-doodle-accent/50 bg-doodle-accent/10 text-doodle-accent font-bold'
                    : 'border-transparent text-muted-foreground hover:bg-secondary/50'
                }`}
              >
                {t.label}
                <span className="ml-1 opacity-70">({count || '—'})</span>
              </button>
            );
          })}
        </div>

        <div className="overflow-auto flex-1 -mx-1 px-1">
          {tab === 'bom' && (
            <BomLinesTable
              lines={bomLines}
              kind={kind}
              productMap={productMap}
            />
          )}
          {tab === 'wos' && (
            wosLoading ? <Loader /> :
              kind === 'assembly'
                ? <WorkOrdersTable wos={wos || []} activeIds={activeIds} />
                : <ComponentDemandTable
                    componentId={productId}
                    bom={bom || []}
                    productMap={productMap}
                  />
          )}
          {tab === 'cost' && (
            histLoading ? <Loader /> : <CostHistoryTable history={history || []} />
          )}
          {tab === 'vendors' && (
            catLoading ? <Loader /> : <VendorsTable catalog={catalog || []} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

const Loader = () => (
  <div className="space-y-2 p-2">
    <Skeleton className="h-6 w-full" />
    <Skeleton className="h-6 w-full" />
    <Skeleton className="h-6 w-full" />
  </div>
);

const Th: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <th className={`py-1.5 px-2 text-left font-doodle text-[11px] text-muted-foreground font-normal ${className}`}>{children}</th>
);
const Td: React.FC<{ children?: React.ReactNode; className?: string; colSpan?: number }> = ({ children, className = '', colSpan }) => (
  <td colSpan={colSpan} className={`py-1.5 px-2 font-doodle text-xs text-doodle-text ${className}`}>{children}</td>
);
const EmptyRow = ({ children, cols }: { children: React.ReactNode; cols: number }) => (
  <tr><Td colSpan={cols} className="text-muted-foreground italic">{children}</Td></tr>
);

// ── Tab content ────────────────────────────────────────────────────────────
const BomLinesTable: React.FC<{
  lines: BillOfMaterials[];
  kind: DrillKind;
  productMap: Map<number, Product>;
}> = ({ lines, kind, productMap }) => (
  <table className="w-full">
    <thead>
      <tr className="border-b border-doodle-text/10">
        <Th>{kind === 'component' ? 'Used in assembly' : 'Component'}</Th>
        <Th className="!text-right">Per assy</Th>
        <Th className="!text-right">UoM</Th>
        <Th className="!text-right">Level</Th>
        <Th className="!text-right">Last modified</Th>
      </tr>
    </thead>
    <tbody>
      {lines.length === 0 && <EmptyRow cols={5}>No BOM lines.</EmptyRow>}
      {lines.map(l => {
        const otherId = kind === 'component' ? l.ProductAssemblyID! : l.ComponentID;
        const otherName = productMap.get(otherId)?.Name || `#${otherId}`;
        const linkTo = kind === 'component' ? `/engineer/bom/${otherId}` : `/define/products/${otherId}`;
        return (
          <tr key={l.BillOfMaterialsID} className="border-b border-doodle-text/5 hover:bg-secondary/30">
            <Td>
              <Link to={linkTo} className="text-doodle-blue hover:underline font-bold">{otherName}</Link>
            </Td>
            <Td className="!text-right">{l.PerAssemblyQty}</Td>
            <Td className="!text-right text-muted-foreground">{l.UnitMeasureCode}</Td>
            <Td className="!text-right">{l.BOMLevel}</Td>
            <Td className="!text-right text-muted-foreground">{fmtDate(l.ModifiedDate)}</Td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

const WorkOrdersTable: React.FC<{ wos: WorkOrder[]; activeIds: Set<number> }> = ({ wos, activeIds }) => {
  const sorted = useMemo(() => {
    return [...wos].sort((a, b) => (a.DueDate < b.DueDate ? -1 : 1));
  }, [wos]);
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-doodle-text/10">
          <Th>WO #</Th>
          <Th>Status</Th>
          <Th className="!text-right">Order</Th>
          <Th className="!text-right">Stocked</Th>
          <Th className="!text-right">Remaining</Th>
          <Th className="!text-right">Due</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 && <EmptyRow cols={6}>No work orders for this assembly.</EmptyRow>}
        {sorted.map(wo => {
          const status = classifyWorkOrder(wo, activeIds);
          const remaining = Math.max(0, wo.OrderQty - wo.StockedQty);
          const tone =
            status === 'Released' ? 'bg-doodle-green/10 text-doodle-green' :
            status === 'Planned' ? 'bg-doodle-blue/10 text-doodle-blue' :
            status === 'Completed' ? 'bg-muted text-muted-foreground' :
            'bg-doodle-accent/10 text-doodle-accent';
          return (
            <tr key={wo.WorkOrderID} className="border-b border-doodle-text/5 hover:bg-secondary/30">
              <Td>
                <Link to={`/plan/work-orders/${wo.WorkOrderID}`} className="text-doodle-blue hover:underline font-bold">
                  #{wo.WorkOrderID}
                </Link>
              </Td>
              <Td>
                <Badge variant="outline" className={`text-[10px] px-1 py-0 ${tone}`}>{status}</Badge>
              </Td>
              <Td className="!text-right">{wo.OrderQty}</Td>
              <Td className="!text-right">{wo.StockedQty}</Td>
              <Td className="!text-right font-bold">{remaining}</Td>
              <Td className="!text-right text-muted-foreground">{fmtDate(wo.DueDate)}</Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

// For a component row, show which finished assemblies depend on it via direct BOM parents.
const ComponentDemandTable: React.FC<{
  componentId: number;
  bom: BillOfMaterials[];
  productMap: Map<number, Product>;
}> = ({ componentId, bom, productMap }) => {
  const parents = useMemo(() => {
    const seen = new Map<number, { qty: number }>();
    bom.forEach(b => {
      if (b.ComponentID !== componentId || !b.ProductAssemblyID) return;
      const slot = seen.get(b.ProductAssemblyID) || { qty: 0 };
      slot.qty += b.PerAssemblyQty;
      seen.set(b.ProductAssemblyID, slot);
    });
    return Array.from(seen.entries()).map(([pid, v]) => ({
      pid,
      name: productMap.get(pid)?.Name || `#${pid}`,
      qty: v.qty,
    }));
  }, [componentId, bom, productMap]);
  return (
    <div className="space-y-2">
      <p className="font-doodle text-xs text-muted-foreground px-1">
        Open this dialog from an assembly row to see its work orders directly. For a component, the parent assemblies that
        consume it are listed below — open one to drill into its work orders.
      </p>
      <table className="w-full">
        <thead>
          <tr className="border-b border-doodle-text/10">
            <Th>Parent assembly</Th>
            <Th className="!text-right">Per assy</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody>
          {parents.length === 0 && <EmptyRow cols={3}>Not used in any active BOM.</EmptyRow>}
          {parents.map(p => (
            <tr key={p.pid} className="border-b border-doodle-text/5 hover:bg-secondary/30">
              <Td>{p.name}</Td>
              <Td className="!text-right">{p.qty}</Td>
              <Td className="!text-right">
                <Link to={`/engineer/bom/${p.pid}`} className="text-doodle-blue hover:underline">Open BOM →</Link>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const CostHistoryTable: React.FC<{ history: { ProductID: number; StartDate: string; EndDate: string | null; StandardCost: number }[] }> = ({ history }) => {
  const sorted = useMemo(() =>
    [...history].sort((a, b) => (a.StartDate < b.StartDate ? 1 : -1)),
    [history]);
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-doodle-text/10">
          <Th>Effective from</Th>
          <Th>Until</Th>
          <Th className="!text-right">Standard cost</Th>
          <Th className="!text-right">Δ vs prior</Th>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 && <EmptyRow cols={4}>No cost history records.</EmptyRow>}
        {sorted.map((h, i) => {
          const prior = sorted[i + 1];
          const delta = prior ? h.StandardCost - prior.StandardCost : 0;
          return (
            <tr key={`${h.StartDate}-${i}`} className="border-b border-doodle-text/5">
              <Td>{fmtDate(h.StartDate)}</Td>
              <Td className="text-muted-foreground">{h.EndDate ? fmtDate(h.EndDate) : 'current'}</Td>
              <Td className="!text-right font-bold">${h.StandardCost.toFixed(2)}</Td>
              <Td className={`!text-right font-bold ${delta > 0 ? 'text-doodle-accent' : delta < 0 ? 'text-doodle-green' : 'text-muted-foreground'}`}>
                {prior ? `${delta > 0 ? '+' : ''}$${delta.toFixed(2)}` : '—'}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

const VendorsTable: React.FC<{ catalog: Awaited<ReturnType<typeof fetchCatalog>> }> = ({ catalog }) => (
  <table className="w-full">
    <thead>
      <tr className="border-b border-doodle-text/10">
        <Th>Vendor</Th>
        <Th className="!text-right">Unit $</Th>
        <Th className="!text-right">Stock</Th>
        <Th className="!text-right">Lead</Th>
        <Th className="!text-right">Min / Max</Th>
        <Th></Th>
      </tr>
    </thead>
    <tbody>
      {catalog.length === 0 && <EmptyRow cols={6}>No vendor quotes for this product.</EmptyRow>}
      {catalog.map(q => (
        <tr key={`${q.vendorId}-${q.productId}`} className="border-b border-doodle-text/5 hover:bg-secondary/30">
          <Td>
            <Link to={`/supply/vendors/${q.vendorId}`} className="text-doodle-blue hover:underline font-bold">
              {q.vendorName}
            </Link>
          </Td>
          <Td className="!text-right">{fmtMoney(q.unitCost)}</Td>
          <Td className={`!text-right ${q.stockAvailable === 0 ? 'text-doodle-accent font-bold' : ''}`}>{q.stockAvailable}</Td>
          <Td className="!text-right">{q.leadTimeDays}d</Td>
          <Td className="!text-right text-muted-foreground">{q.minOrderQty} / {q.maxOrderQty}</Td>
          <Td className="!text-right">
            <Link to={`/supply?product=${q.productId}`} className="text-doodle-blue hover:underline">Order →</Link>
          </Td>
        </tr>
      ))}
    </tbody>
  </table>
);

export default RowDrillDownDialog;
