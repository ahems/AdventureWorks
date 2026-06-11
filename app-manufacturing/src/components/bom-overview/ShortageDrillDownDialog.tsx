import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { fetchLocations } from '@/services/api';
import { fetchOrders } from '@/services/supplyChainApi';
import {
  classifyWorkOrder,
  findComponentPaths,
  fmtDate,
  type AssemblyStats,
} from './utils';
import type { ProductInventory, WorkOrder } from '@/types/production';

export interface ShortageContext {
  cid: number;
  name: string;
  required: number;
  onHand: number;
  incoming: number;
  shortage: number;
  parents: number[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortage: ShortageContext | null;
  workOrders: WorkOrder[] | undefined;
  activeIds: Set<number>;
  inventory: ProductInventory[] | undefined;
  assemblyById: Map<number, AssemblyStats>;
}

const fmtQty = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(2));

const ShortageDrillDownDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  shortage,
  workOrders,
  activeIds,
  inventory,
  assemblyById,
}) => {
  // Lazy fetches: only when dialog is open
  const { data: locations } = useQuery({
    queryKey: ['locations'],
    queryFn: fetchLocations,
    enabled: open,
    staleTime: 300_000,
  });
  const { data: openPOs } = useQuery({
    queryKey: ['open-purchase-orders'],
    queryFn: fetchOrders,
    enabled: open,
    staleTime: 60_000,
  });

  const locName = useMemo(() => {
    const m = new Map<number, string>();
    locations?.forEach(l => m.set(l.LocationID, l.Name));
    return m;
  }, [locations]);

  // On-hand breakdown by location
  const onHandRows = useMemo(() => {
    if (!shortage || !inventory) return [];
    return inventory
      .filter(i => i.ProductID === shortage.cid && i.Quantity > 0)
      .map(i => ({
        locationId: i.LocationID,
        locationName: locName.get(i.LocationID) || `#${i.LocationID}`,
        shelf: i.Shelf,
        bin: i.Bin,
        qty: i.Quantity,
      }))
      .sort((a, b) => b.qty - a.qty);
  }, [shortage, inventory, locName]);

  // Open POs delivering this component
  const incomingRows = useMemo(() => {
    if (!shortage || !openPOs) return [];
    return openPOs
      .filter(o =>
        o.productId === shortage.cid &&
        (o.status === 'pending' || o.status === 'approved'),
      )
      .map(o => ({
        id: o.orderId,
        status: o.status,
        qty: o.qty || 0,
        vendor: o.vendorName || '—',
        eta: o.estimatedDeliveryUtc,
      }))
      .sort((a, b) => b.qty - a.qty);
  }, [shortage, openPOs]);

  // WO contributions: each open WO whose assembly tree contains this component, expanded
  // by every distinct BOM path so callers can see the exact lines.
  const contributionRows = useMemo(() => {
    if (!shortage || !workOrders) return [];
    type Row = {
      key: string;
      woId: number;
      assemblyId: number;
      assemblyName: string;
      orderQty: number;
      remainingAssy: number;
      dueDate: string;
      status: 'Planned' | 'Released';
      pathLabel: string;
      perAssyEffective: number;
      contribution: number;
    };
    const rows: Row[] = [];
    workOrders.forEach(wo => {
      const status = classifyWorkOrder(wo, activeIds);
      if (status !== 'Planned' && status !== 'Released') return;
      const a = assemblyById.get(wo.ProductID);
      if (!a) return;
      const remainingAssy = Math.max(0, wo.OrderQty - wo.StockedQty);
      if (remainingAssy === 0) return;
      const paths = findComponentPaths(a.tree, shortage.cid);
      if (paths.length === 0) return;
      paths.forEach((p, idx) => {
        const pathLabel = [a.assemblyName, ...p.steps.map(s => s.componentName)].join(' › ');
        const contribution = p.effectivePerAssy * remainingAssy;
        rows.push({
          key: `${wo.WorkOrderID}-${idx}`,
          woId: wo.WorkOrderID,
          assemblyId: wo.ProductID,
          assemblyName: a.assemblyName,
          orderQty: wo.OrderQty,
          remainingAssy,
          dueDate: wo.DueDate,
          status,
          pathLabel,
          perAssyEffective: p.effectivePerAssy,
          contribution,
        });
      });
    });
    return rows.sort((a, b) => b.contribution - a.contribution);
  }, [shortage, workOrders, activeIds, assemblyById]);

  const totalIncoming = incomingRows.reduce((s, r) => s + r.qty, 0);
  const totalOnHand = onHandRows.reduce((s, r) => s + r.qty, 0);
  const totalContrib = contributionRows.reduce((s, r) => s + r.contribution, 0);
  const effectiveStock = totalOnHand + totalIncoming;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="doodle-dialog max-w-4xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-doodle text-doodle-text flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-doodle-accent" />
            Shortage detail · {shortage?.name || ''}
          </DialogTitle>
        </DialogHeader>

        {!shortage ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : (
          <div className="overflow-y-auto pr-1 space-y-5">
            {/* Effective stock formula strip */}
            <section className="doodle-card-static p-3">
              <div className="font-doodle text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Effective stock calculation
              </div>
              <div className="flex flex-wrap items-center gap-2 font-doodle text-sm text-doodle-text">
                <Stat label="On-hand" value={fmtQty(totalOnHand)} />
                <Plus />
                <Stat label="Incoming POs" value={fmtQty(totalIncoming)} tone="green" />
                <Equals />
                <Stat label="Effective stock" value={fmtQty(effectiveStock)} bold />
                <Minus />
                <Stat label="Required" value={fmtQty(shortage.required)} />
                <Equals />
                <Stat
                  label="Shortage"
                  value={fmtQty(shortage.shortage)}
                  tone="accent"
                  bold
                />
              </div>
              {Math.abs(totalContrib - shortage.required) > 0.5 && (
                <p className="font-doodle text-[11px] text-muted-foreground mt-2">
                  Note: line contributions sum to {fmtQty(totalContrib)} (vs {fmtQty(shortage.required)} aggregated).
                  Differences come from WOs filtered after rollup.
                </p>
              )}
            </section>

            {/* On-hand by location */}
            <section>
              <SectionHeader title="On-hand by location" count={onHandRows.length} total={totalOnHand} />
              {onHandRows.length === 0 ? (
                <Empty>No inventory rows for this component.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-doodle-text/10">
                      <Th>Location</Th>
                      <Th>Shelf / Bin</Th>
                      <Th className="!text-right">Qty</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {onHandRows.map(r => (
                      <tr key={r.locationId} className="border-b border-doodle-text/5">
                        <Td>{r.locationName}</Td>
                        <Td className="text-muted-foreground">
                          {r.shelf || '—'} / {r.bin ?? '—'}
                        </Td>
                        <Td className="!text-right font-bold">{fmtQty(r.qty)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* Incoming POs */}
            <section>
              <SectionHeader title="Incoming purchase orders" count={incomingRows.length} total={totalIncoming} />
              {incomingRows.length === 0 ? (
                <Empty>No pending or approved POs cover this shortage.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-doodle-text/10">
                      <Th>PO</Th>
                      <Th>Vendor</Th>
                      <Th>Status</Th>
                      <Th>ETA</Th>
                      <Th className="!text-right">Qty</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {incomingRows.map(r => (
                      <tr key={r.id} className="border-b border-doodle-text/5">
                        <Td>
                          <Link
                            to={`/supply/orders/${r.id}`}
                            className="text-doodle-blue hover:underline font-bold"
                          >
                            #{r.id}
                          </Link>
                        </Td>
                        <Td>{r.vendor}</Td>
                        <Td>
                          <Badge variant="outline" className="font-doodle text-[10px]">
                            {r.status}
                          </Badge>
                        </Td>
                        <Td className="text-muted-foreground">{r.eta ? fmtDate(r.eta) : '—'}</Td>
                        <Td className="!text-right font-bold text-doodle-green">+{fmtQty(r.qty)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {/* BOM path contributions */}
            <section>
              <SectionHeader
                title="BOM path contributions to demand"
                count={contributionRows.length}
                total={totalContrib}
                totalLabel="qty"
              />
              {contributionRows.length === 0 ? (
                <Empty>No open work orders consume this component.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-doodle-text/10">
                      <Th>WO</Th>
                      <Th>Assembly · BOM path</Th>
                      <Th>Status</Th>
                      <Th>Due</Th>
                      <Th className="!text-right" title="Effective per-assembly qty (rolled-up)">
                        per/Assy
                      </Th>
                      <Th className="!text-right">Remain assy</Th>
                      <Th className="!text-right">Contribution</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {contributionRows.map(r => (
                      <tr key={r.key} className="border-b border-doodle-text/5 hover:bg-secondary/30">
                        <Td>
                          <Link
                            to={`/plan?wo=${r.woId}`}
                            className="text-doodle-blue hover:underline font-bold"
                          >
                            #{r.woId}
                          </Link>
                        </Td>
                        <Td>
                          <PathBreadcrumb label={r.pathLabel} />
                        </Td>
                        <Td>
                          <Badge
                            variant="outline"
                            className={`font-doodle text-[10px] ${
                              r.status === 'Released' ? 'text-doodle-accent' : ''
                            }`}
                          >
                            {r.status}
                          </Badge>
                        </Td>
                        <Td className="text-muted-foreground">{r.dueDate ? fmtDate(r.dueDate) : '—'}</Td>
                        <Td className="!text-right">{fmtQty(r.perAssyEffective)}</Td>
                        <Td className="!text-right">{fmtQty(r.remainingAssy)}</Td>
                        <Td className="!text-right font-bold">{fmtQty(r.contribution)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

// ── Local UI bits ────────────────────────────────────────────────────────

const Th: React.FC<{ className?: string; children?: React.ReactNode; title?: string }> = ({
  className = '',
  children,
  title,
}) => (
  <th
    title={title}
    className={`py-1.5 px-2 text-left font-doodle text-[11px] text-muted-foreground font-normal ${className}`}
  >
    {children}
  </th>
);

const Td: React.FC<{ className?: string; children?: React.ReactNode }> = ({
  className = '',
  children,
}) => (
  <td className={`py-1.5 px-2 font-doodle text-xs text-doodle-text ${className}`}>
    {children}
  </td>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="font-doodle text-xs text-muted-foreground italic px-2 py-3">{children}</div>
);

const SectionHeader: React.FC<{
  title: string;
  count: number;
  total: number;
  totalLabel?: string;
}> = ({ title, count, total, totalLabel = 'qty' }) => (
  <div className="flex items-baseline justify-between mb-1.5 pb-1 border-b-2 border-dashed border-doodle-text/10">
    <h4 className="font-doodle text-sm font-bold text-doodle-text">{title}</h4>
    <span className="font-doodle text-[11px] text-muted-foreground">
      {count} {count === 1 ? 'row' : 'rows'} · {fmtQty(total)} {totalLabel}
    </span>
  </div>
);

const Stat: React.FC<{
  label: string;
  value: string;
  tone?: 'default' | 'accent' | 'green';
  bold?: boolean;
}> = ({ label, value, tone = 'default', bold }) => {
  const cls =
    tone === 'accent' ? 'text-doodle-accent'
      : tone === 'green' ? 'text-doodle-green'
        : 'text-doodle-text';
  return (
    <div className="flex flex-col px-2">
      <span className="font-doodle text-[10px] uppercase text-muted-foreground tracking-wide">
        {label}
      </span>
      <span className={`font-doodle ${bold ? 'text-base font-bold' : 'text-sm'} ${cls}`}>
        {value}
      </span>
    </div>
  );
};

const Plus: React.FC = () => <span className="font-doodle text-base text-muted-foreground">+</span>;
const Minus: React.FC = () => <span className="font-doodle text-base text-muted-foreground">−</span>;
const Equals: React.FC = () => <span className="font-doodle text-base text-muted-foreground">=</span>;

const PathBreadcrumb: React.FC<{ label: string }> = ({ label }) => {
  const parts = label.split(' › ');
  return (
    <span className="inline-flex items-center flex-wrap gap-0.5">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center">
          <span
            className={
              i === 0
                ? 'font-bold text-doodle-text'
                : i === parts.length - 1
                  ? 'text-doodle-accent font-bold'
                  : 'text-muted-foreground'
            }
          >
            {p}
          </span>
          {i < parts.length - 1 && (
            <ChevronRight className="w-3 h-3 mx-0.5 text-muted-foreground/60" />
          )}
        </span>
      ))}
    </span>
  );
};

// Stub to keep tree-shaking neutral if ArrowRight needed elsewhere

export default ShortageDrillDownDialog;
