import React, { useState, useEffect } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  DollarSign,
  Search,
  RefreshCw,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Currency, CurrencyRate } from "@/types/currency";
import {
  useAdminCurrencies,
  useAdminCurrencyRates,
} from "@/hooks/useAdminCatalog";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { format } from "date-fns";

const CurrenciesPage = () => {
  const { toast } = useToast();
  const { data: apiCurrencies = [] } = useAdminCurrencies();
  const [ratesCursor, setRatesCursor] = useState<string | null>(null);
  const [ratesCursorStack, setRatesCursorStack] = useState<string[]>([]);
  const { data: ratesData } = useAdminCurrencyRates(ratesCursor);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [currencyRates, setCurrencyRates] = useState<CurrencyRate[]>([]);
  const [ratesHasMore, setRatesHasMore] = useState(false);

  useEffect(() => {
    if (apiCurrencies.length > 0) setCurrencies(apiCurrencies);
  }, [apiCurrencies]);
  useEffect(() => {
    const items = ratesData?.items;
    if (items && items.length > 0) {
      setCurrencyRates(items);
      setRatesHasMore(ratesData?.hasNextPage ?? false);
    }
  }, [ratesData]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<Currency | null>(null);
  const [deletingCurrency, setDeletingCurrency] = useState<Currency | null>(
    null,
  );
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const [formData, setFormData] = useState({
    CurrencyCode: "",
    Name: "",
  });

  const filteredCurrencies = currencies.filter(
    (currency) =>
      currency.Name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      currency.CurrencyCode.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const getRatesForCurrency = (currencyCode: string) => {
    return currencyRates.filter(
      (rate) =>
        rate.FromCurrencyCode === currencyCode ||
        rate.ToCurrencyCode === currencyCode,
    ).length;
  };

  const openCreateDialog = () => {
    setEditingCurrency(null);
    setFormData({ CurrencyCode: "", Name: "" });
    setIsDialogOpen(true);
  };

  const openEditDialog = (currency: Currency) => {
    setEditingCurrency(currency);
    setFormData({
      CurrencyCode: currency.CurrencyCode,
      Name: currency.Name,
    });
    setIsDialogOpen(true);
  };

  const openDeleteDialog = (currency: Currency) => {
    setDeletingCurrency(currency);
    setIsDeleteDialogOpen(true);
  };

  const handleSave = () => {
    if (!formData.CurrencyCode.trim() || !formData.Name.trim()) {
      toast({
        title: "Validation Error",
        description: "Currency Code and Name are required.",
        variant: "destructive",
      });
      return;
    }

    if (formData.CurrencyCode.length !== 3) {
      toast({
        title: "Validation Error",
        description: "Currency Code must be exactly 3 characters.",
        variant: "destructive",
      });
      return;
    }

    if (editingCurrency) {
      setCurrencies((prev) =>
        prev.map((c) =>
          c.CurrencyCode === editingCurrency.CurrencyCode
            ? {
                ...c,
                Name: formData.Name,
                ModifiedDate: new Date().toISOString(),
              }
            : c,
        ),
      );
      toast({
        title: "Currency Updated",
        description: `"${formData.Name}" has been updated.`,
      });
    } else {
      if (
        currencies.some(
          (c) =>
            c.CurrencyCode.toUpperCase() ===
            formData.CurrencyCode.toUpperCase(),
        )
      ) {
        toast({
          title: "Duplicate Code",
          description: "A currency with this code already exists.",
          variant: "destructive",
        });
        return;
      }
      const newCurrency: Currency = {
        CurrencyCode: formData.CurrencyCode.toUpperCase().trim(),
        Name: formData.Name.trim(),
        ModifiedDate: new Date().toISOString(),
      };
      setCurrencies((prev) => [...prev, newCurrency]);
      toast({
        title: "Currency Created",
        description: `"${formData.Name}" has been added.`,
      });
    }
    setIsDialogOpen(false);
  };

  const handleDelete = () => {
    if (deletingCurrency) {
      setCurrencies((prev) =>
        prev.filter((c) => c.CurrencyCode !== deletingCurrency.CurrencyCode),
      );
      // Also remove associated rates
      setCurrencyRates((prev) =>
        prev.filter(
          (r) =>
            r.FromCurrencyCode !== deletingCurrency.CurrencyCode &&
            r.ToCurrencyCode !== deletingCurrency.CurrencyCode,
        ),
      );
      toast({
        title: "Currency Deleted",
        description: `"${deletingCurrency.Name}" and its exchange rates have been removed.`,
      });
    }
    setIsDeleteDialogOpen(false);
    setDeletingCurrency(null);
  };

  const refreshExchangeRates = async () => {
    setIsRefreshing(true);

    try {
      // Using the free ExchangeRate-API (no key required for basic usage)
      const response = await fetch("https://open.er-api.com/v6/latest/USD");

      if (!response.ok) {
        throw new Error("Failed to fetch exchange rates");
      }

      const data = await response.json();

      if (data.result !== "success") {
        throw new Error("API returned an error");
      }

      const now = new Date();
      const newRates: CurrencyRate[] = [];
      let rateId =
        Math.max(...currencyRates.map((r) => r.CurrencyRateID), 0) + 1;

      // Create rates from USD to each other currency
      currencies.forEach((currency) => {
        if (
          currency.CurrencyCode !== "USD" &&
          data.rates[currency.CurrencyCode]
        ) {
          const rate = data.rates[currency.CurrencyCode];
          newRates.push({
            CurrencyRateID: rateId++,
            CurrencyRateDate: format(now, "yyyy-MM-dd"),
            FromCurrencyCode: "USD",
            ToCurrencyCode: currency.CurrencyCode,
            AverageRate: rate,
            EndOfDayRate: rate,
            ModifiedDate: now.toISOString(),
          });
        }
      });

      // Add cross-rates for EUR as base
      if (data.rates["EUR"]) {
        currencies.forEach((currency) => {
          if (
            currency.CurrencyCode !== "EUR" &&
            currency.CurrencyCode !== "USD" &&
            data.rates[currency.CurrencyCode]
          ) {
            const eurRate =
              data.rates[currency.CurrencyCode] / data.rates["EUR"];
            newRates.push({
              CurrencyRateID: rateId++,
              CurrencyRateDate: format(now, "yyyy-MM-dd"),
              FromCurrencyCode: "EUR",
              ToCurrencyCode: currency.CurrencyCode,
              AverageRate: eurRate,
              EndOfDayRate: eurRate,
              ModifiedDate: now.toISOString(),
            });
          }
        });
      }

      setCurrencyRates(newRates);
      setLastRefresh(now);

      toast({
        title: "Exchange Rates Updated",
        description: `Successfully refreshed ${newRates.length} exchange rates from live data.`,
      });
    } catch (error) {
      console.error("Error fetching exchange rates:", error);
      toast({
        title: "Refresh Failed",
        description: "Could not fetch exchange rates. Please try again later.",
        variant: "destructive",
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AdminHeader />

      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="flex flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex items-center gap-3">
              <DollarSign className="h-8 w-8 text-primary" />
              <div>
                <h1 className="text-3xl font-bold text-foreground">
                  Currencies
                </h1>
                <p className="text-muted-foreground">
                  Manage currencies and exchange rates for international pricing
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={refreshExchangeRates}
                disabled={isRefreshing}
              >
                <RefreshCw
                  className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`}
                />
                {isRefreshing ? "Refreshing..." : "Refresh Rates"}
              </Button>
              <Button onClick={openCreateDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add Currency
              </Button>
            </div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-primary">
                  {currencyRates.length}
                  {ratesHasMore ? "+" : ""}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <RefreshCw className="h-5 w-5 text-primary" />
                  Last Refresh
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-medium text-muted-foreground">
                  {lastRefresh
                    ? format(lastRefresh, "MMM d, yyyy HH:mm")
                    : "Never"}
                </p>
              </CardContent>
            </Card>
          </div>

          <Tabs defaultValue="currencies" className="w-full">
            <TabsList>
              <TabsTrigger value="currencies">Currencies</TabsTrigger>
              <TabsTrigger value="rates">Exchange Rates</TabsTrigger>
            </TabsList>

            <TabsContent value="currencies" className="space-y-4">
              {/* Search */}
              <div className="relative max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name or code..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              {/* Currencies Table */}
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Code</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Exchange Rates</TableHead>
                        <TableHead>Last Modified</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCurrencies.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={5}
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
                            <TableCell>
                              <Badge variant="secondary">
                                <TrendingUp className="h-3 w-3 mr-1" />
                                {getRatesForCurrency(
                                  currency.CurrencyCode,
                                )}{" "}
                                rates
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {format(
                                new Date(currency.ModifiedDate),
                                "MMM d, yyyy HH:mm",
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openEditDialog(currency)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openDeleteDialog(currency)}
                                  className="text-destructive hover:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="rates" className="space-y-4">
              {/* Exchange Rates Table */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>Current Exchange Rates</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refreshExchangeRates}
                      disabled={isRefreshing}
                    >
                      <RefreshCw
                        className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`}
                      />
                      Refresh
                    </Button>
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
                            No exchange rates available. Click "Refresh Rates"
                            to fetch current rates.
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
              {/* DAB page navigation for exchange rates */}
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
              )}{" "}
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <Footer />

      {/* Create/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingCurrency ? "Edit Currency" : "Add New Currency"}
            </DialogTitle>
            <DialogDescription>
              {editingCurrency
                ? "Update the currency details below."
                : "Enter the details for the new currency."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="currencyCode">Currency Code</Label>
              <Input
                id="currencyCode"
                placeholder="e.g., USD, EUR, GBP"
                value={formData.CurrencyCode}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    CurrencyCode: e.target.value.toUpperCase(),
                  }))
                }
                disabled={!!editingCurrency}
                maxLength={3}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Standard 3-letter ISO 4217 currency code
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g., US Dollar, Euro, British Pound"
                value={formData.Name}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, Name: e.target.value }))
                }
                maxLength={50}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              {editingCurrency ? "Save Changes" : "Create Currency"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Currency</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingCurrency?.Name}" (
              {deletingCurrency?.CurrencyCode})? This will also remove all
              associated exchange rates. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CurrenciesPage;
