import React, { useState, useMemo, useEffect } from "react";
import { Navigate, Link } from "react-router-dom";
import {
  Store,
  ShoppingBag,
  TrendingUp,
  MapPin,
  User,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Plus,
  Loader2,
  BarChart3,
  Trophy,
  ArrowUpRight,
  Globe,
  RefreshCw,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  useStores,
  useStoreOrders,
  useStoreTerritories,
  useOrderLines,
} from "@/hooks/useAdminStores";
import { StoreListItem, TerritoryStoreSummary, StoreOrderLineItem } from "@/types/store";
import PlaceStoreOrderDialog from "@/components/PlaceStoreOrderDialog";

// ── Country flags ─────────────────────────────────────────────────────────────
const FLAGS: Record<string, string> = {
  US: "🇺🇸",
  CA: "🇨🇦",
  FR: "🇫🇷",
  DE: "🇩🇪",
  AU: "🇦🇺",
  GB: "🇬🇧",
};

// ── Order status ──────────────────────────────────────────────────────────────
const ORDER_STATUS: Record<number, { label: string; color: string; bg: string }> = {
  1: { label: "In Process",  color: "text-blue-700",   bg: "bg-blue-50"   },
  2: { label: "Approved",    color: "text-green-700",  bg: "bg-green-50"  },
  3: { label: "Backordered", color: "text-orange-700", bg: "bg-orange-50" },
  4: { label: "Rejected",    color: "text-red-700",    bg: "bg-red-50"    },
  5: { label: "Shipped",     color: "text-purple-700", bg: "bg-purple-50" },
  6: { label: "Cancelled",   color: "text-gray-600",   bg: "bg-gray-100"  },
};

// ── Store tier ────────────────────────────────────────────────────────────────
type Tier = "platinum" | "gold" | "silver" | "bronze" | "none";

function getStoreTier(revenue: number): Tier {
  if (revenue >= 500_000) return "platinum";
  if (revenue >= 100_000) return "gold";
  if (revenue >= 20_000)  return "silver";
  if (revenue > 0)        return "bronze";
  return "none";
}

const TIER: Record<Tier, { icon: string; label: string; color: string; bg: string; border: string }> = {
  platinum: { icon: "🏆", label: "Platinum", color: "text-amber-700",  bg: "bg-amber-50",  border: "border-amber-300"  },
  gold:     { icon: "⭐", label: "Gold",     color: "text-yellow-700", bg: "bg-yellow-50", border: "border-yellow-300" },
  silver:   { icon: "🥈", label: "Silver",   color: "text-slate-600",  bg: "bg-slate-50",  border: "border-slate-300"  },
  bronze:   { icon: "🥉", label: "Bronze",   color: "text-orange-700", bg: "bg-orange-50", border: "border-orange-300" },
  none:     { icon: "",   label: "No orders",color: "text-gray-400",   bg: "bg-gray-50",   border: "border-gray-200"   },
};

const MEDALS = ["🥇", "🥈", "🥉"];

