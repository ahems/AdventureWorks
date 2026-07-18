import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Star,
  Trash2,
  CheckCircle,
  MessageSquare,
  Minus,
  Loader2,
  Filter,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Sparkles,
  AlertTriangle,
  Reply,
  Users,
  Package,
  List,
  ChevronDown,
  ChevronUp,
  ArrowUpDown,
  Calendar as CalendarIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { TableSkeleton, KpiSkeleton } from "@/components/LoadingSkeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/context/AuthContext";
import {
  useAdminReviews,
  useAdminReviewsByProduct,
  useReviewTotalCount,
  useReviewPendingCount,
  useReviewPendingWithoutReplyCount,
  approveReview,
  deleteReview,
  submitReply,
  updateReply,
  type AdminReview,
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
import {
  analyzeReviewsBatch,
  startReviewModerationAnalyzeApproveAll,
  getReviewModerationStatus,
  generateVerifiedReviewsForProduct,
  type ReviewAnalysisResult,
} from "@/services/utilityService";

import { getAppUrl } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReviewWithAI extends AdminReview {
  sentiment?: "positive" | "neutral" | "negative";
  flags?: string[];
  suggestedResponse?: string | null;
}

type ViewMode = "list" | "group-product" | "group-customer";
type SortOption = "newest" | "oldest" | "highest" | "lowest" | "helpful";
type GroupSort = "most-reviews" | "lowest-rating" | "most-negative";

const REVIEW_MODERATION_POLL_INTERVAL_MS = 3000;

// ─── Sentiment UI helpers ─────────────────────────────────────────────────────

const sentimentColors: Record<string, string> = {
  positive: "bg-green-100 text-green-700 border-green-300",
  neutral: "bg-gray-100 text-gray-600 border-gray-300",
  negative: "bg-red-100 text-red-700 border-red-300",
};

const flagColors: Record<string, string> = {
  "Potential Spam": "bg-red-100 text-red-700 border-red-300",
  "Offensive Language": "bg-red-100 text-red-700 border-red-300",
  "Refund Request": "bg-amber-100 text-amber-700 border-amber-300",
  "Short Review": "bg-gray-100 text-gray-600 border-gray-300",
  "Excessive Punctuation": "bg-amber-100 text-amber-700 border-amber-300",
};

// ─── Page Component ───────────────────────────────────────────────────────────

const ReviewsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [dabCursor, setDabCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const urlProductId = searchParams.get("productId");
  const urlProductIdNum = urlProductId ? parseInt(urlProductId, 10) : null;

  // ─── Filter states (default to pending/unmoderated) ───────────────────
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [ratingFilter, setRatingFilter] = useState<string>("all");
  const [moderationFilter, setModerationFilter] =
    useState<string>("unmoderated");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [subcategoryFilter, setSubcategoryFilter] = useState<string>("all");
  const [productFilter, setProductFilter] = useState<string>("all");
  const [sentimentFilter, setSentimentFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);

  // ─── View & sort states ────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [groupSort, setGroupSort] = useState<GroupSort>("most-reviews");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // ─── AI analysis state ─────────────────────────────────────────────────
  const [analysisResults, setAnalysisResults] = useState<
    Map<string, ReviewAnalysisResult>
  >(new Map());
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<string>("");
  const [isAnalyzeApproveAllRunning, setIsAnalyzeApproveAllRunning] =
    useState(false);
  const [analyzeApproveAllProgress, setAnalyzeApproveAllProgress] =
    useState<string>("");
  const [isAnalyzeApproveAllConfirmOpen, setIsAnalyzeApproveAllConfirmOpen] =
    useState(false);
  const activeModerationJobIdRef = useRef<string | null>(null);
  const notifyModerationCompletionRef = useRef(false);

  // ─── Reply state ───────────────────────────────────────────────────────
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<string>("");
  const [isSubmittingReply, setIsSubmittingReply] = useState(false);

  // ─── Data queries ──────────────────────────────────────────────────────
  const { data: productApiData, isLoading: productReviewsLoading } =
    useAdminReviewsByProduct(urlProductIdNum);
  const { data: apiData, isLoading: generalReviewsLoading } = useAdminReviews(
    urlProductIdNum ? null : dabCursor,
    urlProductIdNum
      ? "all"
      : (moderationFilter as "all" | "moderated" | "unmoderated"),
  );
  const dataNotYetArrived = urlProductIdNum ? !productApiData : !apiData;
  const isLoading =
    (urlProductIdNum ? productReviewsLoading : generalReviewsLoading) ||
    dataNotYetArrived;
  const { data: totalReviewCount } = useReviewTotalCount();
  const { data: pendingCount } = useReviewPendingCount();
  const { data: pendingWithoutReplyCount } =
    useReviewPendingWithoutReplyCount();
  const { data: allProducts = [] } = useAdminAllProducts();
  const { data: allCategories = [] } = useAdminCategories();
  const { data: allSubcategories = [] } = useAdminAllSubcategories();
  const productMap = useMemo(
    () => new Map(allProducts.map((p) => [p.ProductID, p])),
    [allProducts],
  );
  const [reviews, setReviews] = useState<ReviewWithAI[]>([]);

  // ─── Sync from API ─────────────────────────────────────────────────────
  useEffect(() => {
    const activeData = urlProductIdNum ? productApiData : apiData;
    const items = activeData?.items;
    if (items && items.length > 0) {
      setReviews(items.map((item) => ({ ...item }) as ReviewWithAI));
    } else if (items && items.length === 0) {
      setReviews([]);
    }
  }, [apiData, productApiData, urlProductIdNum]);

  // ─── Bulk selection ────────────────────────────────────────────────────
  const [selectedReviews, setSelectedReviews] = useState<Set<string>>(
    new Set(),
  );

  // ─── Initialize filters from URL ──────────────────────────────────────
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

  // ─── Cascading filter dropdowns ───────────────────────────────────────
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
  const handleModerationFilterChange = (val: string) => {
    setModerationFilter(val);
    // Reset pagination when server-side filter changes
    setDabCursor(null);
    setCursorStack([]);
  };

  // ─── Filter + Sort reviews ─────────────────────────────────────────────
  const filteredReviews = useMemo(() => {
    let result = reviews.filter((review) => {
      // Product filter
      if (productFilter !== "all") {
        if (review.productId !== parseInt(productFilter)) return false;
      } else if (subcategoryFilter !== "all") {
        const prod = productMap.get(review.productId);
        if (!prod || String(prod.ProductSubcategoryID) !== subcategoryFilter)
          return false;
      } else if (categoryFilter !== "all") {
        const prod = productMap.get(review.productId);
        if (!prod || !prod.ProductSubcategoryID) return false;
        const sub = allSubcategories.find(
          (s) => s.ProductSubcategoryID === prod.ProductSubcategoryID,
        );
        if (!sub || String(sub.ProductCategoryID) !== categoryFilter)
          return false;
      }

      // Search
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const product = productMap.get(review.productId);
        const searchableText =
          `${review.title} ${review.comment} ${review.userName} ${product?.Name || ""}`.toLowerCase();
        if (!searchableText.includes(query)) return false;
      }

      // Rating
      if (ratingFilter !== "all" && review.rating !== parseInt(ratingFilter))
        return false;

      // Moderation (client-side secondary filter for product-specific queries)
      if (moderationFilter === "moderated" && !review.isModerated) return false;
      if (moderationFilter === "unmoderated" && review.isModerated)
        return false;

      // Sentiment (only active after AI analysis)
      if (sentimentFilter !== "all") {
        const analysis = analysisResults.get(review.id);
        if (!analysis || analysis.sentiment !== sentimentFilter) return false;
      }

      // Date range
      if (dateFrom) {
        const reviewDate = new Date(review.createdAt);
        const fromStart = new Date(dateFrom);
        fromStart.setHours(0, 0, 0, 0);
        if (reviewDate < fromStart) return false;
      }
      if (dateTo) {
        const reviewDate = new Date(review.createdAt);
        const toEnd = new Date(dateTo);
        toEnd.setHours(23, 59, 59, 999);
        if (reviewDate > toEnd) return false;
      }

      return true;
    });

    // Sort
    result = [...result].sort((a, b) => {
      switch (sortOption) {
        case "oldest":
          return (
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        case "highest":
          return b.rating - a.rating;
        case "lowest":
          return a.rating - b.rating;
        case "helpful":
          return b.helpful - a.helpful;
        case "newest":
        default:
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
      }
    });

    return result;
  }, [
    reviews,
    searchQuery,
    ratingFilter,
    moderationFilter,
    categoryFilter,
    subcategoryFilter,
    productFilter,
    sentimentFilter,
    dateFrom,
    dateTo,
    sortOption,
    productMap,
    allSubcategories,
    analysisResults,
  ]);

  // ─── Grouped views ─────────────────────────────────────────────────────
  const productGroups = useMemo(() => {
    if (viewMode !== "group-product") return [];
    const map = new Map<number, ReviewWithAI[]>();
    for (const r of filteredReviews) {
      const arr = map.get(r.productId) ?? [];
      arr.push(r);
      map.set(r.productId, arr);
    }
    const groups = Array.from(map.entries()).map(([productId, items]) => {
      const product = productMap.get(productId);
      const avgRating = items.reduce((s, r) => s + r.rating, 0) / items.length;
      const negCount = items.filter(
        (r) => analysisResults.get(r.id)?.sentiment === "negative",
      ).length;
      return {
        key: String(productId),
        label: product?.Name ?? `Product #${productId}`,
        productId,
        items,
        avgRating,
        negCount,
      };
    });
    groups.sort((a, b) => {
      switch (groupSort) {
        case "lowest-rating":
          return a.avgRating - b.avgRating;
        case "most-negative":
          return b.negCount - a.negCount;
        case "most-reviews":
        default:
          return b.items.length - a.items.length;
      }
    });
    return groups;
  }, [viewMode, filteredReviews, productMap, groupSort, analysisResults]);

  const customerGroups = useMemo(() => {
    if (viewMode !== "group-customer") return [];
    const map = new Map<
      string,
      { userId: number | null; items: ReviewWithAI[] }
    >();
    for (const r of filteredReviews) {
      const key = r.userId ? `uid-${r.userId}` : `name-${r.userName}`;
      const entry = map.get(key) ?? { userId: r.userId, items: [] };
      entry.items.push(r);
      map.set(key, entry);
    }
    const groups = Array.from(map.entries()).map(([key, { userId, items }]) => {
      const avgRating = items.reduce((s, r) => s + r.rating, 0) / items.length;
      const negCount = items.filter(
        (r) => analysisResults.get(r.id)?.sentiment === "negative",
      ).length;
      return {
        key,
        label: items[0].userName,
        userId,
        items,
        avgRating,
        negCount,
      };
    });
    groups.sort((a, b) => {
      switch (groupSort) {
        case "lowest-rating":
          return a.avgRating - b.avgRating;
        case "most-negative":
          return b.negCount - a.negCount;
        case "most-reviews":
        default:
          return b.items.length - a.items.length;
      }
    });
    return groups;
  }, [viewMode, filteredReviews, groupSort, analysisResults]);

  // ─── KPI computations ──────────────────────────────────────────────────
  const avgRating = useMemo(() => {
    if (reviews.length === 0) return 0;
    return reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  }, [reviews]);

  const repliedCount = useMemo(
    () => reviews.filter((r) => r.existingReply).length,
    [reviews],
  );

  // ─── Date range from current page data ─────────────────────────────────
  const reviewDateRange = useMemo(() => {
    if (reviews.length === 0) return { earliest: undefined, latest: undefined };
    let earliest = new Date(reviews[0].createdAt);
    let latest = new Date(reviews[0].createdAt);
    for (const r of reviews) {
      const d = new Date(r.createdAt);
      if (d < earliest) earliest = d;
      if (d > latest) latest = d;
    }
    return { earliest, latest };
  }, [reviews]);

  // ─── Filters helper ────────────────────────────────────────────────────
  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    ratingFilter !== "all" ||
    moderationFilter !== "unmoderated" ||
    categoryFilter !== "all" ||
    subcategoryFilter !== "all" ||
    productFilter !== "all" ||
    sentimentFilter !== "all" ||
    dateFrom !== undefined ||
    dateTo !== undefined;

  const clearFilters = () => {
    setSearchQuery("");
    setRatingFilter("all");
    setModerationFilter("unmoderated");
    setCategoryFilter("all");
    setSubcategoryFilter("all");
    setProductFilter("all");
    setSentimentFilter("all");
    setDateFrom(undefined);
    setDateTo(undefined);
    setSearchParams({});
    setDabCursor(null);
    setCursorStack([]);
  };

  const formatDateShort = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  // ─── Actions ───────────────────────────────────────────────────────────

  // After approvals, if we're filtering for unmoderated and all visible reviews
  // are now approved, refetch to load the next batch of pending reviews.
  const refetchIfAllApproved = useCallback(
    (updatedReviews: ReviewWithAI[]) => {
      if (moderationFilter !== "unmoderated") return;
      const anyPending = updatedReviews.some((r) => !r.isModerated);
      if (!anyPending && updatedReviews.length > 0) {
        // Brief delay so the toast is visible before the list refreshes
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["admin", "reviews"] });
        }, 600);
      }
    },
    [moderationFilter, queryClient],
  );

  const handleApprove = async (id: string) => {
    try {
      await approveReview(id);
      const updated = reviews.map((r) =>
        r.id === id ? { ...r, isModerated: true } : r,
      );
      setReviews(updated);
      toast({
        title: "Review Approved",
        description: "The review has been approved.",
      });
      refetchIfAllApproved(updated);
    } catch {
      toast({
        title: "Approval Failed",
        description: "Could not approve the review.",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteReview(id);
      setReviews((prev) => prev.filter((r) => r.id !== id));
      setSelectedReviews((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      toast({
        title: "Review Deleted",
        description: "The review has been removed.",
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Delete Failed",
        description: "Could not delete the review.",
        variant: "destructive",
      });
    }
  };

  const toggleSelectReview = (id: string) => {
    setSelectedReviews((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
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
      const updated = reviews.map((r) =>
        selectedReviews.has(r.id) ? { ...r, isModerated: true } : r,
      );
      setReviews(updated);
      setSelectedReviews(new Set());
      toast({
        title: "Reviews Approved",
        description: `${ids.length} review${ids.length > 1 ? "s" : ""} approved.`,
      });
      refetchIfAllApproved(updated);
    } catch {
      toast({
        title: "Bulk Approval Failed",
        description: "Some reviews could not be approved.",
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
        description: `${ids.length} review${ids.length > 1 ? "s" : ""} removed.`,
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Bulk Delete Failed",
        description: "Some reviews could not be deleted.",
        variant: "destructive",
      });
    }
  };

  // ─── AI Analysis ──────────────────────────────────────────────────────
  const handleAnalyze = useCallback(async () => {
    if (filteredReviews.length === 0) return;
    setIsAnalyzing(true);
    setAnalyzeProgress("Preparing...");
    try {
      const inputs = filteredReviews.map((r) => ({
        productReviewId: parseInt(r.id),
        rating: r.rating,
        comments: r.comment,
        reviewerName: r.userName,
        productName: productMap.get(r.productId)?.Name ?? "Unknown",
      }));
      const results = await analyzeReviewsBatch(inputs, (done, total) => {
        setAnalyzeProgress(`Analyzing ${done}/${total}...`);
      });
      const map = new Map<string, ReviewAnalysisResult>();
      for (const r of results) {
        map.set(String(r.productReviewId), r);
      }
      setAnalysisResults(map);
      toast({
        title: "Analysis Complete",
        description: `${results.length} reviews analyzed.`,
      });
    } catch (err) {
      toast({
        title: "Analysis Failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
      setAnalyzeProgress("");
    }
  }, [filteredReviews, productMap]);

  const pollReviewModerationStatus = useCallback(async () => {
    try {
      const status = await getReviewModerationStatus();
      setIsAnalyzeApproveAllRunning(status.isRunning);

      if (status.isRunning) {
        setAnalyzeApproveAllProgress(
          `Processing ${status.processedCount}/${status.queuedCount}...`,
        );
      } else {
        setAnalyzeApproveAllProgress("");
      }

      if (!activeModerationJobIdRef.current && status.jobId) {
        activeModerationJobIdRef.current = status.jobId;
      }

      if (
        !status.isRunning &&
        notifyModerationCompletionRef.current &&
        activeModerationJobIdRef.current &&
        status.jobId === activeModerationJobIdRef.current
      ) {
        notifyModerationCompletionRef.current = false;
        queryClient.invalidateQueries({ queryKey: ["admin", "reviews"] });

        toast({
          title: "Analyze & Approve Complete",
          description:
            status.failedCount > 0
              ? `${status.successCount} completed, ${status.failedCount} failed, ${status.skippedCount} skipped.`
              : `${status.successCount} review${status.successCount === 1 ? "" : "s"} analyzed, replied, and approved.`,
          variant: status.failedCount > 0 ? "destructive" : undefined,
        });
      }
    } catch {
      // Polling failures are transient; leave current status UI as-is.
    }
  }, [queryClient]);

  useEffect(() => {
    void pollReviewModerationStatus();
    const id = setInterval(() => {
      void pollReviewModerationStatus();
    }, REVIEW_MODERATION_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pollReviewModerationStatus]);

  const handleAnalyzeAndApproveAll = useCallback(async () => {
    if (isAnalyzeApproveAllRunning) return;

    setIsAnalyzeApproveAllRunning(true);
    setAnalyzeApproveAllProgress("Queueing review moderation job...");

    try {
      const start = await startReviewModerationAnalyzeApproveAll();
      setIsAnalyzeApproveAllRunning(start.state.isRunning);

      if (start.httpStatus === 409) {
        activeModerationJobIdRef.current = start.state.jobId || null;
        notifyModerationCompletionRef.current = false;
        setAnalyzeApproveAllProgress(
          start.state.isRunning
            ? `Processing ${start.state.processedCount}/${start.state.queuedCount}...`
            : "",
        );
        toast({
          title: "Job Already Running",
          description:
            "A background review moderation job is already in progress.",
        });
        return;
      }

      if (!start.started) {
        setAnalyzeApproveAllProgress("");
        setIsAnalyzeApproveAllRunning(false);
        toast({
          title: "No Action Needed",
          description: start.message,
        });
        return;
      }

      activeModerationJobIdRef.current = start.state.jobId || null;
      notifyModerationCompletionRef.current = true;

      setAnalyzeApproveAllProgress(
        `Processing ${start.state.processedCount}/${start.state.queuedCount}...`,
      );

      toast({
        title: "Background Job Started",
        description: start.message,
      });
    } catch (err) {
      setIsAnalyzeApproveAllRunning(false);
      setAnalyzeApproveAllProgress("");
      toast({
        title: "Analyze & Approve Failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }, [isAnalyzeApproveAllRunning]);

  const handleConfirmAnalyzeAndApproveAll = useCallback(async () => {
    setIsAnalyzeApproveAllConfirmOpen(false);
    await handleAnalyzeAndApproveAll();
  }, [handleAnalyzeAndApproveAll]);

  // ─── Reply handlers ────────────────────────────────────────────────────
  const handleStartReply = (reviewId: string, editExisting = false) => {
    setReplyingTo(reviewId);
    if (editExisting) {
      const existing = reviews.find((r) => r.id === reviewId)?.existingReply;
      setReplyText(existing?.text ?? "");
    } else {
      const suggestion = analysisResults.get(reviewId)?.suggestedResponse;
      setReplyText(suggestion ?? "");
    }
  };

  const handleSubmitReply = async () => {
    if (!replyingTo || !replyText.trim()) return;
    setIsSubmittingReply(true);
    const existingReply = reviews.find(
      (r) => r.id === replyingTo,
    )?.existingReply;
    try {
      let replyRecord;
      if (existingReply) {
        replyRecord = await updateReply(
          existingReply.replyId,
          replyText.trim(),
        );
      } else {
        replyRecord = await submitReply(replyingTo, replyText.trim());
      }
      setReviews((prev) =>
        prev.map((r) =>
          r.id === replyingTo
            ? {
                ...r,
                existingReply: {
                  replyId: replyRecord.ProductReviewReplyID,
                  text: replyRecord.Reply,
                  by: replyRecord.RepliedBy,
                  date: replyRecord.ReplyDate,
                },
              }
            : r,
        ),
      );
      setReplyingTo(null);
      setReplyText("");
      toast({
        title: existingReply ? "Reply Updated" : "Reply Sent",
        description: existingReply
          ? "Staff reply has been updated."
          : "Staff reply has been posted.",
      });
    } catch {
      toast({
        title: "Reply Failed",
        description: "Could not submit the reply.",
        variant: "destructive",
      });
    } finally {
      setIsSubmittingReply(false);
    }
  };

  const handleBulkReply = async () => {
    if (selectedReviews.size === 0) return;
    const unreplied = filteredReviews.filter(
      (r) => selectedReviews.has(r.id) && !r.existingReply,
    );
    if (unreplied.length === 0) {
      toast({
        title: "No Action Needed",
        description: "All selected reviews already have replies.",
      });
      return;
    }
    setIsAnalyzing(true);
    setAnalyzeProgress("Generating AI replies...");
    try {
      const inputs = unreplied.map((r) => ({
        productReviewId: parseInt(r.id),
        rating: r.rating,
        comments: r.comment,
        reviewerName: r.userName,
        productName: productMap.get(r.productId)?.Name ?? "Unknown",
      }));
      const results = await analyzeReviewsBatch(inputs, (done, total) => {
        setAnalyzeProgress(`Analyzing ${done}/${total}...`);
      });
      // Update analysis state
      const newMap = new Map(analysisResults);
      for (const r of results) newMap.set(String(r.productReviewId), r);
      setAnalysisResults(newMap);

      // Submit replies
      let submitted = 0;
      for (const result of results) {
        if (result.suggestedResponse) {
          try {
            const reply = await submitReply(
              String(result.productReviewId),
              result.suggestedResponse,
            );
            setReviews((prev) =>
              prev.map((r) =>
                r.id === String(result.productReviewId)
                  ? {
                      ...r,
                      existingReply: {
                        replyId: reply.ProductReviewReplyID,
                        text: reply.Reply,
                        by: reply.RepliedBy,
                        date: reply.ReplyDate,
                      },
                    }
                  : r,
              ),
            );
            submitted++;
          } catch {
            /* continue with others */
          }
        }
      }
      setSelectedReviews(new Set());
      toast({
        title: "Bulk Replies Sent",
        description: `${submitted} AI-generated replies posted.`,
      });
    } catch (err) {
      toast({
        title: "Bulk Reply Failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
      setAnalyzeProgress("");
    }
  };

  // ─── Generate reviews shortcut ─────────────────────────────────────────
  const [isGenerating, setIsGenerating] = useState(false);
  const handleGenerateReviews = async () => {
    if (!urlProductIdNum) return;
    setIsGenerating(true);
    try {
      await generateVerifiedReviewsForProduct(urlProductIdNum);
      toast({
        title: "Review Generation Started",
        description:
          "A verified review is being generated using a real customer.",
      });
    } catch (err) {
      toast({
        title: "Generation Failed",
        description: err instanceof Error ? err.message : "Failed",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  // ─── Group toggle ──────────────────────────────────────────────────────
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });
  };

  // ─── Auth guard ────────────────────────────────────────────────────────
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // ─── Review card renderer ──────────────────────────────────────────────
  const renderReviewCard = (review: ReviewWithAI) => {
    const product = productMap.get(review.productId);
    const isSelected = selectedReviews.has(review.id);
    const analysis = analysisResults.get(review.id);

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
                  by{" "}
                  {review.userId ? (
                    <Link
                      to={`/customers/${review.userId}`}
                      className="hover:underline text-doodle-blue"
                    >
                      {review.userName}
                    </Link>
                  ) : (
                    review.userName
                  )}
                </span>
                {/* Moderation badge */}
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
                {/* Sentiment badge */}
                {analysis?.sentiment && (
                  <Badge
                    variant="outline"
                    className={`font-doodle text-xs ${sentimentColors[analysis.sentiment]}`}
                  >
                    {analysis.sentiment}
                  </Badge>
                )}
                {/* Content flags */}
                {analysis?.flags?.map((flag) => (
                  <Badge
                    key={flag}
                    variant="outline"
                    className={`font-doodle text-xs ${flagColors[flag] ?? "bg-amber-100 text-amber-700 border-amber-300"}`}
                  >
                    <AlertTriangle className="w-3 h-3 mr-1" />
                    {flag}
                  </Badge>
                ))}
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
                <span>{new Date(review.createdAt).toLocaleDateString()}</span>
                {review.helpful > 0 && (
                  <>
                    <span>•</span>
                    <span>
                      {review.helpful} helpful vote
                      {review.helpful !== 1 ? "s" : ""}
                    </span>
                  </>
                )}
              </p>

              {/* Existing staff reply */}
              {review.existingReply && (
                <div className="mt-3 p-3 bg-doodle-green/5 rounded-lg border border-doodle-green/20">
                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare className="w-3 h-3 text-doodle-green" />
                    <span className="font-doodle text-xs font-bold text-doodle-green">
                      Staff Reply — {review.existingReply.by}
                    </span>
                    <span className="font-doodle text-xs text-doodle-text/40 ml-auto">
                      {new Date(review.existingReply.date).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="font-doodle text-sm text-doodle-text/80">
                    {review.existingReply.text}
                  </p>
                  {replyingTo !== review.id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleStartReply(review.id, true)}
                      className="font-doodle text-xs h-6 gap-1 mt-1 text-doodle-text/50 hover:text-doodle-text"
                    >
                      <Reply className="w-3 h-3" /> Edit Reply
                    </Button>
                  )}
                </div>
              )}

              {/* Reply form */}
              {replyingTo === review.id && (
                <div className="mt-3 p-3 bg-blue-50/50 rounded-lg border border-blue-200/50">
                  <div className="flex items-center gap-2 mb-2">
                    <Reply className="w-3 h-3 text-blue-600" />
                    <span className="font-doodle text-xs font-bold text-blue-600">
                      {reviews.find((r) => r.id === review.id)?.existingReply
                        ? "Edit Reply"
                        : "Write Reply"}
                    </span>
                    {analysis?.suggestedResponse &&
                      replyText !== analysis.suggestedResponse && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setReplyText(analysis.suggestedResponse!)
                          }
                          className="font-doodle text-xs h-6 gap-1 text-blue-600"
                        >
                          <Sparkles className="w-3 h-3" /> Use AI Suggestion
                        </Button>
                      )}
                  </div>
                  <Textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Type your reply..."
                    className="font-doodle text-sm min-h-[80px] mb-2"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleSubmitReply}
                      disabled={!replyText.trim() || isSubmittingReply}
                      className="font-doodle gap-1 h-7"
                    >
                      {isSubmittingReply ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <MessageSquare className="w-3 h-3" />
                      )}
                      {reviews.find((r) => r.id === replyingTo)?.existingReply
                        ? "Update Reply"
                        : "Send Reply"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReplyingTo(null);
                        setReplyText("");
                      }}
                      className="font-doodle h-7"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* Reply button (when not already replying and no existing reply) */}
              {!review.existingReply && replyingTo !== review.id && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleStartReply(review.id)}
                  className="font-doodle text-xs h-7 gap-1 mt-2 text-doodle-text/60"
                >
                  <Reply className="w-3 h-3" /> Reply
                  {analysis?.suggestedResponse && (
                    <Sparkles className="w-3 h-3 text-blue-500" />
                  )}
                </Button>
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
  };

  // ─── Pagination bar (reused top + bottom) ─────────────────────────────
  const showPagination =
    !urlProductIdNum && (cursorStack.length > 0 || apiData?.hasNextPage);
  const paginationBar = showPagination ? (
    <div className="doodle-card p-3 flex items-center justify-between">
      <button
        onClick={() => {
          const prev = cursorStack[cursorStack.length - 1] ?? null;
          setCursorStack((s) => s.slice(0, -1));
          setDabCursor(prev);
          setSelectedReviews(new Set());
          setAnalysisResults(new Map());
        }}
        disabled={cursorStack.length === 0}
        className="inline-flex items-center gap-1 p-2 font-doodle text-sm disabled:opacity-40"
      >
        <ChevronLeft className="w-5 h-5" /> Previous 100
      </button>
      <span className="font-doodle text-sm text-doodle-text/60">
        Page {cursorStack.length + 1}
        {totalReviewCount ? ` of ${Math.ceil(totalReviewCount / 100)}` : ""}
      </span>
      <button
        onClick={() => {
          setCursorStack((s) => [...s, dabCursor ?? ""]);
          setDabCursor(apiData!.endCursor);
          setSelectedReviews(new Set());
          setAnalysisResults(new Map());
        }}
        disabled={!apiData?.hasNextPage}
        className="inline-flex items-center gap-1 p-2 font-doodle text-sm disabled:opacity-40"
      >
        Next 100 <ChevronRight className="w-5 h-5" />
      </button>
    </div>
  ) : null;

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        {/* KPI Cards */}
        <section className="container mx-auto px-4 pb-4">
          {isLoading || totalReviewCount === undefined ? (
            <KpiSkeleton count={4} />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="doodle-card p-4 text-center">
                <p className="font-doodle text-2xl font-bold text-doodle-text">
                  {totalReviewCount ?? 0}
                </p>
                <p className="font-doodle text-xs text-doodle-text/60">
                  Total Reviews
                </p>
              </div>
              <div className="doodle-card p-4 text-center">
                <p className="font-doodle text-2xl font-bold text-yellow-600">
                  {pendingCount ?? 0}
                </p>
                <p className="font-doodle text-xs text-doodle-text/60">
                  Pending Moderation
                </p>
              </div>
              <div className="doodle-card p-4 text-center">
                <div className="flex items-center justify-center gap-1">
                  <Star className="w-5 h-5 fill-doodle-accent text-doodle-accent" />
                  <p className="font-doodle text-2xl font-bold text-doodle-text">
                    {avgRating.toFixed(1)}
                  </p>
                </div>
                <p className="font-doodle text-xs text-doodle-text/60">
                  Avg Rating (page)
                </p>
              </div>
              <div className="doodle-card p-4 text-center">
                <p className="font-doodle text-2xl font-bold text-doodle-green">
                  {repliedCount}
                </p>
                <p className="font-doodle text-xs text-doodle-text/60">
                  With Replies (page)
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Header with title + AI actions */}
        <section className="container mx-auto px-4 pb-4">
          <div className="doodle-card p-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-1">
                  Review Moderation
                </h1>
                {isLoading ? (
                  <Skeleton className="h-5 w-64 mt-1" />
                ) : (
                  <p className="font-doodle text-doodle-text/70">
                    {hasActiveFilters
                      ? `Showing ${filteredReviews.length} of ${reviews.length} reviews`
                      : `${reviews.length} reviews loaded${pendingCount !== undefined ? ` (${pendingCount} pending total)` : ""}`}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {urlProductIdNum && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleGenerateReviews}
                    disabled={isGenerating}
                    className="font-doodle gap-1 h-8"
                  >
                    {isGenerating ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    Generate AI Reviews
                  </Button>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={handleAnalyze}
                      disabled={
                        isAnalyzing ||
                        isAnalyzeApproveAllRunning ||
                        filteredReviews.length === 0
                      }
                      className="font-doodle gap-1 h-8"
                    >
                      {isAnalyzing ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          {analyzeProgress || "Analyzing..."}
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4" />
                          Analyze with AI ({filteredReviews.length})
                        </>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={8}
                    className="max-w-xs text-center z-50"
                  >
                    <p>
                      Uses AI to classify each review&apos;s sentiment (positive
                      / neutral / negative), flag potential issues, and suggest
                      staff replies.
                    </p>
                  </TooltipContent>
                </Tooltip>
                <AlertDialog
                  open={isAnalyzeApproveAllConfirmOpen}
                  onOpenChange={setIsAnalyzeApproveAllConfirmOpen}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        onClick={() => setIsAnalyzeApproveAllConfirmOpen(true)}
                        disabled={
                          isAnalyzeApproveAllRunning ||
                          isAnalyzing ||
                          (pendingWithoutReplyCount ?? 0) === 0
                        }
                        className="font-doodle gap-1 h-8"
                      >
                        {isAnalyzeApproveAllRunning ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {analyzeApproveAllProgress || "Running..."}
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-4 h-4" />
                            Analyze and Approve All (
                            {pendingWithoutReplyCount ?? 0})
                          </>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={8}
                      className="max-w-xs text-center z-50"
                    >
                      <p>
                        Analyzes every pending review without a staff reply in
                        the database, posts an AI reply, then approves it.
                      </p>
                    </TooltipContent>
                  </Tooltip>

                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Analyze and approve all pending unreplied reviews?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This will process {pendingWithoutReplyCount ?? 0} review
                        {pendingWithoutReplyCount === 1 ? "" : "s"} across the
                        database. Each review gets an AI reply and is then
                        marked approved.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={isAnalyzeApproveAllRunning}>
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleConfirmAnalyzeAndApproveAll}
                        disabled={isAnalyzeApproveAllRunning}
                      >
                        Continue
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        </section>

        {/* View mode + Sort controls */}
        <section className="container mx-auto px-4 pb-4">
          <div className="doodle-card p-3 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            {/* View mode toggle */}
            <div className="flex items-center gap-1 border rounded-lg p-1">
              <button
                onClick={() => setViewMode("list")}
                className={`p-1.5 rounded ${viewMode === "list" ? "bg-doodle-primary text-white" : "text-doodle-text/60 hover:text-doodle-text"}`}
                title="List view"
              >
                <List className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode("group-product")}
                className={`p-1.5 rounded ${viewMode === "group-product" ? "bg-doodle-primary text-white" : "text-doodle-text/60 hover:text-doodle-text"}`}
                title="Group by Product"
              >
                <Package className="w-4 h-4" />
              </button>
              <button
                onClick={() => setViewMode("group-customer")}
                className={`p-1.5 rounded ${viewMode === "group-customer" ? "bg-doodle-primary text-white" : "text-doodle-text/60 hover:text-doodle-text"}`}
                title="Group by Customer"
              >
                <Users className="w-4 h-4" />
              </button>
            </div>

            {/* Sort (list view) */}
            {viewMode === "list" && (
              <div className="flex items-center gap-2">
                <ArrowUpDown className="w-4 h-4 text-doodle-text/60" />
                <Select
                  value={sortOption}
                  onValueChange={(v) => setSortOption(v as SortOption)}
                >
                  <SelectTrigger className="w-[140px] font-doodle text-sm h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest First</SelectItem>
                    <SelectItem value="oldest">Oldest First</SelectItem>
                    <SelectItem value="highest">Highest Rating</SelectItem>
                    <SelectItem value="lowest">Lowest Rating</SelectItem>
                    <SelectItem value="helpful">Most Helpful</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Sort (grouped views) */}
            {viewMode !== "list" && (
              <div className="flex items-center gap-2">
                <ArrowUpDown className="w-4 h-4 text-doodle-text/60" />
                <Select
                  value={groupSort}
                  onValueChange={(v) => setGroupSort(v as GroupSort)}
                >
                  <SelectTrigger className="w-[160px] font-doodle text-sm h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="most-reviews">Most Reviews</SelectItem>
                    <SelectItem value="lowest-rating">
                      Lowest Avg Rating
                    </SelectItem>
                    <SelectItem value="most-negative">Most Negative</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Sentiment analysis summary */}
            <div className="flex items-center gap-2 ml-auto">
              {analysisResults.size > 0 ? (
                <>
                  <Badge
                    variant="outline"
                    className="font-doodle text-xs bg-green-50 text-green-700 border-green-200"
                  >
                    {
                      Array.from(analysisResults.values()).filter(
                        (a) => a.sentiment === "positive",
                      ).length
                    }{" "}
                    positive
                  </Badge>
                  <Badge
                    variant="outline"
                    className="font-doodle text-xs bg-gray-50 text-gray-600 border-gray-200"
                  >
                    {
                      Array.from(analysisResults.values()).filter(
                        (a) => a.sentiment === "neutral",
                      ).length
                    }{" "}
                    neutral
                  </Badge>
                  <Badge
                    variant="outline"
                    className="font-doodle text-xs bg-red-50 text-red-700 border-red-200"
                  >
                    {
                      Array.from(analysisResults.values()).filter(
                        (a) => a.sentiment === "negative",
                      ).length
                    }{" "}
                    negative
                  </Badge>
                </>
              ) : (
                <span className="font-doodle text-xs text-doodle-text/40 italic">
                  Click &ldquo;Analyze with AI&rdquo; to see sentiment
                  breakdown, content flags &amp; suggested replies
                </span>
              )}
            </div>
          </div>
        </section>

        {/* Filters Section */}
        <section className="container mx-auto px-4 pb-4">
          <div className="doodle-card p-4 space-y-4">
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
                    {[5, 4, 3, 2, 1].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        <span className="flex items-center gap-1">
                          {n}{" "}
                          <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={moderationFilter}
                  onValueChange={handleModerationFilterChange}
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

                {analysisResults.size > 0 && (
                  <Select
                    value={sentimentFilter}
                    onValueChange={setSentimentFilter}
                  >
                    <SelectTrigger className="w-[140px] font-doodle text-sm h-9">
                      <SelectValue placeholder="Sentiment" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Sentiment</SelectItem>
                      <SelectItem value="positive">Positive</SelectItem>
                      <SelectItem value="neutral">Neutral</SelectItem>
                      <SelectItem value="negative">Negative</SelectItem>
                    </SelectContent>
                  </Select>
                )}

                <div className="flex items-center gap-1">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={`w-[140px] font-doodle text-xs h-9 justify-start gap-1 ${dateFrom ? "" : "text-doodle-text/40"}`}
                      >
                        <CalendarIcon className="w-3 h-3" />
                        {dateFrom
                          ? formatDateShort(dateFrom)
                          : reviewDateRange.earliest
                            ? formatDateShort(reviewDateRange.earliest)
                            : "From"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={dateFrom}
                        onSelect={(d) => setDateFrom(d)}
                        disabled={(d) =>
                          (dateTo ? d > dateTo : false) ||
                          (reviewDateRange.latest
                            ? d > reviewDateRange.latest
                            : false)
                        }
                        defaultMonth={dateFrom ?? reviewDateRange.earliest}
                        initialFocus
                      />
                      {dateFrom && (
                        <div className="px-3 pb-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full font-doodle text-xs h-7"
                            onClick={() => setDateFrom(undefined)}
                          >
                            Clear
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                  <span className="text-doodle-text/40">–</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={`w-[140px] font-doodle text-xs h-9 justify-start gap-1 ${dateTo ? "" : "text-doodle-text/40"}`}
                      >
                        <CalendarIcon className="w-3 h-3" />
                        {dateTo
                          ? formatDateShort(dateTo)
                          : reviewDateRange.latest
                            ? formatDateShort(reviewDateRange.latest)
                            : "To"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={dateTo}
                        onSelect={(d) => setDateTo(d)}
                        disabled={(d) =>
                          (dateFrom ? d < dateFrom : false) ||
                          (reviewDateRange.latest
                            ? d > reviewDateRange.latest
                            : false)
                        }
                        defaultMonth={dateTo ?? reviewDateRange.latest}
                        initialFocus
                      />
                      {dateTo && (
                        <div className="px-3 pb-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full font-doodle text-xs h-7"
                            onClick={() => setDateTo(undefined)}
                          >
                            Clear
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="font-doodle text-xs gap-1 h-9"
                >
                  <X className="w-3 h-3" /> Clear Filters
                </Button>
              )}
            </div>
          </div>
        </section>

        {/* Main content */}
        <section className="container mx-auto px-4 pb-12">
          {/* Top Pagination */}
          {showPagination && <div className="mb-4">{paginationBar}</div>}

          {/* Bulk Actions Bar */}
          {filteredReviews.length > 0 && viewMode === "list" && (
            <div className="doodle-card p-3 mb-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 flex-wrap">
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
                  {/* Sentiment quick-select buttons (visible after AI analysis) */}
                  {analysisResults.size > 0 && (
                    <>
                      <span className="text-doodle-text/30">|</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="font-doodle text-xs h-7 gap-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => {
                          const negativeIds = filteredReviews
                            .filter(
                              (r) =>
                                analysisResults.get(r.id)?.sentiment ===
                                "negative",
                            )
                            .map((r) => r.id);
                          setSelectedReviews(new Set(negativeIds));
                        }}
                      >
                        Select negative (
                        {
                          filteredReviews.filter(
                            (r) =>
                              analysisResults.get(r.id)?.sentiment ===
                              "negative",
                          ).length
                        }
                        )
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="font-doodle text-xs h-7 gap-1 text-green-600 hover:text-green-700 hover:bg-green-50"
                        onClick={() => {
                          const positiveIds = filteredReviews
                            .filter(
                              (r) =>
                                analysisResults.get(r.id)?.sentiment ===
                                "positive",
                            )
                            .map((r) => r.id);
                          setSelectedReviews(new Set(positiveIds));
                        }}
                      >
                        Select positive (
                        {
                          filteredReviews.filter(
                            (r) =>
                              analysisResults.get(r.id)?.sentiment ===
                              "positive",
                          ).length
                        }
                        )
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="font-doodle text-xs h-7 gap-1 text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          const neutralIds = filteredReviews
                            .filter(
                              (r) =>
                                analysisResults.get(r.id)?.sentiment ===
                                "neutral",
                            )
                            .map((r) => r.id);
                          setSelectedReviews(new Set(neutralIds));
                        }}
                      >
                        Select neutral (
                        {
                          filteredReviews.filter(
                            (r) =>
                              analysisResults.get(r.id)?.sentiment ===
                              "neutral",
                          ).length
                        }
                        )
                      </Button>
                    </>
                  )}
                </div>
                {selectedReviews.size > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      onClick={handleBulkApprove}
                      className="font-doodle gap-1 h-8"
                    >
                      <CheckCircle className="w-4 h-4" /> Approve (
                      {selectedReviews.size})
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleBulkReply}
                      disabled={isAnalyzing}
                      className="font-doodle gap-1 h-8"
                    >
                      <Sparkles className="w-4 h-4" /> AI Reply (
                      {
                        filteredReviews.filter(
                          (r) => selectedReviews.has(r.id) && !r.existingReply,
                        ).length
                      }
                      )
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleBulkDelete}
                      className="font-doodle gap-1 h-8"
                    >
                      <Trash2 className="w-4 h-4" /> Delete (
                      {selectedReviews.size})
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Content area */}
          <div className="space-y-4">
            {isLoading ? (
              <TableSkeleton rows={6} cols={4} />
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
            ) : viewMode === "list" ? (
              filteredReviews.map(renderReviewCard)
            ) : viewMode === "group-product" ? (
              productGroups.map((group) => (
                <div key={group.key} className="doodle-card overflow-hidden">
                  <button
                    onClick={() => toggleGroup(group.key)}
                    className="w-full p-4 flex items-center gap-3 hover:bg-doodle-primary/5 transition-colors text-left"
                  >
                    {expandedGroups.has(group.key) ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                    <Link
                      to={`/product/${group.productId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-doodle font-bold text-doodle-text hover:underline"
                    >
                      {group.label}
                    </Link>
                    <Badge variant="outline" className="font-doodle text-xs">
                      {group.items.length} reviews
                    </Badge>
                    <div className="flex items-center gap-1">
                      <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                      <span className="font-doodle text-xs text-doodle-text/60">
                        {group.avgRating.toFixed(1)}
                      </span>
                    </div>
                    {group.negCount > 0 && (
                      <Badge
                        variant="outline"
                        className="font-doodle text-xs bg-red-50 text-red-600 border-red-200"
                      >
                        {group.negCount} negative
                      </Badge>
                    )}
                  </button>
                  {expandedGroups.has(group.key) && (
                    <div className="border-t border-dashed border-doodle-text/10 p-4 space-y-3">
                      {group.items.map(renderReviewCard)}
                    </div>
                  )}
                </div>
              ))
            ) : (
              customerGroups.map((group) => (
                <div key={group.key} className="doodle-card overflow-hidden">
                  <button
                    onClick={() => toggleGroup(group.key)}
                    className="w-full p-4 flex items-center gap-3 hover:bg-doodle-primary/5 transition-colors text-left"
                  >
                    {expandedGroups.has(group.key) ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                    {group.userId ? (
                      <Link
                        to={`/customers/${group.userId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-doodle font-bold text-doodle-blue hover:underline"
                      >
                        {group.label}
                      </Link>
                    ) : (
                      <span className="font-doodle font-bold text-doodle-text">
                        {group.label}
                      </span>
                    )}
                    <Badge variant="outline" className="font-doodle text-xs">
                      {group.items.length} reviews
                    </Badge>
                    <div className="flex items-center gap-1">
                      <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" />
                      <span className="font-doodle text-xs text-doodle-text/60">
                        {group.avgRating.toFixed(1)} avg
                      </span>
                    </div>
                    {group.negCount > 0 && (
                      <Badge
                        variant="outline"
                        className="font-doodle text-xs bg-red-50 text-red-600 border-red-200"
                      >
                        {group.negCount} negative
                      </Badge>
                    )}
                    {group.userId && (
                      <ExternalLink className="w-3 h-3 text-doodle-text/40 ml-auto" />
                    )}
                  </button>
                  {expandedGroups.has(group.key) && (
                    <div className="border-t border-dashed border-doodle-text/10 p-4 space-y-3">
                      {group.items.map(renderReviewCard)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* Bottom Pagination (hidden when product-specific) */}
        {!urlProductIdNum &&
          (cursorStack.length > 0 || apiData?.hasNextPage) && (
            <section className="container mx-auto px-4 pb-8">
              {paginationBar}
            </section>
          )}
      </main>
      <Footer />
    </div>
  );
};

export default ReviewsPage;
