import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Factory,
  Users,
  AlertTriangle,
  Wallet,
  Banknote,
} from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";
import { DashboardSkeleton } from "@/components/LoadingSkeletons";
import {
  fetchBankStatus,
  fetchFinancialSummary,
  fetchRecentTransactions,
  fetchProcurementTransactions,
  fetchManufacturingTransactions,
  type BankTransaction,
} from "@/services/financeApi";
import { fetchOpenSalesOrders } from "@/services/salesApi";

const COLORS = {
  procurement: "#ef4444",
  manufacturing: "#f97316",
  payroll: "#eab308",
  scrap: "#a855f7",
  revenue: "#22c55e",
};

function formatCurrency(value: number, compact = false): string {
  if (compact && Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (compact && Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function txnTypeBadge(type: string) {
  const map: Record<string, string> = {
    sale: "bg-green-100 text-green-800",
    purchase: "bg-red-100 text-red-800",
    payroll: "bg-yellow-100 text-yellow-800",
    other: "bg-purple-100 text-purple-800",
    initial: "bg-blue-100 text-blue-800",
    deposit: "bg-green-100 text-green-800",
    withdrawal: "bg-red-100 text-red-800",
  };
  return (
    <Badge className={`${map[type] || "bg-gray-100 text-gray-800"} text-xs`}>
      {type}
    </Badge>
  );
}

const FinanceManager: React.FC = () => {
  const [txnTab, setTxnTab] = useState("all");

  const { data: bankStatus, isLoading: statusLoading } = useQuery({
    queryKey: ["bank-status"],
    queryFn: fetchBankStatus,
    refetchInterval: 60_000,
  });

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["financial-summary"],
    queryFn: fetchFinancialSummary,
    refetchInterval: 60_000,
  });

  const { data: allTxns } = useQuery({
    queryKey: ["recent-transactions"],
    queryFn: () => fetchRecentTransactions(50),
    refetchInterval: 60_000,
  });

  const { data: procTxns } = useQuery({
    queryKey: ["procurement-transactions"],
    queryFn: () => fetchProcurementTransactions(50),
    refetchInterval: 60_000,
    enabled: txnTab === "procurement",
  });

  const { data: mfgTxns } = useQuery({
    queryKey: ["manufacturing-transactions"],
    queryFn: () => fetchManufacturingTransactions(50, "all"),
    refetchInterval: 60_000,
    enabled: txnTab === "manufacturing",
  });

  const { data: openOrders } = useQuery({
    queryKey: ["open-sales-orders"],
    queryFn: fetchOpenSalesOrders,
    refetchInterval: 60_000,
  });

  const isLoading = statusLoading || summaryLoading;

  if (isLoading) return <DashboardSkeleton />;

  const pieData = summary
    ? [
        {
          name: "Procurement",
          value: summary.procurement.netSpend,
          color: COLORS.procurement,
        },
        {
          name: "Manufacturing",
          value: summary.manufacturing.totalCost,
          color: COLORS.manufacturing,
        },
        {
          name: "Payroll",
          value: summary.payroll.totalCost,
          color: COLORS.payroll,
        },
        {
          name: "Scrap",
          value: summary.scrap.totalWriteOffs,
          color: COLORS.scrap,
        },
      ].filter((d) => d.value > 0)
    : [];

  const activeTxns: BankTransaction[] =
    txnTab === "procurement"
      ? (procTxns ?? [])
      : txnTab === "manufacturing"
        ? (mfgTxns ?? [])
        : txnTab === "sales"
          ? (allTxns ?? []).filter(
              (t) =>
                t.transactionType === "sale" ||
                (t.referenceId?.startsWith("SO-") && t.amount > 0),
            )
          : (allTxns ?? []);

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Wallet className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold font-doodle">Finance Manager</h1>
          <p className="text-sm text-muted-foreground">
            Real-time financial activity from the Bank Simulator
          </p>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Banknote className="h-5 w-5 text-green-600" />
            <div>
              <p className="text-xl font-bold font-doodle">
                {bankStatus ? formatCurrency(bankStatus.totalUsd, true) : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Cash Position</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <TrendingUp className="h-5 w-5 text-blue-600" />
            <div>
              <p className="text-xl font-bold font-doodle">
                {summary
                  ? formatCurrency(summary.revenue.totalRevenue, true)
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Total Revenue</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <TrendingDown className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-xl font-bold font-doodle">
                {summary
                  ? formatCurrency(summary.procurement.netSpend, true)
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Net Procurement</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Factory className="h-5 w-5 text-orange-500" />
            <div>
              <p className="text-xl font-bold font-doodle">
                {summary
                  ? formatCurrency(
                      summary.manufacturing.totalCost +
                        summary.payroll.totalCost,
                      true,
                    )
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Mfg + Payroll</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-purple-500" />
            <div>
              <p className="text-xl font-bold font-doodle">
                {summary
                  ? formatCurrency(summary.scrap.totalWriteOffs, true)
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Scrap Write-Offs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-slate-600" />
            <div>
              <p className="text-xl font-bold font-doodle">
                {summary
                  ? formatCurrency(summary.totals.totalOperatingCost, true)
                  : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Total OpCost</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Middle row: Currency balances + Spend breakdown chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Currency Balances */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Currency Accounts</CardTitle>
          </CardHeader>
          <CardContent>
            {bankStatus && bankStatus.accounts.length > 0 ? (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {bankStatus.accounts
                  .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
                  .map((acct) => (
                    <div
                      key={acct.currencyCode}
                      className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-xs">
                          {acct.currencyCode}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {acct.currencyName}
                        </span>
                      </div>
                      <span
                        className={`font-mono text-sm font-medium ${
                          acct.balance >= 0 ? "text-green-700" : "text-red-600"
                        }`}
                      >
                        {acct.balance >= 0 ? "+" : ""}
                        {acct.balance.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No accounts loaded.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Spend Breakdown Pie Chart */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Spend Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    label={({ name, percent }) =>
                      `${name} ${(percent * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                  >
                    {pieData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground">
                No spend data available yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Live Transaction Feed */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Live Transaction Feed</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={txnTab} onValueChange={setTxnTab}>
            <TabsList className="mb-4">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="sales">Sales</TabsTrigger>
              <TabsTrigger value="procurement">Procurement</TabsTrigger>
              <TabsTrigger value="manufacturing">Manufacturing</TabsTrigger>
            </TabsList>

            <TabsContent value={txnTab}>
              <div className="max-h-[420px] overflow-y-auto rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">Time</TableHead>
                      <TableHead className="w-[60px]">CCY</TableHead>
                      <TableHead className="text-right w-[110px]">
                        Amount
                      </TableHead>
                      <TableHead className="w-[90px]">Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-[120px]">Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeTxns.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center text-muted-foreground py-8"
                        >
                          {openOrders && openOrders.length > 0 ? (
                            <>
                              No transactions yet &mdash; {openOrders.length}{" "}
                              order{openOrders.length !== 1 ? "s" : ""}{" "}
                              currently being processed (
                              {formatCurrency(
                                openOrders.reduce(
                                  (sum, o) => sum + o.TotalDue,
                                  0,
                                ),
                                true,
                              )}
                              )
                            </>
                          ) : (
                            "No transactions yet, and no orders currently awaiting processing."
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      activeTxns.map((txn) => (
                        <TableRow key={txn.transactionId}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatTimestamp(txn.transactedAtUtc)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className="font-mono text-xs"
                            >
                              {txn.currencyCode}
                            </Badge>
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono text-sm ${
                              txn.amount >= 0
                                ? "text-green-700"
                                : "text-red-600"
                            }`}
                          >
                            {txn.amount >= 0 ? "+" : ""}
                            {txn.amount.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </TableCell>
                          <TableCell>
                            {txnTypeBadge(txn.transactionType)}
                          </TableCell>
                          <TableCell className="text-sm max-w-[300px] truncate">
                            {txn.description}
                          </TableCell>
                          <TableCell className="text-xs font-mono text-muted-foreground">
                            {txn.referenceId ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Transaction counts summary */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-lg font-bold">
                {summary.revenue.transactionCount}
              </p>
              <p className="text-xs text-muted-foreground">Sales</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-lg font-bold">
                {summary.procurement.transactionCount}
              </p>
              <p className="text-xs text-muted-foreground">PO Payments</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-lg font-bold">
                {summary.manufacturing.transactionCount}
              </p>
              <p className="text-xs text-muted-foreground">WO Charges</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-lg font-bold">
                {summary.payroll.transactionCount}
              </p>
              <p className="text-xs text-muted-foreground">Payroll</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-lg font-bold">
                {summary.scrap.transactionCount}
              </p>
              <p className="text-xs text-muted-foreground">Scrap Events</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};

export default FinanceManager;