function fmtRevenue(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ── Order history panel ───────────────────────────────────────────────────────
const StoreOrderHistory: React.FC<{
  storeId: number;
  storeName: string;
  orderCount: number;
  store: StoreListItem;
}> = ({ storeId, storeName, orderCount, store }) => {
  const { data: orders = [], isLoading, isError } = useStoreOrders(storeId);
  const [reorderSalesOrderId, setReorderSalesOrderId] = useState<number | null>(null);
  const [reorderItems, setReorderItems] = useState<StoreOrderLineItem[] | null>(null);

  const { data: orderLines } = useOrderLines(reorderSalesOrderId);

  useEffect(() => {
    if (orderLines && orderLines.length > 0 && reorderSalesOrderId) {
      const items: StoreOrderLineItem[] = orderLines.map((l) => ({
        productId: l.productID,
        productName: l.productName,
        productNumber: l.productNumber,
        unitPrice: l.unitPrice,
        quantity: l.orderQty,
        discountPct: l.unitPriceDiscount,
        lineTotal: Math.round(l.unitPrice * (1 - l.unitPriceDiscount) * l.orderQty * 100) / 100,
      }));
      setReorderItems(items);
      setReorderSalesOrderId(null);
    }
  }, [orderLines, reorderSalesOrderId]);

  if (isLoading) return (
    <div className="flex items-center gap-2 py-5 font-doodle text-doodle-text/60 text-sm">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading orders…
    </div>
  );

  if (isError) return (
    <div className="py-5 font-doodle text-red-600 text-sm text-center">Failed to load orders. Please try again.</div>
  );

  if (orders.length === 0) return (
    <div className="py-5 font-doodle text-doodle-text/50 text-sm text-center">
      {orderCount > 0
        ? `Could not load the ${orderCount} order(s) for ${storeName} — try refreshing.`
        : `No orders on record for ${storeName}.`}
    </div>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-doodle-text/5 border-b-2 border-doodle-text/30 text-left">
            <th className="font-doodle font-bold py-2 px-3">Order #</th>
            <th className="font-doodle font-bold py-2 px-3">Date</th>
            <th className="font-doodle font-bold py-2 px-3 hidden sm:table-cell">PO #</th>
            <th className="font-doodle font-bold py-2 px-3 text-center">Lines</th>
            <th className="font-doodle font-bold py-2 px-3 text-right">Total</th>
            <th className="font-doodle font-bold py-2 px-3">Status</th>
            <th className="font-doodle font-bold py-2 px-3 hidden lg:table-cell">Ship Method</th>
            <th className="py-2 px-3"></th>
          </tr>
        </thead>
        <tbody>
          {orders.slice(0, 25).map((order) => {
            const st = ORDER_STATUS[order.status] ?? { label: `#${order.status}`, color: "text-gray-600", bg: "bg-gray-100" };
            return (
              <tr key={order.salesOrderID} className="border-b border-doodle-text/10 hover:bg-doodle-accent/5">
                <td className="py-2 px-3">
                  <Link to={`/orders/${order.salesOrderID}`} className="font-doodle font-bold text-doodle-accent hover:underline">
                    #{order.salesOrderID}
                  </Link>
                </td>
                <td className="py-2 px-3 font-doodle text-doodle-text/70">
                  {new Date(order.orderDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                </td>
                <td className="py-2 px-3 font-doodle text-doodle-text/60 hidden sm:table-cell">{order.purchaseOrderNumber ?? "—"}</td>
                <td className="py-2 px-3 font-doodle text-center">{order.lineItemCount}</td>
                <td className="py-2 px-3 font-doodle font-bold text-right text-doodle-accent">
                  ${order.totalDue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="py-2 px-3">
                  <span className={`font-doodle text-xs font-bold px-2 py-0.5 border ${st.color} ${st.bg}`}>{st.label}</span>
                </td>
                <td className="py-2 px-3 font-doodle text-xs text-doodle-text/50 hidden lg:table-cell">{order.shipMethodName ?? "—"}</td>
                <td className="py-2 px-3">
                  <div className="flex items-center gap-1.5 justify-end">
                    <button
                      onClick={() => setReorderSalesOrderId(order.salesOrderID)}
                      disabled={reorderSalesOrderId === order.salesOrderID}
                      title="Reorder the same items"
                      className="flex items-center gap-1 px-2 py-1 text-xs font-doodle font-bold border border-doodle-text/40 hover:bg-doodle-accent hover:text-white hover:border-doodle-accent transition-colors disabled:opacity-40"
                    >
                      {reorderSalesOrderId === order.salesOrderID
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <RefreshCw className="w-3 h-3" />}
                      Reorder
                    </button>
                    <Link to={`/orders/${order.salesOrderID}`} className="p-1 border border-doodle-text/30 hover:bg-doodle-accent/10 transition-colors" title="View order">
                      <ArrowUpRight className="w-3 h-3" />
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {orders.length > 25 && (
        <p className="font-doodle text-xs text-doodle-text/40 text-center py-2">Showing 25 of {orders.length} orders</p>
      )}

      {reorderItems && (
        <PlaceStoreOrderDialog
          store={store}
          initialItems={reorderItems}
          onClose={() => setReorderItems(null)}
        />
      )}
    </div>
  );
};

// ── Store row ─────────────────────────────────────────────────────────────────
const StoreRow: React.FC<{ store: StoreListItem; rank: number }> = ({ store, rank }) => {
  const [expanded, setExpanded] = useState(false);
  const [showOrderDialog, setShowOrderDialog] = useState(false);
  const tier = getStoreTier(store.totalRevenue);
  const tierCfg = TIER[tier];

  return (
    <>
      <tr
        className="border-b-2 border-doodle-text/10 hover:bg-doodle-accent/5 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-3 px-3 text-center w-10">
          <span className="font-doodle font-bold text-doodle-text/40 text-sm">
            {rank <= 3 ? MEDALS[rank - 1] : `#${rank}`}
          </span>
        </td>
        <td className="py-3 px-3">
          <div className="flex flex-wrap items-center gap-1.5 leading-tight">
            <span className="font-doodle font-bold text-doodle-text">{store.storeName}</span>
            {tier !== "none" && (
              <span className={`hidden sm:inline font-doodle text-xs font-bold px-1.5 py-0.5 border ${tierCfg.color} ${tierCfg.bg} ${tierCfg.border}`}>
                {tierCfg.icon} {tierCfg.label}
              </span>
            )}
          </div>
          {store.city && (
            <p className="font-doodle text-xs text-doodle-text/50 mt-0.5 flex items-center gap-1">
              <MapPin className="w-3 h-3 shrink-0" />
              {[store.city, store.stateProvince].filter(Boolean).join(", ")}
            </p>
          )}
        </td>
        <td className="py-3 px-3 hidden md:table-cell">
          {store.salesRepFirstName ? (
            <span className="font-doodle text-sm text-doodle-text/80 flex items-center gap-1">
              <User className="w-3 h-3 shrink-0" />
              {store.salesRepFirstName} {store.salesRepLastName}
            </span>
          ) : <span className="font-doodle text-sm text-doodle-text/30">—</span>}
        </td>
        <td className="py-3 px-3 text-right">
          <span className="font-doodle font-bold text-doodle-accent">{fmtRevenue(store.totalRevenue)}</span>
        </td>
        <td className="py-3 px-3 text-center hidden sm:table-cell">
          <span className="font-doodle font-bold text-doodle-text">{store.orderCount}</span>
        </td>
        <td className="py-3 px-3 text-center hidden lg:table-cell">
          <span className="font-doodle text-xs text-doodle-text/60">
            {store.lastOrderDate
              ? new Date(store.lastOrderDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
              : <span className="text-doodle-text/30">Never</span>}
          </span>
        </td>
        <td className="py-3 px-3">
          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowOrderDialog(true)}
              className="doodle-button doodle-button-primary flex items-center gap-1 px-2.5 py-1.5 text-xs"
            >
              <Plus className="w-3 h-3" /> Order
            </button>
            <button onClick={() => setExpanded(!expanded)}
              className="p-1.5 border border-doodle-text/40 hover:bg-doodle-accent/10 transition-colors"
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-doodle-text/[0.015]">
          <td colSpan={7} className="px-4 pb-4 pt-1">
            <div className="doodle-card p-4">
              <h4 className="font-doodle font-bold text-sm text-doodle-text mb-3 flex items-center gap-2">
                <ShoppingBag className="w-4 h-4 text-doodle-accent" />
                Order History — {store.storeName}
                <span className="font-doodle font-normal text-doodle-text/50 text-xs">
                  ({store.orderCount} order{store.orderCount !== 1 ? "s" : ""})
                </span>
              </h4>
              <StoreOrderHistory
                storeId={store.storeBusinessEntityId}
                storeName={store.storeName}
                orderCount={store.orderCount}
                store={store}
              />
            </div>
          </td>
        </tr>
      )}
      {showOrderDialog && (
        <PlaceStoreOrderDialog store={store} onClose={() => setShowOrderDialog(false)} />
      )}
    </>
  );
};

// ── Territory card ────────────────────────────────────────────────────────────
const TerritoryCard: React.FC<{
  territory: TerritoryStoreSummary;
  rank: number;
  maxRevenue: number;
  onSelect: (t: TerritoryStoreSummary) => void;
}> = ({ territory, rank, maxRevenue, onSelect }) => {
  const flag = FLAGS[territory.countryCode] ?? "🏴";
  const pct = maxRevenue > 0 ? (territory.totalRevenue / maxRevenue) * 100 : 0;

  return (
    <div
      className="doodle-card p-5 cursor-pointer hover:border-doodle-accent transition-colors group"
      onClick={() => onSelect(territory)}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-3xl leading-none">{flag}</span>
            {rank === 1 && (
              <span className="font-doodle text-xs font-bold text-amber-700 bg-amber-50 border border-amber-300 px-1.5 py-0.5">
                🏆 #1
              </span>
            )}
          </div>
          <h3 className="font-doodle font-bold text-lg text-doodle-text leading-tight">{territory.territoryName}</h3>
          <p className="font-doodle text-sm text-doodle-text/50">{territory.countryName}</p>
        </div>
        <span className="font-doodle text-3xl font-bold text-doodle-text/10 select-none">#{rank}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="font-doodle text-xl font-bold text-doodle-accent">{fmtRevenue(territory.totalRevenue)}</p>
          <p className="font-doodle text-xs text-doodle-text/50">Total Revenue</p>
        </div>
        <div>
          <p className="font-doodle text-xl font-bold text-doodle-text">{territory.storeCount}</p>
          <p className="font-doodle text-xs text-doodle-text/50">
            Stores
            {territory.activeStoreCount > 0 && (
              <span className="text-green-600"> · {territory.activeStoreCount} with orders</span>
            )}
          </p>
        </div>
      </div>

      <div className="mb-4">
        <div className="h-2 bg-doodle-text/10 border border-doodle-text/15 rounded-sm overflow-hidden">
          <div className="h-full bg-doodle-accent rounded-sm" style={{ width: `${pct}%` }} />
        </div>
        <p className="font-doodle text-[11px] text-doodle-text/35 mt-1 text-right">{pct.toFixed(0)}% of top territory</p>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-doodle-text/10">
        <div>
          <p className="font-doodle text-[11px] text-doodle-text/40 uppercase tracking-wide">Avg / store</p>
          <p className="font-doodle text-sm font-bold text-doodle-text">{fmtRevenue(territory.avgRevenuePerStore)}</p>
        </div>
        <span className="font-doodle text-sm text-doodle-accent group-hover:underline flex items-center gap-1">
          View stores <ArrowUpRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </div>
  );
};

// ── Overview page ─────────────────────────────────────────────────────────────
const OverviewPage: React.FC<{
  territories: TerritoryStoreSummary[];
  topStores: StoreListItem[];
  loading: boolean;
  onSelectTerritory: (t: TerritoryStoreSummary) => void;
}> = ({ territories, topStores, loading, onSelectTerritory }) => {
  const totalStores  = territories.reduce((s, t) => s + t.storeCount, 0);
  const totalRevenue = territories.reduce((s, t) => s + t.totalRevenue, 0);
  const totalOrders  = territories.reduce((s, t) => s + t.totalOrders, 0);
  const maxRevenue   = territories.length > 0 ? territories[0].totalRevenue : 1;

  return (
    <>
      <div className="doodle-card p-6 mb-6">
        <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-3 mb-1">
          <Store className="w-8 h-8 text-doodle-accent" />
          B2B Store Accounts
        </h1>
        <p className="font-doodle text-doodle-text/60">
          Wholesale store partners organised by sales territory — place phone and email orders on their behalf
        </p>
      </div>

      {loading ? (
        <div className="doodle-card p-20 flex items-center justify-center gap-2 font-doodle text-doodle-text/60">
          <Loader2 className="w-6 h-6 animate-spin" /> Loading territory data…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="doodle-card p-4">
              <Globe className="w-5 h-5 text-doodle-accent mb-2" />
              <p className="font-doodle text-2xl font-bold text-doodle-text">{territories.length}</p>
              <p className="font-doodle text-xs text-doodle-text/60">Sales Territories</p>
            </div>
            <div className="doodle-card p-4">
              <Store className="w-5 h-5 text-doodle-blue mb-2" />
              <p className="font-doodle text-2xl font-bold text-doodle-text">{totalStores.toLocaleString()}</p>
              <p className="font-doodle text-xs text-doodle-text/60">Store Accounts</p>
            </div>
            <div className="doodle-card p-4">
              <TrendingUp className="w-5 h-5 text-doodle-green mb-2" />
              <p className="font-doodle text-2xl font-bold text-doodle-accent">{fmtRevenue(totalRevenue)}</p>
              <p className="font-doodle text-xs text-doodle-text/60">Total B2B Revenue</p>
            </div>
            <div className="doodle-card p-4">
              <ShoppingBag className="w-5 h-5 text-doodle-accent mb-2" />
              <p className="font-doodle text-2xl font-bold text-doodle-text">{totalOrders.toLocaleString()}</p>
              <p className="font-doodle text-xs text-doodle-text/60">Total B2B Orders</p>
            </div>
          </div>

          {topStores.length > 0 && (
            <div className="doodle-card p-5 mb-6">
              <h2 className="font-doodle font-bold text-lg text-doodle-text flex items-center gap-2 mb-4">
                <Trophy className="w-5 h-5 text-amber-500" />
                Top Accounts by Revenue
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
                {topStores.map((store, i) => {
                  const t = TIER[getStoreTier(store.totalRevenue)];
                  return (
                    <div key={store.storeBusinessEntityId} className={`text-center p-3 border-2 ${t.border} ${t.bg}`}>
                      <div className="text-xl mb-1">{i < 3 ? MEDALS[i] : `#${i + 1}`}</div>
                      <p className="font-doodle text-xs font-bold text-doodle-text leading-tight mb-1 truncate" title={store.storeName}>
                        {store.storeName}
                      </p>
                      <p className={`font-doodle text-sm font-bold ${t.color}`}>{fmtRevenue(store.totalRevenue)}</p>
                      <p className="font-doodle text-[10px] text-doodle-text/40 mt-0.5">{store.territoryName ?? "—"}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <h2 className="font-doodle font-bold text-lg text-doodle-text mb-4 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-doodle-accent" />
              Revenue by Territory
              <span className="font-doodle text-sm font-normal text-doodle-text/40 ml-1">
                — select a territory to manage its stores
              </span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {territories.map((territory, i) => (
                <TerritoryCard
                  key={territory.territoryID}
                  territory={territory}
                  rank={i + 1}
                  maxRevenue={maxRevenue}
                  onSelect={onSelectTerritory}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
};

// ── Territory drill-down ──────────────────────────────────────────────────────
type SortOption = "revenue" | "orders" | "lastOrder" | "name";
const SORT_LABELS: Record<SortOption, string> = {
  revenue:   "Revenue",
  orders:    "Orders",
  lastOrder: "Last Order",
  name:      "Name A–Z",
};

const TerritoryStoreView: React.FC<{
  territory: TerritoryStoreSummary;
  stores: StoreListItem[];
  totalCount: number;
  sortBy: SortOption;
  setSortBy: (s: SortOption) => void;
  withOrdersOnly: boolean;
  setWithOrdersOnly: (v: boolean) => void;
  loading: boolean;
  onBack: () => void;
}> = ({ territory, stores, totalCount, sortBy, setSortBy, withOrdersOnly, setWithOrdersOnly, loading, onBack }) => {
  const flag = FLAGS[territory.countryCode] ?? "🏴";

  return (
    <>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-5 font-doodle text-sm">
        <button onClick={onBack} className="doodle-button flex items-center gap-1.5 px-3 py-1.5 text-sm">
          <ArrowLeft className="w-4 h-4" /> All Territories
        </button>
        <span className="text-doodle-text/40">/</span>
        <span className="text-doodle-text font-bold">{flag} {territory.territoryName}</span>
      </div>

      {/* Territory header */}
      <div className="doodle-card p-5 mb-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="font-doodle text-2xl font-bold text-doodle-text flex items-center gap-2">
              <span className="text-3xl">{flag}</span>
              {territory.territoryName}
            </h1>
            <p className="font-doodle text-doodle-text/50 text-sm mt-0.5">{territory.countryName}</p>
          </div>
          <div className="grid grid-cols-3 gap-6 text-center">
            <div>
              <p className="font-doodle text-xl font-bold text-doodle-accent">{fmtRevenue(territory.totalRevenue)}</p>
              <p className="font-doodle text-xs text-doodle-text/50">Revenue</p>
            </div>
            <div>
              <p className="font-doodle text-xl font-bold text-doodle-text">{territory.storeCount}</p>
              <p className="font-doodle text-xs text-doodle-text/50">Stores</p>
            </div>
            <div>
              <p className="font-doodle text-xl font-bold text-doodle-text">{territory.totalOrders.toLocaleString()}</p>
              <p className="font-doodle text-xs text-doodle-text/50">Orders</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tier legend */}
      <div className="flex flex-wrap gap-2 mb-4">
        {(["platinum", "gold", "silver", "bronze"] as Tier[]).map((key) => {
          const cfg = TIER[key];
          const thresholds: Record<string, string> = { platinum: "≥$500K", gold: "≥$100K", silver: "≥$20K", bronze: ">$0" };
          return (
            <span key={key} className={`font-doodle text-xs px-2 py-1 border ${cfg.color} ${cfg.bg} ${cfg.border}`}>
              {cfg.icon} {cfg.label} {thresholds[key]}
            </span>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="doodle-card p-3 mb-4 flex flex-wrap items-center gap-3">
        <span className="font-doodle text-sm text-doodle-text/60 shrink-0">Sort:</span>
        {(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => (
          <button
            key={opt}
            onClick={() => setSortBy(opt)}
            className={`font-doodle text-sm px-3 py-1.5 border-2 transition-colors ${
              sortBy === opt
                ? "border-doodle-accent bg-doodle-accent text-white"
                : "border-doodle-text/20 text-doodle-text hover:border-doodle-accent"
            }`}
          >
            {SORT_LABELS[opt]}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={withOrdersOnly} onChange={(e) => setWithOrdersOnly(e.target.checked)} className="w-4 h-4" />
            <span className="font-doodle text-sm text-doodle-text/70">Orders only</span>
          </label>
          <span className="font-doodle text-sm text-doodle-text/40">{stores.length} of {totalCount}</span>
        </div>
      </div>

      {/* Store table */}
      <div className="doodle-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-2 font-doodle text-doodle-text/60">
            <Loader2 className="w-6 h-6 animate-spin" /> Loading stores…
          </div>
        ) : stores.length === 0 ? (
          <div className="py-16 text-center font-doodle text-doodle-text/50">
            {withOrdersOnly ? "No stores with orders in this territory." : "No stores found."}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-doodle-text/5 border-b-2 border-doodle-text text-left">
                <th className="font-doodle font-bold py-3 px-3 w-10 text-center">#</th>
                <th className="font-doodle font-bold py-3 px-3">Store</th>
                <th className="font-doodle font-bold py-3 px-3 hidden md:table-cell">Sales Rep</th>
                <th className="font-doodle font-bold py-3 px-3 text-right">Revenue</th>
                <th className="font-doodle font-bold py-3 px-3 text-center hidden sm:table-cell">Orders</th>
                <th className="font-doodle font-bold py-3 px-3 text-center hidden lg:table-cell">Last Order</th>
                <th className="font-doodle font-bold py-3 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store, i) => (
                <StoreRow key={store.storeBusinessEntityId} store={store} rank={i + 1} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────
const StoresPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [selectedTerritory, setSelectedTerritory] = useState<TerritoryStoreSummary | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>("revenue");
  const [withOrdersOnly, setWithOrdersOnly] = useState(false);

  const { data: territories = [], isLoading: loadingTerritories } = useStoreTerritories();

  // Top 8 for overview leaderboard ─ always fetch
  const { data: topStoresData } = useStores(undefined, undefined, "revenue", 0, 8, true);
  const topStores = topStoresData?.items ?? [];

  // Per-territory store list ─ only fetch when a territory is drilled into
  const { data: storesData, isLoading: loadingStores } = useStores(
    undefined,
    selectedTerritory?.territoryID,
    sortBy,
    0,
    150,
    selectedTerritory !== null,
  );

  const filteredStores = useMemo(() => {
    const items = storesData?.items ?? [];
    return withOrdersOnly ? items.filter((s) => s.orderCount > 0) : items;
  }, [storesData, withOrdersOnly]);

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1">
        <section className="container mx-auto px-4 py-8">
          {selectedTerritory ? (
            <TerritoryStoreView
              territory={selectedTerritory}
              stores={filteredStores}
              totalCount={storesData?.totalCount ?? 0}
              sortBy={sortBy}
              setSortBy={setSortBy}
              withOrdersOnly={withOrdersOnly}
              setWithOrdersOnly={setWithOrdersOnly}
              loading={loadingStores}
              onBack={() => {
                setSelectedTerritory(null);
                setSortBy("revenue");
                setWithOrdersOnly(false);
              }}
            />
          ) : (
            <OverviewPage
              territories={territories}
              topStores={topStores}
              loading={loadingTerritories}
              onSelectTerritory={setSelectedTerritory}
            />
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default StoresPage;
