import React, { useState, useEffect, useMemo } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Search,
  ChevronLeft,
  ChevronRight,
  Mail,
  Phone,
  MapPin,
  Edit2,
  X,
  ChevronDown,
  ChevronUp,
  User,
  ShoppingBag,
  ExternalLink,
  Filter,
  BarChart3,
  Sparkles,
  CheckSquare,
  Square,
  ArrowUpDown,
  CreditCard,
  KeyRound,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import { Customer } from "@/types/customer";
import {
  useAdminCustomers,
  useCustomerOrders,
} from "@/hooks/useAdminCustomers";
import { useAdminCustomerAddresses } from "@/hooks/useAdminCustomerAddresses";
import { AdminProfileForm } from "@/components/AdminProfileForm";
import { AdminAddressForm } from "@/components/AdminAddressForm";
import { AdminPaymentMethodsPanel } from "@/components/AdminPaymentMethodsPanel";
import { AdminEmailsPanel } from "@/components/AdminEmailsPanel";
import { AdminPasswordReset } from "@/components/AdminPasswordReset";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import CountryFlag from "@/components/CountryFlag";
import { Checkbox } from "@/components/ui/checkbox";
import BulkAiEmailDialog from "@/components/BulkAiEmailDialog";
import GenerateCustomerWithAIDialog from "@/components/GenerateCustomerWithAIDialog";

// DB Status codes → display map
const DB_STATUS_LABELS: Record<
  number,
  { label: string; color: string; bg: string; icon: string }
> = {
  1: {
    label: "Processing",
    color: "text-blue-700",
    bg: "bg-blue-100",
    icon: "⚙️",
  },
  2: {
    label: "Approved",
    color: "text-green-700",
    bg: "bg-green-100",
    icon: "✅",
  },
  3: {
    label: "Backordered",
    color: "text-orange-700",
    bg: "bg-orange-100",
    icon: "⏳",
  },
  4: { label: "Rejected", color: "text-red-700", bg: "bg-red-100", icon: "❌" },
  5: {
    label: "Shipped",
    color: "text-purple-700",
    bg: "bg-purple-100",
    icon: "📦",
  },
  6: {
    label: "Cancelled",
    color: "text-gray-700",
    bg: "bg-gray-100",
    icon: "🚫",
  },
};

