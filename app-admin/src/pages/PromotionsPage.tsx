import React, { useState, useMemo } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Plus,
  Search,
  X,
  Percent,
  Calendar,
  Package,
  Edit2,
  Trash2,
  Tag,
  Filter,
  Link,
  ExternalLink,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  SpecialOffer,
  getOfferStatus,
  OFFER_TYPES,
  OFFER_CATEGORIES,
  DEFAULT_CULTURE_ID,
} from "@/types/promotion";
import { translatePromotion } from "@/services/utilityService";
import {
  useAdminSpecialOffers,
  useAdminSpecialOfferProducts,
  useCreateSpecialOffer,
  useUpdateSpecialOffer,
  useDeleteSpecialOffer,
  useAssignSpecialOfferProducts,
} from "@/hooks/useAdminPromotions";
import { useAdminAllProducts } from "@/hooks/useAdminProducts";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ProductAssignmentDialog from "@/components/ProductAssignmentDialog";
import GeneratePromotionWizardDialog from "@/components/GeneratePromotionWizardDialog";
import { Label } from "@/components/ui/label";
import { getAppUrl } from "@/lib/utils";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PromotionsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const { data: apiPromotions = [] } = useAdminSpecialOffers();
  const { data: apiOfferProducts = [] } = useAdminSpecialOfferProducts();
  const { data: products = [] } = useAdminAllProducts();
  const createOffer = useCreateSpecialOffer();
  const updateOffer = useUpdateSpecialOffer();
  const deleteOffer = useDeleteSpecialOffer();
  const assignProducts = useAssignSpecialOfferProducts();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("Customer");
  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isProductDialogOpen, setIsProductDialogOpen] = useState(false);
  const [selectedPromotion, setSelectedPromotion] =
    useState<SpecialOffer | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    CultureID: DEFAULT_CULTURE_ID,
    Description: "",
    DiscountPct: 0,
    Type: "Promotional Discount",
    Category: "Customer",
    StartDate: "",
    EndDate: "",
    MinQty: 0,
    MaxQty: null as number | null,
  });

  const filteredPromotions = useMemo(() => {
    return (
      apiPromotions
        .filter((promo) => {
          // Only show US English promotions — other cultures are managed automatically
          if (promo.CultureID !== DEFAULT_CULTURE_ID) return false;

          // Search filter
          const searchLower = searchQuery.toLowerCase();
          const matchesSearch =
            promo.Description.toLowerCase().includes(searchLower) ||
            promo.Type.toLowerCase().includes(searchLower) ||
            promo.Category.toLowerCase().includes(searchLower);

          // Status filter
          const status = getOfferStatus(promo);
          const matchesStatus =
            statusFilter === "all" || status === statusFilter;

          // Type filter
          const matchesType = typeFilter === "all" || promo.Type === typeFilter;

          // Category filter
          const matchesCategory =
            categoryFilter === "all" || promo.Category === categoryFilter;

          return (
            matchesSearch && matchesStatus && matchesType && matchesCategory
          );
        })
        // Most recently created first
        .sort((a, b) => b.SpecialOfferID - a.SpecialOfferID)
    );
  }, [apiPromotions, searchQuery, statusFilter, typeFilter, categoryFilter]);

  const resetForm = () => {
    setFormData({
      CultureID: DEFAULT_CULTURE_ID,
      Description: "",
      DiscountPct: 0,
      Type: "Promotional Discount",
      Category: "Customer",
      StartDate: "",
      EndDate: "",
      MinQty: 0,
      MaxQty: null,
    });
  };

  const openCreateDialog = () => {
    resetForm();
    setIsCreateDialogOpen(true);
  };

  const openEditDialog = (promo: SpecialOffer) => {
    setSelectedPromotion(promo);
    setFormData({
      CultureID: promo.CultureID,
      Description: promo.Description,
      DiscountPct: promo.DiscountPct * 100,
      Type: promo.Type,
      Category: promo.Category,
      StartDate: promo.StartDate.split("T")[0],
      EndDate: promo.EndDate.split("T")[0],
      MinQty: promo.MinQty,
      MaxQty: promo.MaxQty,
    });
    setIsEditDialogOpen(true);
  };

  const openDeleteDialog = (promo: SpecialOffer) => {
    setSelectedPromotion(promo);
    setIsDeleteDialogOpen(true);
  };

  const handleCreate = () => {
    // Use only English US promotions as the authoritative set for the next ID
    const englishPromotions = apiPromotions.filter(
      (p) => p.CultureID === DEFAULT_CULTURE_ID,
    );
    const nextId =
      englishPromotions.length > 0
        ? Math.max(...englishPromotions.map((p) => p.SpecialOfferID)) + 1
        : 2; // ID 1 is reserved for "No Discount"
    const translationPayload = {
      specialOfferID: nextId,
      description: formData.Description,
      discountPct: formData.DiscountPct / 100,
      type: formData.Type,
      category: formData.Category,
      startDate: `${formData.StartDate}T00:00:00`,
      endDate: `${formData.EndDate}T00:00:00`,
      minQty: formData.MinQty,
      maxQty: formData.MaxQty,
    };
    createOffer.mutate(
      {
        SpecialOfferID: nextId,
        CultureID: DEFAULT_CULTURE_ID,
        Description: formData.Description,
        DiscountPct: formData.DiscountPct / 100,
        Type: formData.Type,
        Category: formData.Category,
        StartDate: `${formData.StartDate}T00:00:00`,
        EndDate: `${formData.EndDate}T00:00:00`,
        MinQty: formData.MinQty,
        MaxQty: formData.MaxQty,
      },
      {
        onSuccess: () => {
          setIsCreateDialogOpen(false);
          toast({
            title: "Promotion Created",
            description: `"${formData.Description}" has been created successfully.`,
          });
          resetForm();
          // Fire-and-forget translation to all other cultures
          translatePromotion(translationPayload).catch(() => {
            toast({
              title: "Translation Warning",
              description:
                "Promotion created, but automatic translation to other languages failed. Please retry or contact support.",
              variant: "destructive",
            });
          });
        },
      },
    );
  };

  const handleUpdate = () => {
    if (!selectedPromotion) return;
    const translationPayload = {
      specialOfferID: selectedPromotion.SpecialOfferID,
      description: formData.Description,
      discountPct: formData.DiscountPct / 100,
      type: formData.Type,
      category: formData.Category,
      startDate: `${formData.StartDate}T00:00:00`,
      endDate: `${formData.EndDate}T00:00:00`,
      minQty: formData.MinQty,
      maxQty: formData.MaxQty,
    };
    updateOffer.mutate(
      {
        id: selectedPromotion.SpecialOfferID,
        CultureID: DEFAULT_CULTURE_ID,
        Description: formData.Description,
        DiscountPct: formData.DiscountPct / 100,
        Type: formData.Type,
        Category: formData.Category,
        StartDate: `${formData.StartDate}T00:00:00`,
        EndDate: `${formData.EndDate}T00:00:00`,
        MinQty: formData.MinQty,
        MaxQty: formData.MaxQty,
      },
      {
        onSuccess: () => {
          setIsEditDialogOpen(false);
          toast({
            title: "Promotion Updated",
            description: `"${formData.Description}" has been updated successfully.`,
          });
          setSelectedPromotion(null);
          // Fire-and-forget translation to all other cultures
          translatePromotion(translationPayload).catch(() => {
            toast({
              title: "Translation Warning",
              description:
                "Promotion updated, but automatic translation to other languages failed. Please retry or contact support.",
              variant: "destructive",
            });
          });
        },
      },
    );
  };

  const handleDelete = () => {
    if (!selectedPromotion) return;
    const productIds = getAssignedProductIds(selectedPromotion.SpecialOfferID);
    // Collect all culture variants for this SpecialOfferID so they are all deleted
    const allCultureIds = apiPromotions
      .filter((p) => p.SpecialOfferID === selectedPromotion.SpecialOfferID)
      .map((p) => p.CultureID);
    deleteOffer.mutate(
      {
        id: selectedPromotion.SpecialOfferID,
        cultureIds: allCultureIds,
        productIds,
      },
      {
        onSuccess: () => {
          setIsDeleteDialogOpen(false);
          toast({
            title: "Promotion Deleted",
            description: `"${selectedPromotion.Description}" has been deleted.`,
            variant: "destructive",
          });
          setSelectedPromotion(null);
        },
        onError: () => {
          setIsDeleteDialogOpen(false);
          toast({
            title: "Delete Failed",
            description:
              "This promotion cannot be deleted because it is referenced by existing sales orders.",
            variant: "destructive",
          });
          setSelectedPromotion(null);
        },
      },
    );
  };

  const openProductDialog = (promo: SpecialOffer) => {
    setSelectedPromotion(promo);
    setIsProductDialogOpen(true);
  };

  const handleProductAssignment = (productIds: number[]) => {
    if (!selectedPromotion) return;
    const currentProductIds = getAssignedProductIds(
      selectedPromotion.SpecialOfferID,
    );
    assignProducts.mutate(
      {
        offerId: selectedPromotion.SpecialOfferID,
        newProductIds: productIds,
        currentProductIds,
      },
      {
        onSuccess: () => {
          toast({
            title: "Products Updated",
            description: `${productIds.length} products assigned to "${selectedPromotion.Description}".`,
          });
          setSelectedPromotion(null);
        },
      },
    );
  };

  const getAssignedProductCount = (offerId: number): number => {
    return apiOfferProducts.filter((op) => op.SpecialOfferID === offerId)
      .length;
  };

  const getAssignedProductIds = (offerId: number): number[] => {
    return apiOfferProducts
      .filter((op) => op.SpecialOfferID === offerId)
      .map((op) => op.ProductID);
  };

  const clearFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setTypeFilter("all");
    setCategoryFilter("all");
  };

  const hasActiveFilters =
    searchQuery ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    categoryFilter !== "all";

  // Stats computed from English (US) promotions only
  const englishPromotions = apiPromotions.filter(
    (p) => p.CultureID === DEFAULT_CULTURE_ID,
  );
  const activeCount = englishPromotions.filter(
    (p) => getOfferStatus(p) === "active",
  ).length;
  const upcomingCount = englishPromotions.filter(
    (p) => getOfferStatus(p) === "upcoming",
  ).length;
  const expiredCount = englishPromotions.filter(
    (p) => getOfferStatus(p) === "expired",
  ).length;

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col bg-doodle-bg">
        <AdminHeader />
        <main className="flex-1 flex items-center justify-center p-4">
          <div className="doodle-card p-8 text-center">
            <p className="font-doodle text-doodle-text">
              Please log in to manage promotions.
            </p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-doodle-bg">
      <AdminHeader />
      <main className="flex-1 container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <div>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-3">
              <Tag className="w-8 h-8 text-doodle-accent" />
              Sales Promotions
            </h1>
            <p className="font-doodle text-doodle-text/60 mt-1">
              Manage discounts and special offers
            </p>
          </div>
          <div className="flex items-center gap-2">
            <GeneratePromotionWizardDialog existingOffers={apiPromotions} />
            <Button
              onClick={openCreateDialog}
              className="doodle-button doodle-button-primary flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />+ Create Promotion
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="doodle-card p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-doodle-green/20 border-2 border-doodle-text flex items-center justify-center">
                <Percent className="w-5 h-5 text-doodle-green" />
              </div>
              <div>
                <p className="font-doodle text-2xl font-bold text-doodle-text">
                  {activeCount}
                </p>
                <p className="font-doodle text-sm text-doodle-text/60">
                  Active
                </p>
              </div>
            </div>
          </div>
          <div className="doodle-card p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-doodle-blue/20 border-2 border-doodle-text flex items-center justify-center">
                <Calendar className="w-5 h-5 text-doodle-blue" />
              </div>
              <div>
                <p className="font-doodle text-2xl font-bold text-doodle-text">
                  {upcomingCount}
                </p>
                <p className="font-doodle text-sm text-doodle-text/60">
                  Upcoming
                </p>
              </div>
            </div>
          </div>
          <div className="doodle-card p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-doodle-text/10 border-2 border-doodle-text flex items-center justify-center">
                <Package className="w-5 h-5 text-doodle-text/60" />
              </div>
              <div>
                <p className="font-doodle text-2xl font-bold text-doodle-text">
                  {expiredCount}
                </p>
                <p className="font-doodle text-sm text-doodle-text/60">
                  Expired
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="doodle-card p-4 mb-6">
          <div className="flex flex-col lg:flex-row gap-4">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-doodle-text/40" />
              <Input
                placeholder="Search promotions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="doodle-input pl-10 w-full"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-doodle-text/40 hover:text-doodle-text"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Status Filter */}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="doodle-input w-full lg:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="upcoming">Upcoming</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>

            {/* Type Filter */}
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="doodle-input w-full lg:w-48">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {OFFER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Category Filter */}
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="doodle-input w-full lg:w-40">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {OFFER_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {hasActiveFilters && (
              <Button
                variant="ghost"
                onClick={clearFilters}
                className="font-doodle text-doodle-accent hover:text-doodle-green"
              >
                <Filter className="w-4 h-4 mr-1" />
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Results count */}
        <p className="font-doodle text-sm text-doodle-text/60 mb-4">
          Showing {filteredPromotions.length} promotions
        </p>

        {/* Promotions Grid */}
        {filteredPromotions.length === 0 ? (
          <div className="doodle-card p-8 text-center">
            <Tag className="w-12 h-12 text-doodle-text/30 mx-auto mb-4" />
            <p className="font-doodle text-doodle-text/60">
              No promotions found matching your criteria.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredPromotions.map((promo) => {
              const status = getOfferStatus(promo);
              const discountPercent = (promo.DiscountPct * 100).toFixed(0);
              const productCount = getAssignedProductCount(
                promo.SpecialOfferID,
              );

              return (
                <div
                  key={promo.SpecialOfferID}
                  className="doodle-card p-5 flex flex-col"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                      <h3 className="font-doodle font-bold text-doodle-text text-lg leading-tight">
                        {promo.Description}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`font-doodle text-xs px-2 py-0.5 border-2 border-doodle-text ${
                            status === "active"
                              ? "bg-doodle-green/20 text-doodle-green"
                              : status === "upcoming"
                                ? "bg-doodle-blue/20 text-doodle-blue"
                                : "bg-doodle-text/10 text-doodle-text/60"
                          }`}
                        >
                          {status.charAt(0).toUpperCase() + status.slice(1)}
                        </span>
                        <span className="font-doodle text-xs text-doodle-text/50">
                          #{promo.SpecialOfferID}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="font-doodle text-2xl font-bold text-doodle-accent">
                        {discountPercent}%
                      </span>
                      <p className="font-doodle text-xs text-doodle-text/50">
                        off
                      </p>
                    </div>
                  </div>

                  {/* Details */}
                  <div className="flex-1 space-y-2 mb-4">
                    <div className="flex items-center gap-2">
                      <span className="font-doodle text-xs text-doodle-text/60 w-16">
                        Type:
                      </span>
                      <span className="font-doodle text-sm text-doodle-text">
                        {promo.Type}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-doodle text-xs text-doodle-text/60 w-16">
                        Category:
                      </span>
                      <span className="font-doodle text-sm text-doodle-text">
                        {promo.Category}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-doodle text-xs text-doodle-text/60 w-16">
                        Qty:
                      </span>
                      <span className="font-doodle text-sm text-doodle-text">
                        {promo.MinQty}
                        {promo.MaxQty ? ` - ${promo.MaxQty}` : "+"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-doodle text-xs text-doodle-text/60 w-16">
                        Period:
                      </span>
                      <span className="font-doodle text-xs text-doodle-text">
                        {new Date(promo.StartDate).toLocaleDateString()} -{" "}
                        {new Date(promo.EndDate).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-doodle text-xs text-doodle-text/60 w-16">
                        Products:
                      </span>
                      <button
                        onClick={() => openProductDialog(promo)}
                        className="font-doodle text-sm text-doodle-blue hover:underline flex items-center gap-1"
                      >
                        <Link className="w-3 h-3" />
                        {productCount}{" "}
                        {productCount === 1 ? "product" : "products"}
                      </button>
                    </div>
                    {/* Assigned product chips */}
                    {productCount > 0 &&
                      (() => {
                        const appUrl = getAppUrl();
                        const assignedIds = getAssignedProductIds(
                          promo.SpecialOfferID,
                        );
                        const assignedProducts = assignedIds
                          .map((id) => products.find((p) => p.ProductID === id))
                          .filter(Boolean) as typeof products;
                        const visible = assignedProducts.slice(0, 5);
                        return (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {visible.map((p) => (
                              <span
                                key={p.ProductID}
                                className="inline-flex items-center gap-1 font-doodle text-xs bg-doodle-text/10 border border-doodle-text/20 px-2 py-0.5"
                              >
                                <RouterLink
                                  to={`/product/${p.ProductID}`}
                                  className="hover:underline"
                                  title="Edit in admin"
                                >
                                  {p.Name}
                                </RouterLink>
                                {appUrl && (
                                  <a
                                    href={`${appUrl}/product/${p.ProductID}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="View in customer app"
                                    className="text-doodle-blue hover:text-doodle-blue/70"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                              </span>
                            ))}
                            {assignedProducts.length > 5 && (
                              <span className="font-doodle text-xs text-doodle-text/50 self-center">
                                +{assignedProducts.length - 5} more
                              </span>
                            )}
                          </div>
                        );
                      })()}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 pt-3 border-t-2 border-doodle-text/20">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openProductDialog(promo)}
                      className="flex-1 font-doodle text-doodle-blue hover:bg-doodle-blue/10"
                    >
                      <Package className="w-4 h-4 mr-1" />
                      Products
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditDialog(promo)}
                      disabled={promo.SpecialOfferID === 1}
                      className="flex-1 font-doodle text-doodle-text hover:bg-doodle-text/10 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Edit2 className="w-4 h-4 mr-1" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openDeleteDialog(promo)}
                      disabled={promo.SpecialOfferID === 1}
                      className="flex-1 font-doodle text-doodle-accent hover:bg-doodle-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-4 h-4 mr-1" />
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
      <Footer />

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="bg-doodle-bg border-[3px] border-doodle-text max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-doodle text-xl text-doodle-text">
              Create New Promotion
            </DialogTitle>
            <DialogDescription className="font-doodle text-doodle-text/60">
              Set up a new sales promotion or discount offer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label className="font-doodle text-doodle-text">
                Description
              </Label>
              <Input
                value={formData.Description}
                onChange={(e) =>
                  setFormData({ ...formData, Description: e.target.value })
                }
                className="doodle-input mt-1"
                placeholder="e.g., Summer Sale 2025"
              />
              <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                English (US) — will be auto-translated to all other languages
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="font-doodle text-doodle-text">
                  Discount %
                </Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.DiscountPct}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      DiscountPct: parseFloat(e.target.value) || 0,
                    })
                  }
                  className="doodle-input mt-1"
                />
              </div>
              <div>
                <Label className="font-doodle text-doodle-text">Type</Label>
                <Select
                  value={formData.Type}
                  onValueChange={(v) => setFormData({ ...formData, Type: v })}
                >
                  <SelectTrigger className="doodle-input mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OFFER_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="font-doodle text-doodle-text">Category</Label>
              <Select
                value={formData.Category}
                onValueChange={(v) => setFormData({ ...formData, Category: v })}
              >
                <SelectTrigger className="doodle-input mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFER_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="font-doodle text-doodle-text">
                  Start Date
                </Label>
                <Input
                  type="date"
                  value={formData.StartDate}
                  onChange={(e) =>
                    setFormData({ ...formData, StartDate: e.target.value })
                  }
                  className="doodle-input mt-1"
                />
              </div>
              <div>
                <Label className="font-doodle text-doodle-text">End Date</Label>
                <Input
                  type="date"
                  value={formData.EndDate}
                  onChange={(e) =>
                    setFormData({ ...formData, EndDate: e.target.value })
                  }
                  className="doodle-input mt-1"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="font-doodle text-doodle-text">
                  Min Quantity
                </Label>
                <Input
                  type="number"
                  min="0"
                  value={formData.MinQty}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      MinQty: parseInt(e.target.value) || 0,
                    })
                  }
                  className="doodle-input mt-1"
                />
              </div>
              <div>
                <Label className="font-doodle text-doodle-text">
                  Max Quantity (optional)
                </Label>
                <Input
                  type="number"
                  min="0"
                  value={formData.MaxQty ?? ""}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      MaxQty: e.target.value ? parseInt(e.target.value) : null,
                    })
                  }
                  className="doodle-input mt-1"
                  placeholder="No limit"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setIsCreateDialogOpen(false)}
              className="font-doodle"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                !formData.Description ||
                !formData.StartDate ||
                !formData.EndDate ||
                createOffer.isPending
              }
              className="doodle-button doodle-button-primary"
            >
              {createOffer.isPending ? "Creating..." : "Create Promotion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="bg-doodle-bg border-[3px] border-doodle-text max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-doodle text-xl text-doodle-text">
              Edit Promotion
            </DialogTitle>
            <DialogDescription className="font-doodle text-doodle-text/60">
              Update the promotion details.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label className="font-doodle text-doodle-text">
                Description
              </Label>
              <Input
                value={formData.Description}
                onChange={(e) =>
                  setFormData({ ...formData, Description: e.target.value })
                }
                className="doodle-input mt-1"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="font-doodle text-doodle-text">
                  Discount %
                </Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.DiscountPct}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      DiscountPct: parseFloat(e.target.value) || 0,
                    })
                  }
                  className="doodle-input mt-1"
                />
              </div>
              <div>
                <Label className="font-doodle text-doodle-text">Type</Label>
                <Select
                  value={formData.Type}
                  onValueChange={(v) => setFormData({ ...formData, Type: v })}
                >
                  <SelectTrigger className="doodle-input mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OFFER_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="font-doodle text-doodle-text">Category</Label>
              <Select
                value={formData.Category}
                onValueChange={(v) => setFormData({ ...formData, Category: v })}
              >
                <SelectTrigger className="doodle-input mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFER_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="font-doodle text-doodle-text">
                  Start Date
                </Label>
                <Input
                  type="date"
                  value={formData.StartDate}
                  onChange={(e) =>
                    setFormData({ ...formData, StartDate: e.target.value })
                  }
                  className="doodle-input mt-1"
                />
              </div>
              <div>
                <Label className="font-doodle text-doodle-text">End Date</Label>
                <Input
                  type="date"
                  value={formData.EndDate}
                  onChange={(e) =>
                    setFormData({ ...formData, EndDate: e.target.value })
                  }
                  className="doodle-input mt-1"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="font-doodle text-doodle-text">
                  Min Quantity
                </Label>
                <Input
                  type="number"
                  min="0"
                  value={formData.MinQty}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      MinQty: parseInt(e.target.value) || 0,
                    })
                  }
                  className="doodle-input mt-1"
                />
              </div>
              <div>
                <Label className="font-doodle text-doodle-text">
                  Max Quantity (optional)
                </Label>
                <Input
                  type="number"
                  min="0"
                  value={formData.MaxQty ?? ""}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      MaxQty: e.target.value ? parseInt(e.target.value) : null,
                    })
                  }
                  className="doodle-input mt-1"
                  placeholder="No limit"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setIsEditDialogOpen(false)}
              className="font-doodle"
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdate}
              disabled={
                !formData.Description ||
                !formData.StartDate ||
                !formData.EndDate ||
                updateOffer.isPending
              }
              className="doodle-button doodle-button-accent"
            >
              {updateOffer.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent className="bg-doodle-bg border-[3px] border-doodle-text">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-doodle text-xl text-doodle-text">
              Delete Promotion?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-doodle text-doodle-text/70">
              Are you sure you want to delete "{selectedPromotion?.Description}
              "? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-doodle">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteOffer.isPending}
              className="doodle-button doodle-button-primary"
            >
              {deleteOffer.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Product Assignment Dialog */}
      <ProductAssignmentDialog
        open={isProductDialogOpen}
        onOpenChange={setIsProductDialogOpen}
        promotionName={selectedPromotion?.Description || ""}
        assignedProductIds={
          selectedPromotion
            ? getAssignedProductIds(selectedPromotion.SpecialOfferID)
            : []
        }
        onSave={handleProductAssignment}
      />
    </div>
  );
};

export default PromotionsPage;
