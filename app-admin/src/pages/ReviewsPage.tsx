import React, { useState, useMemo, useEffect } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  ArrowLeft,
  Star,
  Trash2,
  CheckCircle,
  Sparkles,
  MessageSquare,
  TrendingUp,
  ThumbsUp,
  ThumbsDown,
  Minus,
  Loader2,
  RefreshCw,
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
  useReviewTotalCount,
  approveReview,
  submitReply,
  deleteReview,
} from "@/hooks/useAdminReviews";
import { useAdminAllProducts } from "@/hooks/useAdminProducts";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

import { getFunctionsApiUrl } from "@/lib/utils";
import { getAppUrl } from "@/lib/utils";

type Sentiment = "positive" | "neutral" | "negative";

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
  sentiment?: Sentiment;
  aiSuggestedResponse?: string;
  flags?: string[];
  aiError?: string;
}

// ─── AI analysis is performed server-side via POST /api/reviews/analyze-batch

const ReviewsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [dabCursor, setDabCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const { data: apiData, isLoading: reviewsLoading } =
    useAdminReviews(dabCursor);
  const { data: totalReviewCount } = useReviewTotalCount();
  const { data: allProducts = [] } = useAdminAllProducts();
  const productMap = useMemo(
    () => new Map(allProducts.map((p) => [p.ProductID, p])),
    [allProducts],
  );
  const [reviews, setReviews] = useState<ReviewWithAI[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  // Sync from API when cursor changes or data first loads
  useEffect(() => {
    const items = apiData?.items;
    if (items && items.length > 0) {
      setReviews((prev) => {
        // Preserve AI analysis results already in local state
        const prevMap = new Map(prev.map((r) => [r.id, r]));
        return items.map((item) => {
          const existing = prevMap.get(item.id);
          return {
            ...(item as ReviewWithAI),
            sentiment: existing?.sentiment,
            aiSuggestedResponse: existing?.aiSuggestedResponse,
            flags: existing?.flags,
            aiError: existing?.aiError,
          };
        });
      });
    }
  }, [apiData]);

  // Bulk selection states
  const [selectedReviews, setSelectedReviews] = useState<Set<string>>(
    new Set(),
  );

  // Filter states
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sentimentFilter, setSentimentFilter] = useState<string>("all");
  const [ratingFilter, setRatingFilter] = useState<string>("all");
  const [flagFilter, setFlagFilter] = useState<string>("all");
  const [moderationFilter, setModerationFilter] = useState<string>("all");

  // Get all unique flags from reviews
  const allFlags = useMemo(() => {
    const flags = new Set<string>();
    reviews.forEach((r) => r.flags?.forEach((f) => flags.add(f)));
    return Array.from(flags);
  }, [reviews]);

  // Filter reviews
  const filteredReviews = useMemo(() => {
    return reviews.filter((review) => {
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

      // Sentiment filter
      if (sentimentFilter !== "all" && review.sentiment !== sentimentFilter) {
        return false;
      }

      // Rating filter
      if (ratingFilter !== "all") {
        const rating = parseInt(ratingFilter);
        if (review.rating !== rating) return false;
      }

      // Flag filter
      if (flagFilter !== "all") {
        if (
          flagFilter === "flagged" &&
          (!review.flags || review.flags.length === 0)
        ) {
          return false;
        }
        if (flagFilter !== "flagged" && !review.flags?.includes(flagFilter)) {
          return false;
        }
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
    sentimentFilter,
    ratingFilter,
    flagFilter,
    moderationFilter,
  ]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    sentimentFilter !== "all" ||
    ratingFilter !== "all" ||
    flagFilter !== "all" ||
    moderationFilter !== "all";

  const clearFilters = () => {
    setSearchQuery("");
    setSentimentFilter("all");
    setRatingFilter("all");
    setFlagFilter("all");
    setModerationFilter("all");
  };

  const runAIAnalysis = async () => {
    setIsAnalyzing(true);

    try {
      const payload = reviews
        .filter((r) => selectedReviews.has(r.id))
        .map((r) => ({
          productReviewId: parseInt(r.id, 10) || 0,
          rating: r.rating,
          comments: r.comment,
          reviewerName: r.userName,
          productName: productMap.get(r.productId)?.Name,
        }));

      const res = await fetch(
        `${getFunctionsApiUrl()}/api/reviews/analyze-batch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviews: payload }),
        },
      );

      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }

      const data: {
        analyses: Array<{
          productReviewId: number;
          sentiment: Sentiment;
          flags: string[];
          suggestedResponse?: string;
          error?: string;
        }>;
      } = await res.json();

      const analysisMap = new Map(
        data.analyses.map((a) => [a.productReviewId, a]),
      );

      setReviews((prev) =>
        prev.map((r) => {
          const analysis = analysisMap.get(parseInt(r.id, 10) || 0);
          if (!analysis) return r;
          return {
            ...r,
            sentiment: analysis.error ? r.sentiment : analysis.sentiment,
            aiSuggestedResponse: analysis.error
              ? undefined
              : analysis.suggestedResponse,
            flags: analysis.error ? r.flags : analysis.flags,
            aiError: analysis.error,
          };
        }),
      );

      const errorCount = data.analyses.filter((a) => a.error).length;
      toast({
        title: "AI Analysis Complete",
        description:
          errorCount > 0
            ? `Analysed ${data.analyses.length - errorCount} reviews. ${errorCount} could not be analysed.`
            : `Analysed ${data.analyses.length} reviews with sentiment, flags, and response suggestions.`,
      });
    } catch (err) {
      console.error("runAIAnalysis error:", err);
      toast({
        title: "Analysis Failed",
        description: "Could not reach the analysis service. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
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

  const copyResponse = (response: string) => {
    navigator.clipboard.writeText(response);
    toast({
      title: "Copied!",
      description: "AI response copied to clipboard.",
    });
  };

  const handlePostReply = async (review: ReviewWithAI, replyText: string) => {
    try {
      const saved = await submitReply(review.id, replyText);
      await approveReview(review.id);
      setReviews((prev) =>
        prev.map((r) =>
          r.id === review.id
            ? {
                ...r,
                isModerated: true,
                existingReply: {
                  replyId: saved.ProductReviewReplyID,
                  text: saved.Reply,
                  by: saved.RepliedBy,
                  date: saved.ReplyDate,
                },
              }
            : r,
        ),
      );
      toast({
        title: "Reply Posted",
        description: "The reply has been saved and the review approved.",
      });
    } catch {
      toast({
        title: "Post Reply Failed",
        description: "Could not save the reply. Please try again.",
        variant: "destructive",
      });
    }
  };

  const getSentimentIcon = (sentiment?: Sentiment) => {
    switch (sentiment) {
      case "positive":
        return <ThumbsUp className="w-4 h-4 text-doodle-green" />;
      case "negative":
        return <ThumbsDown className="w-4 h-4 text-doodle-accent" />;
      case "neutral":
        return <Minus className="w-4 h-4 text-yellow-500" />;
      default:
        return null;
    }
  };

  const getSentimentBadge = (sentiment?: Sentiment) => {
    if (!sentiment) return null;
    const variants: Record<Sentiment, string> = {
      positive: "bg-doodle-green/20 text-doodle-green border-doodle-green/30",
      negative:
        "bg-doodle-accent/20 text-doodle-accent border-doodle-accent/30",
      neutral: "bg-yellow-500/20 text-yellow-600 border-yellow-500/30",
    };
    return (
      <Badge className={`font-doodle text-xs ${variants[sentiment]}`}>
        {getSentimentIcon(sentiment)}
        <span className="ml-1 capitalize">{sentiment}</span>
      </Badge>
    );
  };

  // Generate AI summary
  const aiSummary = useMemo(() => {
    const analyzed = reviews.filter((r) => r.sentiment);
    if (analyzed.length === 0) return null;

    const sentimentCounts = {
      positive: analyzed.filter((r) => r.sentiment === "positive").length,
      neutral: analyzed.filter((r) => r.sentiment === "neutral").length,
      negative: analyzed.filter((r) => r.sentiment === "negative").length,
    };

    const avgRating =
      reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length;

    const themes: string[] = [];
    const text = reviews
      .map((r) => `${r.title} ${r.comment}`)
      .join(" ")
      .toLowerCase();
    if (text.includes("quality")) themes.push("Product Quality");
    if (text.includes("price") || text.includes("value"))
      themes.push("Value for Money");
    if (text.includes("delivery") || text.includes("shipping"))
      themes.push("Shipping Experience");
    if (text.includes("service") || text.includes("support"))
      themes.push("Customer Service");
    if (text.includes("easy") || text.includes("simple"))
      themes.push("Ease of Use");

    return {
      total: reviews.length,
      avgRating: avgRating.toFixed(1),
      sentimentCounts,
      themes: themes.length > 0 ? themes : ["General Feedback"],
      recommendation:
        sentimentCounts.positive > sentimentCounts.negative
          ? "Customer sentiment is largely positive. Focus on maintaining quality and addressing the few concerns raised."
          : sentimentCounts.negative > sentimentCounts.positive
            ? "Several customers have expressed concerns. Prioritize addressing common issues to improve satisfaction."
            : "Customer sentiment is mixed. Review individual feedback to identify areas for improvement.",
    };
  }, [reviews]);

  // Redirect if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const hasAIAnalysis = reviews.some((r) => r.sentiment);

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
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

              <div className="flex gap-2 flex-wrap">
                <Button
                  onClick={runAIAnalysis}
                  disabled={isAnalyzing || selectedReviews.size === 0}
                  className="font-doodle gap-2"
                  variant="outline"
                >
                  {isAnalyzing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : hasAIAnalysis ? (
                    <RefreshCw className="w-4 h-4" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  {isAnalyzing
                    ? "Analyzing..."
                    : hasAIAnalysis
                      ? `Re-analyze (${selectedReviews.size})`
                      : `Run AI Analysis (${selectedReviews.size})`}
                </Button>

                {hasAIAnalysis && (
                  <Dialog open={showSummary} onOpenChange={setShowSummary}>
                    <DialogTrigger asChild>
                      <Button variant="default" className="font-doodle gap-2">
                        <TrendingUp className="w-4 h-4" />
                        View AI Summary
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-lg">
                      <DialogHeader>
                        <DialogTitle className="font-doodle flex items-center gap-2">
                          <Sparkles className="w-5 h-5 text-doodle-accent" />
                          AI Review Summary
                        </DialogTitle>
                      </DialogHeader>
                      {aiSummary && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-2 gap-4">
                            <div className="doodle-card p-3 text-center">
                              <p className="font-doodle text-2xl font-bold text-doodle-text">
                                {aiSummary.total}
                              </p>
                              <p className="font-doodle text-xs text-doodle-text/60">
                                Total Reviews
                              </p>
                            </div>
                            <div className="doodle-card p-3 text-center">
                              <p className="font-doodle text-2xl font-bold text-doodle-accent">
                                {aiSummary.avgRating}★
                              </p>
                              <p className="font-doodle text-xs text-doodle-text/60">
                                Avg Rating
                              </p>
                            </div>
                          </div>

                          <div className="doodle-card p-4">
                            <p className="font-doodle text-sm font-bold mb-3">
                              Sentiment Distribution
                            </p>
                            <div className="flex gap-2">
                              <div className="flex-1 text-center p-2 rounded bg-doodle-green/10">
                                <ThumbsUp className="w-4 h-4 mx-auto text-doodle-green mb-1" />
                                <p className="font-doodle text-lg font-bold text-doodle-green">
                                  {aiSummary.sentimentCounts.positive}
                                </p>
                                <p className="font-doodle text-xs text-doodle-text/60">
                                  Positive
                                </p>
                              </div>
                              <div className="flex-1 text-center p-2 rounded bg-yellow-500/10">
                                <Minus className="w-4 h-4 mx-auto text-yellow-500 mb-1" />
                                <p className="font-doodle text-lg font-bold text-yellow-600">
                                  {aiSummary.sentimentCounts.neutral}
                                </p>
                                <p className="font-doodle text-xs text-doodle-text/60">
                                  Neutral
                                </p>
                              </div>
                              <div className="flex-1 text-center p-2 rounded bg-doodle-accent/10">
                                <ThumbsDown className="w-4 h-4 mx-auto text-doodle-accent mb-1" />
                                <p className="font-doodle text-lg font-bold text-doodle-accent">
                                  {aiSummary.sentimentCounts.negative}
                                </p>
                                <p className="font-doodle text-xs text-doodle-text/60">
                                  Negative
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="doodle-card p-4">
                            <p className="font-doodle text-sm font-bold mb-2">
                              Common Themes
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {aiSummary.themes.map((theme, i) => (
                                <Badge
                                  key={i}
                                  variant="secondary"
                                  className="font-doodle"
                                >
                                  {theme}
                                </Badge>
                              ))}
                            </div>
                          </div>

                          <div className="doodle-card p-4 bg-doodle-primary/5 border-doodle-primary/20">
                            <p className="font-doodle text-sm font-bold mb-2 flex items-center gap-2">
                              <Sparkles className="w-4 h-4 text-doodle-primary" />
                              AI Recommendation
                            </p>
                            <p className="font-doodle text-sm text-doodle-text/80">
                              {aiSummary.recommendation}
                            </p>
                          </div>

                          <p className="font-doodle text-[10px] text-doodle-text/40 text-center">
                            Powered by Azure AI
                          </p>
                        </div>
                      )}
                    </DialogContent>
                  </Dialog>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Filters Section */}
        <section className="container mx-auto px-4 pb-4">
          <div className="doodle-card p-4 space-y-4">
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
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-doodle-text/60" />
                <span className="font-doodle text-sm font-bold text-doodle-text">
                  Filters:
                </span>
              </div>

              <div className="flex flex-wrap gap-3 flex-1">
                <Select
                  value={sentimentFilter}
                  onValueChange={setSentimentFilter}
                >
                  <SelectTrigger className="w-[140px] font-doodle text-sm h-9">
                    <SelectValue placeholder="Sentiment" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sentiment</SelectItem>
                    <SelectItem value="positive">
                      <span className="flex items-center gap-2">
                        <ThumbsUp className="w-3 h-3 text-doodle-green" />{" "}
                        Positive
                      </span>
                    </SelectItem>
                    <SelectItem value="neutral">
                      <span className="flex items-center gap-2">
                        <Minus className="w-3 h-3 text-yellow-500" /> Neutral
                      </span>
                    </SelectItem>
                    <SelectItem value="negative">
                      <span className="flex items-center gap-2">
                        <ThumbsDown className="w-3 h-3 text-doodle-accent" />{" "}
                        Negative
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>

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

                <Select value={flagFilter} onValueChange={setFlagFilter}>
                  <SelectTrigger className="w-[150px] font-doodle text-sm h-9">
                    <SelectValue placeholder="Flags" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Reviews</SelectItem>
                    <SelectItem value="flagged">Flagged Only</SelectItem>
                    {allFlags.map((flag) => (
                      <SelectItem key={flag} value={flag}>
                        {flag}
                      </SelectItem>
                    ))}
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

            {!hasAIAnalysis && (
              <p className="font-doodle text-xs text-doodle-text/50 mt-3 flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                Run AI Analysis to enable sentiment and flag filtering
              </p>
            )}
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
            {filteredReviews.length === 0 ? (
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
                            {review.aiError ? (
                              <Badge
                                variant="outline"
                                className="font-doodle text-xs opacity-50"
                              >
                                Analysis unavailable
                              </Badge>
                            ) : (
                              <>
                                {getSentimentBadge(review.sentiment)}
                                {review.flags &&
                                  review.flags.length > 0 &&
                                  review.flags.map((flag, i) => (
                                    <Badge
                                      key={i}
                                      variant="destructive"
                                      className="font-doodle text-xs"
                                    >
                                      {flag}
                                    </Badge>
                                  ))}
                              </>
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
                          {review.existingReply ? (
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
                          ) : review.aiSuggestedResponse ? (
                            <div className="mt-3 p-3 bg-doodle-primary/5 rounded-lg border border-doodle-primary/20">
                              <div className="flex items-center gap-2 mb-2">
                                <Sparkles className="w-3 h-3 text-doodle-primary" />
                                <span className="font-doodle text-xs font-bold text-doodle-primary">
                                  AI Suggested Response
                                </span>
                              </div>
                              <p className="font-doodle text-sm text-doodle-text/80">
                                {review.aiSuggestedResponse}
                              </p>
                              <div className="flex gap-2 mt-2">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="font-doodle text-xs h-7"
                                  onClick={() =>
                                    copyResponse(review.aiSuggestedResponse!)
                                  }
                                >
                                  <MessageSquare className="w-3 h-3 mr-1" />
                                  Copy
                                </Button>
                                <Button
                                  size="sm"
                                  className="font-doodle text-xs h-7 gap-1"
                                  onClick={() =>
                                    handlePostReply(
                                      review,
                                      review.aiSuggestedResponse!,
                                    )
                                  }
                                >
                                  <CheckCircle className="w-3 h-3" />
                                  Post as Reply
                                </Button>
                              </div>
                            </div>
                          ) : null}
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

        {/* DAB page navigation — each page is up to 100 reviews */}
        {(cursorStack.length > 0 || apiData?.hasNextPage) && (
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
