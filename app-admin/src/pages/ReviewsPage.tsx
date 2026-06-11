import React, { useState, useMemo, useEffect } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Star,
  Trash2,
  CheckCircle,
  MessageSquare,
  Minus,
  Loader2,
  Filter,
  X,
  Search,
  Square,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import {
  useAdminReviews,
  useAdminReviewsByProduct,
  useReviewTotalCount,
  approveReview,
  deleteReview,
} from "@/hooks/useAdminReviews";
import {
  useAdminAllProducts,
  useAdminCategories,
  useAdminAllSubcategories,
} from "@/hooks/useAdminProducts";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { getAppUrl } from "@/lib/utils";

interface ReviewWithAI {
  id: string;
  productId: number;
  userName: string;
  rating: number;
  title: string;
  comment: string;
  createdAt: string;
  helpful: number;
  markedUsefulBy: string[];
  isModerated: boolean;
  existingReply?: {
    replyId: number;
    text: string;
    by: string;
    date: string;
  };
}

// ─── AI analysis is performed server-side via POST /api/reviews/analyze-batch

const ReviewsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [dabCursor, setDabCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const urlProductId = searchParams.get("productId");
  const urlProductIdNum = urlProductId ? parseInt(urlProductId, 10) : null;

  // When a specific product is selected via URL, use a server-side filtered query
  // so we get ALL reviews for that product (not just the current cursor page).
  const { data: productApiData, isLoading: productReviewsLoading } =
    useAdminReviewsByProduct(urlProductIdNum);
  const { data: apiData, isLoading: generalReviewsLoading } = useAdminReviews(
    urlProductIdNum ? null : dabCursor,
  );
  const isLoading = urlProductIdNum
    ? productReviewsLoading
    : generalReviewsLoading;
  const { data: totalReviewCount } = useReviewTotalCount();
  const { data: allProducts = [] } = useAdminAllProducts();
  const { data: allCategories = [] } = useAdminCategories();
  const { data: allSubcategories = [] } = useAdminAllSubcategories();
  const productMap = useMemo(
    () => new Map(allProducts.map((p) => [p.ProductID, p])),
    [allProducts],
  );
  const [reviews, setReviews] = useState<ReviewWithAI[]>([]);

  // Sync from API when cursor changes or data first loads.
  // When a product is selected via URL, use the product-filtered query result.
  useEffect(() => {
    const activeData = urlProductIdNum ? productApiData : apiData;
    const items = activeData?.items;
    if (items && items.length > 0) {
      setReviews(items.map((item) => item as ReviewWithAI));
    } else if (items && items.length === 0 && urlProductIdNum) {
      // Product query returned empty – clear the list so we don't show stale data
      setReviews([]);
    }
  }, [apiData, productApiData, urlProductIdNum]);

  // Bulk selection states
  const [selectedReviews, setSelectedReviews] = useState<Set<string>>(
    new Set(),
  );

  // Filter states
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [ratingFilter, setRatingFilter] = useState<string>("all");
  const [moderationFilter, setModerationFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [subcategoryFilter, setSubcategoryFilter] = useState<string>("all");
  const [productFilter, setProductFilter] = useState<string>("all");

  // Initialize filters from URL search params (urlProductId/urlProductIdNum defined above)
  useEffect(() => {
    if (urlProductId && allProducts.length > 0 && allSubcategories.length > 0) {
      const pid = parseInt(urlProductId);
      const prod = allProducts.find((p) => p.ProductID === pid);
      if (prod) {
        setProductFilter(urlProductId);
        if (prod.ProductSubcategoryID) {
          setSubcategoryFilter(String(prod.ProductSubcategoryID));
          const sub = allSubcategories.find(
            (s) => s.ProductSubcategoryID === prod.ProductSubcategoryID,
          );
          if (sub) setCategoryFilter(String(sub.ProductCategoryID));
        }
      }
    }
  }, [urlProductId, allProducts, allSubcategories]);

  // Computed options for cascading filter dropdowns
  const subcategoriesForFilter = useMemo(() => {
    if (categoryFilter === "all") return allSubcategories;
    return allSubcategories.filter(
      (s) => String(s.ProductCategoryID) === categoryFilter,
    );
  }, [allSubcategories, categoryFilter]);

  const productsForFilter = useMemo(() => {
    if (subcategoryFilter === "all") return [];
    return allProducts.filter(
      (p) => String(p.ProductSubcategoryID) === subcategoryFilter,
    );
  }, [allProducts, subcategoryFilter]);

  const handleCategoryFilterChange = (val: string) => {
    setCategoryFilter(val);
    setSubcategoryFilter("all");
    setProductFilter("all");
    setSearchParams({});
  };

  const handleSubcategoryFilterChange = (val: string) => {
    setSubcategoryFilter(val);
    setProductFilter("all");
    setSearchParams({});
  };

  const handleProductFilterChange = (val: string) => {
    setProductFilter(val);
    if (val !== "all") {
      setSearchParams({ productId: val });
    } else {
      setSearchParams({});
    }
  };

  // Filter reviews
  const filteredReviews = useMemo(() => {
    return reviews.filter((review) => {
      // Product filter (most specific — checked first for short-circuit)
      if (productFilter !== "all") {
        if (review.productId !== parseInt(productFilter)) return false;
      } else if (subcategoryFilter !== "all") {
        // Subcategory filter
        const prod = productMap.get(review.productId);
        if (!prod || String(prod.ProductSubcategoryID) !== subcategoryFilter)
          return false;
      } else if (categoryFilter !== "all") {
        // Category filter
        const prod = productMap.get(review.productId);
        if (!prod || !prod.ProductSubcategoryID) return false;
        const sub = allSubcategories.find(
          (s) => s.ProductSubcategoryID === prod.ProductSubcategoryID,
        );
        if (!sub || String(sub.ProductCategoryID) !== categoryFilter)
          return false;
      }

      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const product = productMap.get(review.productId);
        const searchableText =
          `${review.title} ${review.comment} ${review.userName} ${product?.Name || ""}`.toLowerCase();
        if (!searchableText.includes(query)) {
          return false;
        }
      }

      // Rating filter
      if (ratingFilter !== "all") {
        const rating = parseInt(ratingFilter);
        if (review.rating !== rating) return false;
      }

      // Moderation filter
      if (moderationFilter === "moderated" && !review.isModerated) return false;
      if (moderationFilter === "unmoderated" && review.isModerated)
        return false;

      return true;
    });
  }, [
    reviews,
    searchQuery,
    ratingFilter,
    moderationFilter,
    categoryFilter,
    subcategoryFilter,
    productFilter,
    productMap,
    allSubcategories,
  ]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    ratingFilter !== "all" ||
    moderationFilter !== "all" ||
    categoryFilter !== "all" ||
    subcategoryFilter !== "all" ||
    productFilter !== "all";

  const clearFilters = () => {
    setSearchQuery("");
    setRatingFilter("all");
    setModerationFilter("all");
    setCategoryFilter("all");
    setSubcategoryFilter("all");
    setProductFilter("all");
    setSearchParams({});
  };

  const handleApprove = async (id: string) => {
    try {
      await approveReview(id);
      setReviews((prev) =>
        prev.map((r) => (r.id === id ? { ...r, isModerated: true } : r)),
      );
      toast({
        title: "Review Approved",
        description: "The review has been approved.",
      });
    } catch {
      toast({
        title: "Approval Failed",
        description: "Could not approve the review. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteReview(id);
      setReviews((prev) => prev.filter((r) => r.id !== id));
      setSelectedReviews((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
      toast({
        title: "Review Deleted",
        description: "The review has been removed.",
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Delete Failed",
        description: "Could not delete the review. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Bulk actions
  const toggleSelectReview = (id: string) => {
    setSelectedReviews((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedReviews.size === filteredReviews.length) {
      setSelectedReviews(new Set());
    } else {
      setSelectedReviews(new Set(filteredReviews.map((r) => r.id)));
    }
  };

  const handleBulkApprove = async () => {
    if (selectedReviews.size === 0) return;
    const ids = Array.from(selectedReviews);
    try {
      await Promise.all(ids.map((id) => approveReview(id)));
      setReviews((prev) =>
        prev.map((r) =>
          selectedReviews.has(r.id) ? { ...r, isModerated: true } : r,
        ),
      );
      setSelectedReviews(new Set());
      toast({
        title: "Reviews Approved",
        description: `${ids.length} review${ids.length > 1 ? "s have" : " has"} been approved.`,
      });
    } catch {
      toast({
        title: "Bulk Approval Failed",
        description: "Some reviews could not be approved. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleBulkDelete = async () => {
    if (selectedReviews.size === 0) return;
    const ids = Array.from(selectedReviews);
    try {
      await Promise.all(ids.map((id) => deleteReview(id)));
      setReviews((prev) => prev.filter((r) => !selectedReviews.has(r.id)));
      setSelectedReviews(new Set());
      toast({
        title: "Reviews Deleted",
        description: `${ids.length} review${ids.length > 1 ? "s have" : " has"} been removed.`,
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Bulk Delete Failed",
        description: "Some reviews could not be deleted. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Redirect if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <div>
              <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-2">
                Review Moderation
              </h1>
              <p className="font-doodle text-doodle-text/70">
                {hasActiveFilters
                  ? `Showing ${filteredReviews.length} of ${reviews.length} reviews`
                  : `${totalReviewCount ?? reviews.length} reviews to moderate`}
              </p>
            </div>
          </div>
        </section>

        {/* Filters Section */}
        <section className="container mx-auto px-4 pb-4">
          <div className="doodle-card p-4 space-y-4">
            {/* Active product banner */}
            {productFilter !== "all" && (
              <div className="flex items-center gap-2 px-3 py-2 bg-doodle-primary/5 border border-doodle-primary/20 rounded-lg">
                <span className="font-doodle text-sm text-doodle-text flex-1">
                  Showing reviews for:{" "}
                  <strong>
                    {productMap.get(parseInt(productFilter))?.Name ??
                      `Product #${productFilter}`}
                  </strong>
                </span>
                <button
                  onClick={clearFilters}
                  className="text-doodle-text/40 hover:text-doodle-text"
                  title="Clear product filter"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Browse by Category → Subcategory → Product */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex items-center gap-2 shrink-0">
                <Filter className="w-4 h-4 text-doodle-text/60" />
                <span className="font-doodle text-sm font-bold text-doodle-text">
                  Browse:
                </span>
              </div>
              <div className="flex flex-wrap gap-3 flex-1">
                <Select
                  value={categoryFilter}
                  onValueChange={handleCategoryFilterChange}
                >
                  <SelectTrigger className="w-[160px] font-doodle text-sm h-9">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {allCategories.map((cat) => (
                      <SelectItem
                        key={cat.ProductCategoryID}
                        value={String(cat.ProductCategoryID)}
                      >
                        {cat.Name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={subcategoryFilter}
                  onValueChange={handleSubcategoryFilterChange}
                  disabled={subcategoriesForFilter.length === 0}
                >
                  <SelectTrigger className="w-[170px] font-doodle text-sm h-9">
                    <SelectValue placeholder="Subcategory" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {categoryFilter === "all"
                        ? "All Subcategories"
                        : "All in Category"}
                    </SelectItem>
                    {subcategoriesForFilter.map((sub) => (
                      <SelectItem
                        key={sub.ProductSubcategoryID}
                        value={String(sub.ProductSubcategoryID)}
                      >
                        {sub.Name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={productFilter}
                  onValueChange={handleProductFilterChange}
                  disabled={productsForFilter.length === 0}
                >
                  <SelectTrigger className="w-[200px] font-doodle text-sm h-9">
                    <SelectValue
                      placeholder={
                        subcategoryFilter === "all"
                          ? "Pick subcategory first"
                          : "All Products"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Products</SelectItem>
                    {productsForFilter.map((p) => (
                      <SelectItem key={p.ProductID} value={String(p.ProductID)}>
                        {p.Name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-doodle-text/40" />
              <Input
                type="text"
                placeholder="Search by keyword, customer name, or product..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 font-doodle text-sm h-10"
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

            {/* Filter Dropdowns */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-doodle text-sm font-bold text-doodle-text">
                  Refine:
                </span>
              </div>

              <div className="flex flex-wrap gap-3 flex-1">
                <Select value={ratingFilter} onValueChange={setRatingFilter}>
                  <SelectTrigger className="w-[130px] font-doodle text-sm h-9">
                    <SelectValue placeholder="Rating" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Ratings</SelectItem>
                    <SelectItem value="5">
                      <span className="flex items-center gap-1">
                        5{" "}
                        <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                      </span>
                    </SelectItem>
                    <SelectItem value="4">
                      <span className="flex items-center gap-1">
                        4{" "}
                        <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                      </span>
                    </SelectItem>
                    <SelectItem value="3">
                      <span className="flex items-center gap-1">
                        3{" "}
                        <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                      </span>
                    </SelectItem>
                    <SelectItem value="2">
                      <span className="flex items-center gap-1">
                        2{" "}
                        <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                      </span>
                    </SelectItem>
                    <SelectItem value="1">
                      <span className="flex items-center gap-1">
                        1{" "}
                        <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={moderationFilter}
                  onValueChange={setModerationFilter}
                >
                  <SelectTrigger className="w-[160px] font-doodle text-sm h-9">
                    <SelectValue placeholder="Moderation" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Moderation</SelectItem>
                    <SelectItem value="unmoderated">
                      <span className="flex items-center gap-2">
                        <Minus className="w-3 h-3 text-yellow-500" /> Pending
                      </span>
                    </SelectItem>
                    <SelectItem value="moderated">
                      <span className="flex items-center gap-2">
                        <CheckCircle className="w-3 h-3 text-doodle-green" />{" "}
                        Approved
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="font-doodle text-xs gap-1 h-9"
                >
                  <X className="w-3 h-3" />
                  Clear Filters
                </Button>
              )}
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12">
          {/* Bulk Actions Bar */}
          {filteredReviews.length > 0 && (
            <div className="doodle-card p-3 mb-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={
                      selectedReviews.size === filteredReviews.length &&
                      filteredReviews.length > 0
                    }
                    onCheckedChange={toggleSelectAll}
                    className="border-2"
                  />
                  <span className="font-doodle text-sm text-doodle-text">
                    {selectedReviews.size === 0
                      ? "Select all"
                      : `${selectedReviews.size} selected`}
                  </span>
                  {selectedReviews.size > 0 &&
                    selectedReviews.size < filteredReviews.length && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={toggleSelectAll}
                        className="font-doodle text-xs h-7"
                      >
                        Select all {filteredReviews.length}
                      </Button>
                    )}
                </div>

                {selectedReviews.size > 0 && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={handleBulkApprove}
                      className="font-doodle gap-1 h-8"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Approve ({selectedReviews.size})
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleBulkDelete}
                      className="font-doodle gap-1 h-8"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete ({selectedReviews.size})
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="space-y-4">
            {isLoading ? (
              <div className="doodle-card p-8 text-center">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-doodle-text/40" />
                <p className="font-doodle text-doodle-text/60">
                  Loading reviews…
                </p>
              </div>
            ) : filteredReviews.length === 0 ? (
              <div className="doodle-card p-8 text-center">
                <p className="font-doodle text-doodle-text/60">
                  No reviews match your filters.
                </p>
                <Button
                  variant="link"
                  onClick={clearFilters}
                  className="font-doodle mt-2"
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              filteredReviews.map((review) => {
                const product = productMap.get(review.productId);
                const isSelected = selectedReviews.has(review.id);
                return (
                  <div
                    key={review.id}
                    className={`doodle-card p-4 transition-all ${isSelected ? "ring-2 ring-doodle-primary bg-doodle-primary/5" : ""}`}
                  >
                    <div className="flex flex-col md:flex-row justify-between gap-4">
                      <div className="flex items-start gap-3 flex-1">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelectReview(review.id)}
                          className="mt-1 border-2"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <div className="flex">
                              {[...Array(5)].map((_, i) => (
                                <Star
                                  key={i}
                                  className={`w-4 h-4 ${i < review.rating ? "fill-doodle-accent text-doodle-accent" : "text-doodle-text/20"}`}
                                />
                              ))}
                            </div>
                            <span className="font-doodle text-sm text-doodle-text/60">
                              by {review.userName}
                            </span>
                            {/* Moderation status badge */}
                            {review.isModerated ? (
                              <Badge className="font-doodle text-xs bg-doodle-green/20 text-doodle-green border-doodle-green/30">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Approved
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="font-doodle text-xs text-yellow-600 border-yellow-500/50"
                              >
                                <Minus className="w-3 h-3 mr-1" />
                                Pending
                              </Badge>
                            )}
                          </div>
                          <h3 className="font-doodle font-bold text-doodle-text">
                            {review.title}
                          </h3>
                          <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                            {review.comment}
                          </p>
                          <p className="font-doodle text-xs text-doodle-accent mt-2 flex items-center gap-2 flex-wrap">
                            Product:
                            {product ? (
                              <>
                                <Link
                                  to={`/product/${product.ProductID}`}
                                  className="hover:underline font-semibold"
                                >
                                  {product.Name}
                                </Link>
                                {getAppUrl() && (
                                  <a
                                    href={`${getAppUrl()}/product/${product.ProductID}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="View in customer app"
                                    className="text-doodle-blue hover:text-doodle-blue/70"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                              </>
                            ) : (
                              <span>Unknown</span>
                            )}
                            <span>•</span>
                            <span>
                              {new Date(review.createdAt).toLocaleDateString()}
                            </span>
                          </p>

                          {/* Show persisted staff reply if it exists */}
                          {review.existingReply && (
                            <div className="mt-3 p-3 bg-doodle-green/5 rounded-lg border border-doodle-green/20">
                              <div className="flex items-center gap-2 mb-2">
                                <MessageSquare className="w-3 h-3 text-doodle-green" />
                                <span className="font-doodle text-xs font-bold text-doodle-green">
                                  Staff Reply — {review.existingReply.by}
                                </span>
                                <span className="font-doodle text-xs text-doodle-text/40 ml-auto">
                                  {new Date(
                                    review.existingReply.date,
                                  ).toLocaleDateString()}
                                </span>
                              </div>
                              <p className="font-doodle text-sm text-doodle-text/80">
                                {review.existingReply.text}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => handleApprove(review.id)}
                              className="doodle-button doodle-button-primary p-2"
                              title="Approve"
                            >
                              <CheckCircle className="w-5 h-5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Approve Review</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => handleDelete(review.id)}
                              className="doodle-button p-2 hover:bg-doodle-accent/10 hover:text-doodle-accent"
                              title="Delete"
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Delete Review</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* DAB page navigation — each page is up to 100 reviews (hidden when a single product is selected) */}
        {!urlProductIdNum &&
          (cursorStack.length > 0 || apiData?.hasNextPage) && (
            <section className="container mx-auto px-4 pb-8">
              <div className="doodle-card p-4 flex items-center justify-between">
                <button
                  onClick={() => {
                    const prev = cursorStack[cursorStack.length - 1] ?? null;
                    setCursorStack((s) => s.slice(0, -1));
                    setDabCursor(prev);
                  }}
                  disabled={cursorStack.length === 0}
                  className="inline-flex items-center gap-1 p-2 font-doodle text-sm disabled:opacity-40"
                  aria-label="Previous page"
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
                  aria-label="Next page"
                >
                  Next 100 <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </section>
          )}
      </main>
      <Footer />
    </div>
  );
};

export default ReviewsPage;