// ── Edit panel: profile + addresses ──────────────────────────────────────────
const CustomerEditSection: React.FC<{
  customer: Customer;
  onDone: () => void;
}> = ({ customer, onDone }) => {
  const [showAddAddress, setShowAddAddress] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [isSavingAddress, setIsSavingAddress] = useState(false);
  const {
    addresses,
    isLoading: addressesLoading,
    addAddress,
    updateAddress,
    deleteAddress,
  } = useAdminCustomerAddresses(customer.CustomerID);

  return (
    <div className="space-y-8">
      {/* Profile */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-4 flex items-center gap-2">
          <User className="w-4 h-4" /> Contact Information
        </h4>
        <div className="bg-white border-2 border-doodle-text/10 p-4">
          <AdminProfileForm
            businessEntityId={customer.CustomerID}
            onSaved={() => {
              toast.success("Profile updated");
              onDone();
            }}
            onCancel={onDone}
          />
        </div>
      </div>

      {/* Addresses */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-4 flex items-center gap-2">
          <MapPin className="w-4 h-4" /> Addresses
        </h4>

        {addressesLoading ? (
          <p className="font-doodle text-sm text-doodle-text/50 animate-pulse">
            Loading addresses…
          </p>
        ) : addresses.length === 0 ? (
          <p className="font-doodle text-sm text-doodle-text/60 mb-3">
            No addresses on file.
          </p>
        ) : (
          <div className="space-y-3 mb-4">
            {addresses.map((addr) =>
              editingAddressId === addr.id ? (
                <div
                  key={addr.id}
                  className="bg-white border-2 border-doodle-accent/40 p-4"
                >
                  <AdminAddressForm
                    address={addr}
                    isSaving={isSavingAddress}
                    onSave={async (updates) => {
                      setIsSavingAddress(true);
                      try {
                        await updateAddress(addr.id, updates);
                        setEditingAddressId(null);
                        toast.success("Address updated");
                      } catch {
                        toast.error("Failed to update address");
                      } finally {
                        setIsSavingAddress(false);
                      }
                    }}
                    onCancel={() => setEditingAddressId(null)}
                  />
                </div>
              ) : (
                <div
                  key={addr.id}
                  className="bg-white border-2 border-doodle-text/10 p-3 flex items-start justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-doodle text-sm font-bold text-doodle-text">
                        {addr.addressType}
                      </span>
                      {addr.isDefault && (
                        <span className="px-1.5 py-0.5 text-xs bg-doodle-green/20 text-doodle-green font-doodle border border-doodle-green/40">
                          Default
                        </span>
                      )}
                    </div>
                    <p className="font-doodle text-sm text-doodle-text">
                      {addr.addressLine1}
                      {addr.addressLine2 ? `, ${addr.addressLine2}` : ""}
                    </p>
                    <p className="font-doodle text-sm text-doodle-text/70">
                      {[addr.city, addr.stateProvinceCode, addr.postalCode]
                        .filter(Boolean)
                        .join(", ")}
                      {addr.countryName ? ` · ${addr.countryName}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setEditingAddressId(addr.id)}
                      className="p-1.5 text-doodle-text/60 hover:text-doodle-accent transition-colors"
                      title="Edit address"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm("Delete this address?")) return;
                        try {
                          await deleteAddress(addr.id);
                          toast.success("Address deleted");
                        } catch {
                          toast.error("Failed to delete address");
                        }
                      }}
                      className="p-1.5 text-doodle-text/60 hover:text-red-500 transition-colors"
                      title="Delete address"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>
        )}

        {showAddAddress ? (
          <div className="bg-white border-2 border-doodle-accent/40 p-4">
            <AdminAddressForm
              isSaving={isSavingAddress}
              onSave={async (address) => {
                setIsSavingAddress(true);
                try {
                  await addAddress(address);
                  setShowAddAddress(false);
                  toast.success("Address added");
                } catch {
                  toast.error("Failed to add address");
                } finally {
                  setIsSavingAddress(false);
                }
              }}
              onCancel={() => setShowAddAddress(false)}
            />
          </div>
        ) : (
          <button
            onClick={() => setShowAddAddress(true)}
            className="font-doodle text-sm text-doodle-accent border-2 border-dashed border-doodle-accent/40 px-4 py-2 hover:border-doodle-accent hover:bg-doodle-accent/5 transition-colors"
          >
            + Add Address
          </button>
        )}
      </div>

      {/* Email Addresses */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-4 flex items-center gap-2">
          <Mail className="w-4 h-4" /> Email Addresses
        </h4>
        <AdminEmailsPanel businessEntityId={customer.CustomerID} />
      </div>

      {/* Payment Methods */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-4 flex items-center gap-2">
          <CreditCard className="w-4 h-4" /> Payment Methods
        </h4>
        <AdminPaymentMethodsPanel businessEntityId={customer.CustomerID} />
      </div>

      {/* Password */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-4 flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> Password
        </h4>
        <AdminPasswordReset
          businessEntityId={customer.CustomerID}
          customerEmail={customer.EmailAddress}
        />
      </div>
    </div>
  );
};

// ── Expanded customer row with per-customer order history ─────────────────────
const ExpandedCustomerView: React.FC<{
  customer: Customer;
  onStartEdit: (c: Customer) => void;
}> = ({ customer, onStartEdit }) => {
  const { data: orders = [], isLoading } = useCustomerOrders(
    customer.SalesCustomerID,
  );

  return (
    <div className="space-y-6">
      {/* Contact Info */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
          <User className="w-4 h-4" /> Contact Information
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">Full Name</p>
            <p className="font-doodle text-doodle-text">
              {customer.FirstName} {customer.LastName}
            </p>
          </div>
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">Email</p>
            <p className="font-doodle text-doodle-text break-all">
              {customer.EmailAddress || (
                <span className="italic text-doodle-text/40">—</span>
              )}
            </p>
          </div>
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">Phone</p>
            <p className="font-doodle text-doodle-text">
              {customer.Phone || (
                <span className="italic text-doodle-text/40">—</span>
              )}
            </p>
          </div>
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">
              Customer ID
            </p>
            <p className="font-doodle text-doodle-text">
              #{customer.CustomerID}
              {customer.SalesCustomerID
                ? ` (Sales #${customer.SalesCustomerID})`
                : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Address */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
          <MapPin className="w-4 h-4" /> Address
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <p className="font-doodle text-sm text-doodle-text/60">Street</p>
            <p className="font-doodle text-doodle-text">
              {customer.AddressLine1 || (
                <span className="italic text-doodle-text/40">—</span>
              )}
            </p>
          </div>
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">City</p>
            <p className="font-doodle text-doodle-text">
              {customer.City || (
                <span className="italic text-doodle-text/40">—</span>
              )}
            </p>
          </div>
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">
              State / Province
            </p>
            <p className="font-doodle text-doodle-text">
              {customer.StateProvince || (
                <span className="italic text-doodle-text/40">—</span>
              )}
            </p>
          </div>
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">
              Postal Code
            </p>
            <p className="font-doodle text-doodle-text">
              {customer.PostalCode || (
                <span className="italic text-doodle-text/40">—</span>
              )}
            </p>
          </div>
          <div>
            <p className="font-doodle text-sm text-doodle-text/60">Country</p>
            <p className="font-doodle text-doodle-text flex items-center gap-2">
              <CountryFlag country={customer.Country} />
              {customer.Country || (
                <span className="italic text-doodle-text/40">—</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Order History */}
      <div>
        <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
          <ShoppingBag className="w-4 h-4" /> Order History
        </h4>
        {customer.SalesCustomerID == null ? (
          <p className="font-doodle text-doodle-text/60 text-sm">
            No linked sales account for this person.
          </p>
        ) : isLoading ? (
          <p className="font-doodle text-sm text-doodle-text/50 animate-pulse">
            Loading orders…
          </p>
        ) : orders.length === 0 ? (
          <p className="font-doodle text-doodle-text/60 text-sm">
            No orders found for this customer.
          </p>
        ) : (
          <div className="space-y-2">
            {orders.map((order) => {
              const statusCfg = DB_STATUS_LABELS[order.Status] ?? {
                label: `Status ${order.Status}`,
                color: "text-gray-700",
                bg: "bg-gray-100",
                icon: "❓",
              };
              return (
                <Link
                  key={order.SalesOrderID}
                  to={`/orders?orderId=${order.SalesOrderID}`}
                  onClick={(e) => e.stopPropagation()}
                  className="block p-3 border-2 border-doodle-text/20 bg-white hover:border-doodle-accent transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="font-doodle font-bold text-doodle-text">
                        #{order.SalesOrderID}
                      </span>
                      <span
                        className={`px-2 py-0.5 text-xs font-doodle ${statusCfg.bg} ${statusCfg.color}`}
                      >
                        {statusCfg.icon} {statusCfg.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="font-doodle text-sm text-doodle-text/60">
                        {new Date(order.OrderDate).toLocaleDateString()}
                      </span>
                      <span className="font-doodle font-bold text-doodle-green">
                        ${order.TotalDue.toFixed(2)}
                      </span>
                      <ExternalLink className="w-4 h-4 text-doodle-accent" />
                    </div>
                  </div>
                  {order.OrderItems.length > 0 && (
                    <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                      {order.OrderItems.length} item
                      {order.OrderItems.length !== 1 ? "s" : ""}:{" "}
                      {order.OrderItems.map((i) => i.ProductName).join(", ")}
                    </p>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onStartEdit(customer);
        }}
        className="doodle-btn flex items-center gap-2"
      >
        <Edit2 className="w-4 h-4" /> Edit Customer
      </button>
    </div>
  );
};

// ── Main page ─────────────────────────────────────────────────────────────────
const CustomersPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isSelectForOrderMode = searchParams.get("selectForOrder") === "true";
  const [dabCursor, setDabCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const { data: apiData, isLoading: customersLoading } =
    useAdminCustomers(dabCursor);
  const apiCustomers = React.useMemo(() => apiData?.items ?? [], [apiData]);

  const [searchQuery, setSearchQuery] = useState("");
  const [cityFilter, setCityFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [spentFilter, setSpentFilter] = useState("all");
  const [sortBy, setSortBy] = useState<
    "spend" | "newest" | "oldest" | "name-az" | "name-za"
  >("spend");
  const [expandedCustomerId, setExpandedCustomerId] = useState<number | null>(
    null,
  );
  const [editingCustomerId, setEditingCustomerId] = useState<number | null>(
    null,
  );
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(
    new Set(),
  );
  const [bulkEmailDialogOpen, setBulkEmailDialogOpen] = useState(false);
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);

  // Populate customers from API when loaded
  useEffect(() => {
    if (apiData?.items && apiData.items.length > 0) {
      setCustomers(apiData.items);
    }
  }, [apiData]);

  // Extract unique filter values from the loaded batch
  const uniqueCities = useMemo(
    () => [...new Set(customers.map((c) => c.City).filter(Boolean))].sort(),
    [customers],
  );
  const uniqueStates = useMemo(
    () =>
      [
        ...new Set(customers.map((c) => c.StateProvince).filter(Boolean)),
      ].sort(),
    [customers],
  );
  const uniqueCountries = useMemo(
    () => [...new Set(customers.map((c) => c.Country).filter(Boolean))].sort(),
    [customers],
  );

  const spentRanges = [
    { value: "all", label: "All Amounts" },
    { value: "0-1000", label: "Under $1,000" },
    { value: "1000-5000", label: "$1,000 – $5,000" },
    { value: "5000-10000", label: "$5,000 – $10,000" },
    { value: "10000+", label: "Over $10,000" },
  ];

  const filteredCustomers = customers.filter((c) => {
    const matchesSearch =
      searchQuery === "" ||
      c.FirstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.LastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.EmailAddress.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.Country.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.City.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCity = cityFilter === "all" || c.City === cityFilter;
    const matchesState =
      stateFilter === "all" || c.StateProvince === stateFilter;
    const matchesCountry =
      countryFilter === "all" || c.Country === countryFilter;

    // "All Amounts" always includes everyone (including customers with no orders).
    // Sub-ranges only filter customers who HAVE orders; customers with no orders always pass.
    let matchesSpent = true;
    if (spentFilter !== "all" && c.TotalSpent > 0) {
      if (spentFilter === "0-1000") matchesSpent = c.TotalSpent < 1000;
      else if (spentFilter === "1000-5000")
        matchesSpent = c.TotalSpent >= 1000 && c.TotalSpent < 5000;
      else if (spentFilter === "5000-10000")
        matchesSpent = c.TotalSpent >= 5000 && c.TotalSpent < 10000;
      else if (spentFilter === "10000+") matchesSpent = c.TotalSpent >= 10000;
    }

    return (
      matchesSearch &&
      matchesCity &&
      matchesState &&
      matchesCountry &&
      matchesSpent
    );
  });

  const sortedCustomers = useMemo(() => {
    const arr = [...filteredCustomers];
    switch (sortBy) {
      case "newest":
        return arr.sort((a, b) => b.CustomerID - a.CustomerID);
      case "oldest":
        return arr.sort((a, b) => a.CustomerID - b.CustomerID);
      case "name-az":
        return arr.sort(
          (a, b) =>
            a.LastName.localeCompare(b.LastName) ||
            a.FirstName.localeCompare(b.FirstName),
        );
      case "name-za":
        return arr.sort(
          (a, b) =>
            b.LastName.localeCompare(a.LastName) ||
            b.FirstName.localeCompare(a.FirstName),
        );
      default:
        return arr.sort((a, b) => b.TotalSpent - a.TotalSpent);
    }
  }, [filteredCustomers, sortBy]);

  const activeFiltersCount = [
    cityFilter,
    stateFilter,
    countryFilter,
    spentFilter,
  ].filter((f) => f !== "all").length;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const clearAllFilters = () => {
    setCityFilter("all");
    setStateFilter("all");
    setCountryFilter("all");
    setSpentFilter("all");
    setSearchQuery("");
  };

  const handleToggleExpand = (customerId: number) => {
    if (expandedCustomerId === customerId) {
      setExpandedCustomerId(null);
      setEditingCustomerId(null);
    } else {
      setExpandedCustomerId(customerId);
      setEditingCustomerId(null);
    }
  };

  const handleStartEdit = (customer: Customer) => {
    setEditingCustomerId(customer.CustomerID);
  };

  const handleCancelEdit = () => {
    setEditingCustomerId(null);
  };

  const toggleCustomerSelection = (e: React.MouseEvent, customerId: number) => {
    e.stopPropagation();
    setSelectedCustomerIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(customerId)) newSet.delete(customerId);
      else newSet.add(customerId);
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedCustomerIds.size === sortedCustomers.length) {
      setSelectedCustomerIds(new Set());
    } else {
      setSelectedCustomerIds(new Set(sortedCustomers.map((c) => c.CustomerID)));
    }
  };

  const selectedCustomers = customers.filter((c) =>
    selectedCustomerIds.has(c.CustomerID),
  );

  const handleBulkEmailComplete = () => {
    setSelectedCustomerIds(new Set());
    toast.success("Bulk email campaign completed!");
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            {/* Header row */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
              <h1 className="font-doodle text-3xl font-bold text-doodle-text">
                Customer Management
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                {/* Generate with AI */}
                <button
                  onClick={() => setGenerateDialogOpen(true)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 font-doodle text-sm bg-doodle-accent text-white border-2 border-doodle-text rounded transition-colors hover:bg-doodle-accent/90"
                >
                  <Sparkles className="w-4 h-4" />
                  Generate with AI
                </button>
                {/* Stats link */}
                <Link
                  to="/customer-stats"
                  className="inline-flex items-center gap-2 px-3 py-1.5 font-doodle text-sm text-doodle-text border-2 border-doodle-text rounded hover:bg-doodle-accent/10 transition-colors"
                >
                  <BarChart3 className="w-4 h-4" />
                  View Statistics
                </Link>
                {activeFiltersCount > 0 && (
                  <button
                    onClick={clearAllFilters}
                    className="inline-flex items-center gap-2 px-3 py-1.5 font-doodle text-sm text-doodle-red hover:bg-doodle-red/10 border-2 border-doodle-red rounded transition-colors"
                  >
                    <X className="w-4 h-4" />
                    Clear {activeFiltersCount} filter
                    {activeFiltersCount !== 1 ? "s" : ""}
                  </button>
                )}
              </div>
            </div>

            {/* Search */}
            <div className="flex flex-col lg:flex-row gap-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/50" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                  }}
                  placeholder="Search by name, email, city or country…"
                  className="w-full pl-10 pr-4 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                />
              </div>

              {/* Filters */}
              <div className="flex flex-wrap gap-3 items-center">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-doodle-text/60" />
                  <span className="font-doodle text-sm text-doodle-text/60">
                    Filters:
                  </span>
                </div>

                <Select
                  value={cityFilter}
                  onValueChange={(v) => {
                    setCityFilter(v);
                  }}
                >
                  <SelectTrigger className="w-36 font-doodle">
                    <SelectValue placeholder="City" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="font-doodle">
                      All Cities
                    </SelectItem>
                    {uniqueCities.map((city) => (
                      <SelectItem
                        key={city}
                        value={city}
                        className="font-doodle"
                      >
                        {city}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={stateFilter}
                  onValueChange={(v) => {
                    setStateFilter(v);
                  }}
                >
                  <SelectTrigger className="w-36 font-doodle">
                    <SelectValue placeholder="State" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="font-doodle">
                      All States
                    </SelectItem>
                    {uniqueStates.map((state) => (
                      <SelectItem
                        key={state}
                        value={state}
                        className="font-doodle"
                      >
                        {state}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={countryFilter}
                  onValueChange={(v) => {
                    setCountryFilter(v);
                  }}
                >
                  <SelectTrigger className="w-44 font-doodle">
                    <SelectValue placeholder="Country" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="font-doodle">
                      All Countries
                    </SelectItem>
                    {uniqueCountries.map((country) => (
                      <SelectItem
                        key={country}
                        value={country}
                        className="font-doodle"
                      >
                        <span className="flex items-center gap-2">
                          <CountryFlag country={country} /> {country}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={spentFilter}
                  onValueChange={(v) => {
                    setSpentFilter(v);
                  }}
                >
                  <SelectTrigger className="w-44 font-doodle">
                    <SelectValue placeholder="Total Spent" />
                  </SelectTrigger>
                  <SelectContent>
                    {spentRanges.map((range) => (
                      <SelectItem
                        key={range.value}
                        value={range.value}
                        className="font-doodle"
                      >
                        {range.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 mt-4">
              <p className="font-doodle text-sm text-doodle-text/60">
                Showing {filteredCustomers.length} customer
                {filteredCustomers.length !== 1 ? "s" : ""}
                {customersLoading && " (loading…)"}
              </p>
              <div className="flex items-center gap-2">
                <ArrowUpDown className="w-3 h-3 text-doodle-text/40" />
                <Select
                  value={sortBy}
                  onValueChange={(v) => setSortBy(v as typeof sortBy)}
                >
                  <SelectTrigger className="h-7 text-xs font-doodle border-doodle-text/30 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="spend" className="font-doodle text-xs">
                      Highest spend
                    </SelectItem>
                    <SelectItem value="newest" className="font-doodle text-xs">
                      Newest customers
                    </SelectItem>
                    <SelectItem value="oldest" className="font-doodle text-xs">
                      Longest established
                    </SelectItem>
                    <SelectItem value="name-az" className="font-doodle text-xs">
                      Name A → Z
                    </SelectItem>
                    <SelectItem value="name-za" className="font-doodle text-xs">
                      Name Z → A
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12">
          {/* Select for Order mode banner */}
          {isSelectForOrderMode && (
            <div className="mb-4 flex items-center justify-between gap-4 p-3 bg-doodle-accent/10 border-2 border-doodle-accent">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-doodle-accent shrink-0" />
                <span className="font-doodle text-sm font-bold text-doodle-text">
                  Select a customer to generate an AI order for
                </span>
              </div>
              <Link
                to="/generate-order"
                className="font-doodle text-xs text-doodle-text/60 hover:text-doodle-text underline shrink-0"
              >
                Cancel
              </Link>
            </div>
          )}

          {/* Bulk Actions Bar */}
          <div className="doodle-card p-3 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={toggleSelectAll}
                className="font-doodle text-sm flex items-center gap-2 hover:text-doodle-accent transition-colors"
              >
                {selectedCustomerIds.size === sortedCustomers.length &&
                sortedCustomers.length > 0 ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                {selectedCustomerIds.size > 0
                  ? `${selectedCustomerIds.size} selected`
                  : "Select all"}
              </button>
            </div>
            {selectedCustomerIds.size > 0 && (
              <button
                onClick={() => setBulkEmailDialogOpen(true)}
                className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
              >
                <Sparkles className="w-4 h-4" />
                AI Email Campaign ({selectedCustomerIds.size})
              </button>
            )}
          </div>

          {/* Customer list */}
          <div className="space-y-4">
            {customersLoading && customers.length === 0 ? (
              [...Array(5)].map((_, i) => (
                <div key={i} className="doodle-card p-4 animate-pulse">
                  <div className="h-5 bg-doodle-text/10 rounded w-1/3 mb-2" />
                  <div className="h-4 bg-doodle-text/10 rounded w-1/2" />
                </div>
              ))
            ) : sortedCustomers.length === 0 ? (
              <div className="doodle-card p-8 text-center">
                <p className="font-doodle text-doodle-text/60">
                  No customers match your filters.
                </p>
              </div>
            ) : (
              sortedCustomers.map((customer) => {
                const isExpanded = expandedCustomerId === customer.CustomerID;
                const isEditing = editingCustomerId === customer.CustomerID;
                const isSelected = selectedCustomerIds.has(customer.CustomerID);

                return (
                  <div
                    key={customer.CustomerID}
                    className={`doodle-card overflow-hidden transition-all ${isSelected ? "ring-2 ring-doodle-accent" : ""}`}
                  >
                    <div
                      className="p-4 cursor-pointer hover:bg-doodle-accent/5 transition-colors"
                      onClick={() => handleToggleExpand(customer.CustomerID)}
                    >
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => {}}
                            onClick={(e) =>
                              toggleCustomerSelection(e, customer.CustomerID)
                            }
                            className="mt-1"
                          />
                          <div>
                            <h3 className="font-doodle text-lg font-bold text-doodle-text flex items-center gap-2">
                              <User className="w-5 h-5" />
                              {customer.FirstName} {customer.LastName}
                            </h3>
                            <div className="flex flex-wrap gap-4 mt-2 text-sm">
                              {customer.EmailAddress && (
                                <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                                  <Mail className="w-4 h-4" />{" "}
                                  {customer.EmailAddress}
                                </span>
                              )}
                              {customer.Phone && (
                                <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                                  <Phone className="w-4 h-4" /> {customer.Phone}
                                </span>
                              )}
                              {(customer.City || customer.StateProvince) && (
                                <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                                  <MapPin className="w-4 h-4" />
                                  {[customer.City, customer.StateProvince]
                                    .filter(Boolean)
                                    .join(", ")}
                                </span>
                              )}
                              {customer.Country && (
                                <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                                  <CountryFlag country={customer.Country} />{" "}
                                  {customer.Country}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className="font-doodle text-sm text-doodle-text/60">
                              {customer.TotalOrders > 0
                                ? `${customer.TotalOrders} orders`
                                : "No orders"}
                            </p>
                            {customer.TotalSpent > 0 && (
                              <p className="font-doodle font-bold text-doodle-green">
                                ${customer.TotalSpent.toFixed(2)}
                              </p>
                            )}
                          </div>
                          {isSelectForOrderMode ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate("/generate-order", {
                                  state: {
                                    customerId: customer.SalesCustomerID,
                                    firstName: customer.FirstName,
                                    lastName: customer.LastName,
                                    email: customer.EmailAddress,
                                    orderCount: customer.TotalOrders,
                                    totalSpend: customer.TotalSpent,
                                  },
                                });
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 font-doodle text-sm bg-doodle-accent text-white border-2 border-doodle-text rounded transition-colors hover:bg-doodle-accent/90 shrink-0"
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                              Select
                            </button>
                          ) : (
                            <button
                              type="button"
                              title="Generate Order with AI"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate("/generate-order", {
                                  state: {
                                    customerId: customer.SalesCustomerID,
                                    firstName: customer.FirstName,
                                    lastName: customer.LastName,
                                    email: customer.EmailAddress,
                                    orderCount: customer.TotalOrders,
                                    totalSpend: customer.TotalSpent,
                                  },
                                });
                              }}
                              className="p-1.5 text-doodle-text/40 hover:text-doodle-accent transition-colors shrink-0"
                            >
                              <Sparkles className="w-4 h-4" />
                            </button>
                          )}
                          {isExpanded ? (
                            <ChevronUp className="w-5 h-5 text-doodle-text/50" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-doodle-text/50" />
                          )}
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="border-t-2 border-doodle-text/10 p-4 bg-doodle-accent/5">
                        {isEditing ? (
                          <CustomerEditSection
                            customer={customer}
                            onDone={handleCancelEdit}
                          />
                        ) : (
                          <ExpandedCustomerView
                            customer={customer}
                            onStartEdit={handleStartEdit}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* DAB batch navigation */}
          {(cursorStack.length > 0 || apiData?.hasNextPage) && (
            <div className="doodle-card p-4 mt-6 flex items-center justify-between">
              <button
                onClick={() => {
                  const prev = cursorStack[cursorStack.length - 1] ?? null;
                  setCursorStack((s) => s.slice(0, -1));
                  setDabCursor(prev);
                }}
                disabled={cursorStack.length === 0}
                className="inline-flex items-center gap-1 p-2 font-doodle text-sm disabled:opacity-40"
              >
                <ChevronLeft className="w-5 h-5" /> Previous 100
              </button>
              <span className="font-doodle text-sm text-doodle-text/60">
                Batch {cursorStack.length + 1}
              </span>
              <button
                onClick={() => {
                  setCursorStack((s) => [...s, dabCursor ?? ""]);
                  setDabCursor(apiData!.endCursor);
                }}
                disabled={!apiData?.hasNextPage}
                className="inline-flex items-center gap-1 p-2 font-doodle text-sm disabled:opacity-40"
              >
                Next 100 <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}
        </section>
      </main>
      <Footer />

      <BulkAiEmailDialog
        open={bulkEmailDialogOpen}
        onOpenChange={setBulkEmailDialogOpen}
        selectedCustomers={selectedCustomers}
        onComplete={handleBulkEmailComplete}
      />

      <GenerateCustomerWithAIDialog
        open={generateDialogOpen}
        onOpenChange={setGenerateDialogOpen}
        onCustomerGenerated={() => {
          toast.success(
            "New AI customer generated! Refresh to see them in the list.",
          );
        }}
      />
    </div>
  );
};

export default CustomersPage;
