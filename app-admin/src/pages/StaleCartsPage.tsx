import { useState } from "react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import CartRecoveryAgent from "@/components/CartRecoveryAgent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  Search,
  ShoppingCart,
  Trash2,
  Mail,
  MoreHorizontal,
  AlertTriangle,
  Clock,
  DollarSign,
  Users,
  Eye,
  CheckCircle,
  RefreshCw,
} from "lucide-react";
import { mockStaleCarts } from "@/data/mockStaleCarts";
import { StaleCart } from "@/types/shoppingCart";
import { format } from "date-fns";

type StaleFilter = "all" | "7days" | "14days" | "30days" | "60days";

const StaleCartsPage = () => {
  const [carts, setCarts] = useState<StaleCart[]>(mockStaleCarts);
  const [searchTerm, setSearchTerm] = useState("");
  const [staleFilter, setStaleFilter] = useState<StaleFilter>("all");
  const [selectedCarts, setSelectedCarts] = useState<Set<string>>(new Set());
  const [viewCartDialog, setViewCartDialog] = useState<StaleCart | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    type: "clear" | "remind" | "bulkClear" | "bulkRemind";
    cart?: StaleCart;
  } | null>(null);

  const filteredCarts = carts.filter((cart) => {
    const matchesSearch =
      cart.customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cart.customerEmail.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cart.ShoppingCartID.toLowerCase().includes(searchTerm.toLowerCase());

    let matchesStaleFilter = true;
    switch (staleFilter) {
      case "7days":
        matchesStaleFilter = cart.daysStale >= 7;
        break;
      case "14days":
        matchesStaleFilter = cart.daysStale >= 14;
        break;
      case "30days":
        matchesStaleFilter = cart.daysStale >= 30;
        break;
      case "60days":
        matchesStaleFilter = cart.daysStale >= 60;
        break;
    }

    return matchesSearch && matchesStaleFilter;
  });

  const stats = {
    totalCarts: carts.length,
    totalValue: carts.reduce((sum, c) => sum + c.totalValue, 0),
    avgDaysStale: Math.round(
      carts.reduce((sum, c) => sum + c.daysStale, 0) / carts.length
    ),
    criticalCarts: carts.filter((c) => c.daysStale >= 30).length,
  };

  const getStaleBadgeVariant = (days: number) => {
    if (days >= 30) return "destructive";
    if (days >= 14) return "secondary";
    return "outline";
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedCarts(new Set(filteredCarts.map((c) => c.ShoppingCartID)));
    } else {
      setSelectedCarts(new Set());
    }
  };

  const handleSelectCart = (cartId: string, checked: boolean) => {
    const newSelected = new Set(selectedCarts);
    if (checked) {
      newSelected.add(cartId);
    } else {
      newSelected.delete(cartId);
    }
    setSelectedCarts(newSelected);
  };

  const handleClearCart = (cart: StaleCart) => {
    setCarts((prev) => prev.filter((c) => c.ShoppingCartID !== cart.ShoppingCartID));
    setSelectedCarts((prev) => {
      const newSet = new Set(prev);
      newSet.delete(cart.ShoppingCartID);
      return newSet;
    });
    toast.success(`Cart ${cart.ShoppingCartID} cleared successfully`);
    setConfirmDialog(null);
  };

  const handleRemindCustomer = (cart: StaleCart) => {
    toast.success(`Reminder email sent to ${cart.customerEmail}`);
    setConfirmDialog(null);
  };

  const handleBulkClear = () => {
    setCarts((prev) =>
      prev.filter((c) => !selectedCarts.has(c.ShoppingCartID))
    );
    toast.success(`${selectedCarts.size} carts cleared successfully`);
    setSelectedCarts(new Set());
    setConfirmDialog(null);
  };

  const handleBulkRemind = () => {
    toast.success(`Reminder emails sent to ${selectedCarts.size} customers`);
    setConfirmDialog(null);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AdminHeader />

      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <ShoppingCart className="h-8 w-8" />
              Stale Cart Management
            </h1>
            <p className="text-muted-foreground mt-1">
              Manage abandoned shopping carts and re-engage customers
            </p>
          </div>
          <Button variant="outline" onClick={() => toast.info("Refreshing cart data...")}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>

        {/* AI Cart Recovery Agent */}
        <CartRecoveryAgent carts={carts} />

        {/* Stats Dashboard */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Stale Carts</CardTitle>
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalCarts}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Potential Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${stats.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Days Stale</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.avgDaysStale} days</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Critical (30+ days)</CardTitle>
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{stats.criticalCarts}</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters and Actions */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by customer name, email, or cart ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={staleFilter} onValueChange={(v) => setStaleFilter(v as StaleFilter)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by age" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Carts</SelectItem>
              <SelectItem value="7days">7+ days stale</SelectItem>
              <SelectItem value="14days">14+ days stale</SelectItem>
              <SelectItem value="30days">30+ days stale</SelectItem>
              <SelectItem value="60days">60+ days stale</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Bulk Actions */}
        {selectedCarts.size > 0 && (
          <div className="flex items-center gap-4 mb-4 p-4 bg-muted rounded-lg">
            <span className="text-sm font-medium">
              {selectedCarts.size} cart(s) selected
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDialog({ type: "bulkRemind" })}
            >
              <Mail className="h-4 w-4 mr-2" />
              Send Reminders
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDialog({ type: "bulkClear" })}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear Selected
            </Button>
          </div>
        )}

        {/* Carts Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={
                        filteredCarts.length > 0 &&
                        selectedCarts.size === filteredCarts.length
                      }
                      onCheckedChange={handleSelectAll}
                    />
                  </TableHead>
                  <TableHead>Cart ID</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-center">Items</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Last Activity</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCarts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8">
                      <ShoppingCart className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
                      <p className="text-muted-foreground">No stale carts found</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredCarts.map((cart) => (
                    <TableRow key={cart.ShoppingCartID}>
                      <TableCell>
                        <Checkbox
                          checked={selectedCarts.has(cart.ShoppingCartID)}
                          onCheckedChange={(checked) =>
                            handleSelectCart(cart.ShoppingCartID, checked as boolean)
                          }
                        />
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {cart.ShoppingCartID}
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-medium">{cart.customerName}</div>
                          <div className="text-sm text-muted-foreground">
                            {cart.customerEmail}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">{cart.totalItems}</TableCell>
                      <TableCell className="text-right font-medium">
                        ${cart.totalValue.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        {format(new Date(cart.lastActivity), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={getStaleBadgeVariant(cart.daysStale)}>
                          {cart.daysStale} days
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setViewCartDialog(cart)}>
                              <Eye className="h-4 w-4 mr-2" />
                              View Details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setConfirmDialog({ type: "remind", cart })}
                            >
                              <Mail className="h-4 w-4 mr-2" />
                              Send Reminder
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setConfirmDialog({ type: "clear", cart })}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Clear Cart
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>

      <Footer />

      {/* View Cart Dialog */}
      <Dialog open={!!viewCartDialog} onOpenChange={() => setViewCartDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cart Details - {viewCartDialog?.ShoppingCartID}</DialogTitle>
            <DialogDescription>
              Customer: {viewCartDialog?.customerName} ({viewCartDialog?.customerEmail})
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Total Items:</span>
                <span className="ml-2 font-medium">{viewCartDialog?.totalItems}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Total Value:</span>
                <span className="ml-2 font-medium">
                  ${viewCartDialog?.totalValue.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Days Stale:</span>
                <span className="ml-2 font-medium">{viewCartDialog?.daysStale} days</span>
              </div>
              <div>
                <span className="text-muted-foreground">Last Activity:</span>
                <span className="ml-2 font-medium">
                  {viewCartDialog && format(new Date(viewCartDialog.lastActivity), "MMM d, yyyy")}
                </span>
              </div>
            </div>
            <div>
              <h4 className="font-medium mb-2">Cart Items</h4>
              <div className="border rounded-lg divide-y">
                {viewCartDialog?.items.map((item) => (
                  <div
                    key={item.ShoppingCartItemID}
                    className="p-3 flex justify-between items-center"
                  >
                    <div>
                      <div className="font-medium">Product #{item.ProductID}</div>
                      <div className="text-sm text-muted-foreground">
                        Added: {format(new Date(item.DateCreated), "MMM d, yyyy")}
                      </div>
                    </div>
                    <Badge variant="outline">Qty: {item.Quantity}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewCartDialog(null)}>
              Close
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setViewCartDialog(null);
                setConfirmDialog({ type: "remind", cart: viewCartDialog! });
              }}
            >
              <Mail className="h-4 w-4 mr-2" />
              Send Reminder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Dialog */}
      <Dialog open={!!confirmDialog} onOpenChange={() => setConfirmDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmDialog?.type === "clear" && "Clear Cart"}
              {confirmDialog?.type === "remind" && "Send Reminder"}
              {confirmDialog?.type === "bulkClear" && "Clear Selected Carts"}
              {confirmDialog?.type === "bulkRemind" && "Send Bulk Reminders"}
            </DialogTitle>
            <DialogDescription>
              {confirmDialog?.type === "clear" &&
                `Are you sure you want to clear cart ${confirmDialog.cart?.ShoppingCartID}? This will remove all items and cannot be undone.`}
              {confirmDialog?.type === "remind" &&
                `Send a reminder email to ${confirmDialog.cart?.customerEmail} about their abandoned cart?`}
              {confirmDialog?.type === "bulkClear" &&
                `Are you sure you want to clear ${selectedCarts.size} carts? This action cannot be undone.`}
              {confirmDialog?.type === "bulkRemind" &&
                `Send reminder emails to ${selectedCarts.size} customers about their abandoned carts?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog(null)}>
              Cancel
            </Button>
            {confirmDialog?.type === "clear" && (
              <Button
                variant="destructive"
                onClick={() => handleClearCart(confirmDialog.cart!)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear Cart
              </Button>
            )}
            {confirmDialog?.type === "remind" && (
              <Button onClick={() => handleRemindCustomer(confirmDialog.cart!)}>
                <Mail className="h-4 w-4 mr-2" />
                Send Reminder
              </Button>
            )}
            {confirmDialog?.type === "bulkClear" && (
              <Button variant="destructive" onClick={handleBulkClear}>
                <Trash2 className="h-4 w-4 mr-2" />
                Clear {selectedCarts.size} Carts
              </Button>
            )}
            {confirmDialog?.type === "bulkRemind" && (
              <Button onClick={handleBulkRemind}>
                <Mail className="h-4 w-4 mr-2" />
                Send {selectedCarts.size} Reminders
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default StaleCartsPage;
