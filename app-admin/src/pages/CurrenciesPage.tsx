import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DollarSign,
  Search,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  ArrowLeft,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Currency, CurrencyRate } from "@/types/currency";
import {
  useAdminCurrencies,
  useAdminCurrencyRates,
  useRefreshExchangeRates,
} from "@/hooks/useAdminCatalog";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { format } from "date-fns";

const CurrenciesPage = () => {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-driven tab and currency filter
  const activeTab = searchParams.get("tab") ?? "currencies";
  const filterCurrency = searchParams.get("currency") ?? "";

  // Pagination state — reset when the currency filter changes
  const [ratesCursor, setRatesCursor] = useState<string | null>(null);
  const [ratesCursorStack, setRatesCursorStack] = useState<string[]>([]);

  useEffect(() => {
    setRatesCursor(null);
    setRatesCursorStack([]);
  }, [filterCurrency]);

  const { data: apiCurrencies = [] } = useAdminCurrencies();
  const { data: ratesData } = useAdminCurrencyRates(
    ratesCursor,
    filterCurrency || null,
  );

  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [currencyRates, setCurrencyRates] = useState<CurrencyRate[]>([]);
  const [ratesHasMore, setRatesHasMore] = useState(false);

  const refreshRates = useRefreshExchangeRates();
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (apiCurrencies.length > 0) setCurrencies(apiCurrencies);
  }, [apiCurrencies]);

  useEffect(() => {
    const items = ratesData?.items;
    if (items) {
      setCurrencyRates(items);
      setRatesHasMore(ratesData?.hasNextPage ?? false);
    }
  }, [ratesData]);

  const filteredCurrencies = currencies.filter(
    (currency) =>
      currency.Name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      currency.CurrencyCode.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleViewRates = (currencyCode: string) => {
    setSearchParams({ tab: "rates", currency: currencyCode });
  };

  const handleTabChange = (tab: string) => {
    if (tab === "currencies") {
      setSearchParams({});
    } else {
      setSearchParams({ tab });
    }
  };

  const handleClearFilter = () => {
    setSearchParams({ tab: "rates" });
  };

  const handleRefreshRates = async () => {
    try {
      const result = await refreshRates.mutateAsync();
      toast({
        title: "Exchange Rates Updated",
        description: `Updated ${result.updated} rates for ${result.rateDate}.${result.skipped > 0 ? ` ${result.skipped} currencies not in ECB data were skipped.` : ""}`,
      });
    } catch (err) {
      toast({
        title: "Refresh Failed",
        description:
          err instanceof Error
            ? err.message
            : "Could not refresh exchange rates.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AdminHeader />

      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="flex flex-col gap-6">
          {/* Page header */}
          <div className="flex items-center gap-3">
            <DollarSign className="h-8 w-8 text-primary" />
            <div>
              <h1 className="text-3xl font-bold text-foreground">Currencies</h1>
              <p className="text-muted-foreground">
                View currencies and exchange rates for international pricing
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-primary" />
                  Total Currencies
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-primary">
                  {currencies.length}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Exchange Rates
                  {filterCurrency ? ` — ${filterCurrency}` : ""}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-primary">
                  {currencyRates.length}
                  {ratesHasMore ? "+" : ""}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* URL-driven tab bar */}
          <div className="border-b">
            <nav className="flex gap-1 -mb-px">
              {(["currencies", "rates"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab === "currencies" ? "Currencies" : "Exchange Rates"}
                </button>
              ))}
            </nav>
          </div>

          {/* ── Currencies tab ──────────────────────────────────────────────── */}
          {activeTab === "currencies" && (
            <div className="space-y-4">
              <div className="relative max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name or code..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Code</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Last Modified</TableHead>
                        <TableHead className="text-right">
                          Exchange Rates
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCurrencies.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={4}
                            className="text-center py-8 text-muted-foreground"
                          >
                            No currencies found.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredCurrencies.map((currency) => (
                          <TableRow key={currency.CurrencyCode}>
                            <TableCell className="font-mono font-bold">
                              {currency.CurrencyCode}
                            </TableCell>
                            <TableCell>{currency.Name}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {format(
                                new Date(currency.ModifiedDate),
                                "MMM d, yyyy HH:mm",
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  handleViewRates(currency.CurrencyCode)
                                }
                              >
                                <ExternalLink className="h-3 w-3 mr-1" />
                                View Rates
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── Exchange Rates tab ─────────────────────────────────────────── */}
          {activeTab === "rates" && (
            <div className="space-y-4">
              {/* Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {filterCurrency ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClearFilter}
                      >
                        <ArrowLeft className="h-4 w-4 mr-1" />
                        All rates
                      </Button>
                      <Badge variant="secondary" className="text-sm px-3 py-1">
                        <TrendingUp className="h-3 w-3 mr-1" />
                        Filtered by: {filterCurrency}
                        <button
                          onClick={handleClearFilter}
                          className="ml-2 hover:text-destructive"
                          aria-label="Clear filter"
                        >
                          ×
                        </button>
                      </Badge>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      Showing all exchange rates
                    </span>
                  )}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshRates}
                  disabled={refreshRates.isPending}
                >
                  {refreshRates.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  {refreshRates.isPending ? "Refreshing…" : "Refresh from ECB"}
                </Button>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {filterCurrency
                      ? `Exchange Rates for ${filterCurrency}`
                      : "Current Exchange Rates"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>From</TableHead>
                        <TableHead>To</TableHead>
                        <TableHead>Average Rate</TableHead>
                        <TableHead>End of Day Rate</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {currencyRates.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="text-center py-8 text-muted-foreground"
                          >
                            {filterCurrency
                              ? `No exchange rates found for ${filterCurrency}.`
                              : "No exchange rates available."}
                          </TableCell>
                        </TableRow>
                      ) : (
                        currencyRates.map((rate) => (
                          <TableRow key={rate.CurrencyRateID}>
                            <TableCell className="font-mono font-bold">
                              {rate.FromCurrencyCode}
                            </TableCell>
                            <TableCell className="font-mono font-bold">
                              {rate.ToCurrencyCode}
                            </TableCell>
                            <TableCell>{rate.AverageRate.toFixed(4)}</TableCell>
                            <TableCell>
                              {rate.EndOfDayRate.toFixed(4)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {format(
                                new Date(rate.CurrencyRateDate),
                                "MMM d, yyyy",
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Pagination */}
              {(ratesCursorStack.length > 0 || ratesData?.hasNextPage) && (
                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      const prev =
                        ratesCursorStack[ratesCursorStack.length - 1] ?? null;
                      setRatesCursorStack((s) => s.slice(0, -1));
                      setRatesCursor(prev);
                    }}
                    disabled={ratesCursorStack.length === 0}
                  >
                    <ChevronLeft className="h-4 w-4 mr-2" /> Previous 100
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Batch {ratesCursorStack.length + 1}
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRatesCursorStack((s) => [...s, ratesCursor ?? ""]);
                      setRatesCursor(ratesData!.endCursor);
                    }}
                    disabled={!ratesData?.hasNextPage}
                  >
                    Next 100 <ChevronRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default CurrenciesPage;
