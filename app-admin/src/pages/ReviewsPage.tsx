import React, { useState, useMemo } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Star, Trash2, CheckCircle, Sparkles, MessageSquare, TrendingUp, ThumbsUp, ThumbsDown, Minus, Loader2, RefreshCw, Filter, X, Search, Square, CheckSquare } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import AdminHeader from '@/components/AdminHeader';
import Footer from '@/components/Footer';
import { useAuth } from '@/context/AuthContext';
import { mockReviews } from '@/data/mockReviews';
import { getProductById } from '@/data/mockData';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Sentiment = 'positive' | 'neutral' | 'negative';

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
  sentiment?: Sentiment;
  aiSuggestedResponse?: string;
  flags?: string[];
}

// Simulated AI analysis functions
const analyzeSentiment = (review: { rating: number; comment: string; title: string }): Sentiment => {
  // Simple heuristic based on rating and keywords
  const positiveWords = ['great', 'excellent', 'amazing', 'love', 'best', 'fantastic', 'perfect', 'incredible', 'recommend'];
  const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'worst', 'disappointed', 'poor', 'issue', 'problem'];
  
  const text = `${review.title} ${review.comment}`.toLowerCase();
  const positiveCount = positiveWords.filter(w => text.includes(w)).length;
  const negativeCount = negativeWords.filter(w => text.includes(w)).length;
  
  if (review.rating >= 4 || positiveCount > negativeCount) return 'positive';
  if (review.rating <= 2 || negativeCount > positiveCount) return 'negative';
  return 'neutral';
};

const generateAIResponse = (review: { title: string; comment: string; rating: number; userName: string }): string => {
  const responses = {
    positive: [
      `Thank you so much for your wonderful review, ${review.userName}! We're thrilled to hear that you enjoyed your experience. Your feedback means a lot to our team!`,
      `We really appreciate you taking the time to share your positive experience, ${review.userName}! It's customers like you that make what we do worthwhile.`,
      `What a fantastic review, ${review.userName}! Thank you for choosing us and for sharing your experience. We look forward to serving you again!`
    ],
    neutral: [
      `Thank you for your feedback, ${review.userName}. We appreciate you sharing your thoughts and will use them to improve our products and services.`,
      `We value your honest review, ${review.userName}. If there's anything we can do to make your next experience better, please let us know.`
    ],
    negative: [
      `We're sorry to hear about your experience, ${review.userName}. Your feedback is important to us, and we'd love the opportunity to make things right. Please reach out to our support team.`,
      `Thank you for bringing this to our attention, ${review.userName}. We take all feedback seriously and will work to address the issues you've mentioned. Please contact us so we can help resolve this.`
    ]
  };
  
  const sentiment = analyzeSentiment(review);
  const options = responses[sentiment];
  return options[Math.floor(Math.random() * options.length)];
};

const detectFlags = (review: { comment: string; title: string }): string[] => {
  const flags: string[] = [];
  const text = `${review.title} ${review.comment}`.toLowerCase();
  
  if (text.length < 20) flags.push('Short Review');
  if (/\b(spam|fake|scam)\b/.test(text)) flags.push('Potential Spam');
  if (/\b(refund|money back|return)\b/.test(text)) flags.push('Refund Request');
  if (/!{3,}/.test(text) || /\?{3,}/.test(text)) flags.push('Excessive Punctuation');
  
  return flags;
};

const ReviewsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [reviews, setReviews] = useState<ReviewWithAI[]>(mockReviews);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  
  // Bulk selection states
  const [selectedReviews, setSelectedReviews] = useState<Set<string>>(new Set());
  
  // Filter states
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sentimentFilter, setSentimentFilter] = useState<string>('all');
  const [ratingFilter, setRatingFilter] = useState<string>('all');
  const [flagFilter, setFlagFilter] = useState<string>('all');

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Get all unique flags from reviews
  const allFlags = useMemo(() => {
    const flags = new Set<string>();
    reviews.forEach(r => r.flags?.forEach(f => flags.add(f)));
    return Array.from(flags);
  }, [reviews]);

  // Filter reviews
  const filteredReviews = useMemo(() => {
    return reviews.filter(review => {
      // Search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const product = getProductById(review.productId);
        const searchableText = `${review.title} ${review.comment} ${review.userName} ${product?.Name || ''}`.toLowerCase();
        if (!searchableText.includes(query)) {
          return false;
        }
      }
      
      // Sentiment filter
      if (sentimentFilter !== 'all' && review.sentiment !== sentimentFilter) {
        return false;
      }
      
      // Rating filter
      if (ratingFilter !== 'all') {
        const rating = parseInt(ratingFilter);
        if (review.rating !== rating) return false;
      }
      
      // Flag filter
      if (flagFilter !== 'all') {
        if (flagFilter === 'flagged' && (!review.flags || review.flags.length === 0)) {
          return false;
        }
        if (flagFilter !== 'flagged' && !review.flags?.includes(flagFilter)) {
          return false;
        }
      }
      
      return true;
    });
  }, [reviews, searchQuery, sentimentFilter, ratingFilter, flagFilter]);

  const hasActiveFilters = searchQuery.trim() !== '' || sentimentFilter !== 'all' || ratingFilter !== 'all' || flagFilter !== 'all';
  
  const clearFilters = () => {
    setSearchQuery('');
    setSentimentFilter('all');
    setRatingFilter('all');
    setFlagFilter('all');
  };

  const runAIAnalysis = async () => {
    setIsAnalyzing(true);
    
    // Simulate AI processing delay
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const analyzedReviews = reviews.map(review => ({
      ...review,
      sentiment: analyzeSentiment(review),
      aiSuggestedResponse: generateAIResponse(review),
      flags: detectFlags(review)
    }));
    
    setReviews(analyzedReviews);
    setIsAnalyzing(false);
    toast({ title: "AI Analysis Complete", description: `Analyzed ${reviews.length} reviews with sentiment, flags, and response suggestions.` });
  };

  const handleApprove = (id: string) => {
    toast({ title: "Review Approved", description: "The review has been approved." });
  };

  const handleDelete = (id: string) => {
    setReviews(prev => prev.filter(r => r.id !== id));
    setSelectedReviews(prev => {
      const newSet = new Set(prev);
      newSet.delete(id);
      return newSet;
    });
    toast({ title: "Review Deleted", description: "The review has been removed.", variant: "destructive" });
  };

  // Bulk actions
  const toggleSelectReview = (id: string) => {
    setSelectedReviews(prev => {
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
      setSelectedReviews(new Set(filteredReviews.map(r => r.id)));
    }
  };

  const handleBulkApprove = () => {
    if (selectedReviews.size === 0) return;
    toast({ 
      title: "Reviews Approved", 
      description: `${selectedReviews.size} review${selectedReviews.size > 1 ? 's have' : ' has'} been approved.` 
    });
    setSelectedReviews(new Set());
  };

  const handleBulkDelete = () => {
    if (selectedReviews.size === 0) return;
    const count = selectedReviews.size;
    setReviews(prev => prev.filter(r => !selectedReviews.has(r.id)));
    setSelectedReviews(new Set());
    toast({ 
      title: "Reviews Deleted", 
      description: `${count} review${count > 1 ? 's have' : ' has'} been removed.`, 
      variant: "destructive" 
    });
  };

  const copyResponse = (response: string) => {
    navigator.clipboard.writeText(response);
    toast({ title: "Copied!", description: "AI response copied to clipboard." });
  };

  const getSentimentIcon = (sentiment?: Sentiment) => {
    switch (sentiment) {
      case 'positive': return <ThumbsUp className="w-4 h-4 text-doodle-green" />;
      case 'negative': return <ThumbsDown className="w-4 h-4 text-doodle-accent" />;
      case 'neutral': return <Minus className="w-4 h-4 text-yellow-500" />;
      default: return null;
    }
  };

  const getSentimentBadge = (sentiment?: Sentiment) => {
    if (!sentiment) return null;
    const variants: Record<Sentiment, string> = {
      positive: 'bg-doodle-green/20 text-doodle-green border-doodle-green/30',
      negative: 'bg-doodle-accent/20 text-doodle-accent border-doodle-accent/30',
      neutral: 'bg-yellow-500/20 text-yellow-600 border-yellow-500/30'
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
    const analyzed = reviews.filter(r => r.sentiment);
    if (analyzed.length === 0) return null;

    const sentimentCounts = {
      positive: analyzed.filter(r => r.sentiment === 'positive').length,
      neutral: analyzed.filter(r => r.sentiment === 'neutral').length,
      negative: analyzed.filter(r => r.sentiment === 'negative').length
    };

    const avgRating = reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length;
    
    const themes: string[] = [];
    const text = reviews.map(r => `${r.title} ${r.comment}`).join(' ').toLowerCase();
    if (text.includes('quality')) themes.push('Product Quality');
    if (text.includes('price') || text.includes('value')) themes.push('Value for Money');
    if (text.includes('delivery') || text.includes('shipping')) themes.push('Shipping Experience');
    if (text.includes('service') || text.includes('support')) themes.push('Customer Service');
    if (text.includes('easy') || text.includes('simple')) themes.push('Ease of Use');

    return {
      total: reviews.length,
      avgRating: avgRating.toFixed(1),
      sentimentCounts,
      themes: themes.length > 0 ? themes : ['General Feedback'],
      recommendation: sentimentCounts.positive > sentimentCounts.negative 
        ? 'Customer sentiment is largely positive. Focus on maintaining quality and addressing the few concerns raised.'
        : sentimentCounts.negative > sentimentCounts.positive
        ? 'Several customers have expressed concerns. Prioritize addressing common issues to improve satisfaction.'
        : 'Customer sentiment is mixed. Review individual feedback to identify areas for improvement.'
    };
  }, [reviews]);

  const hasAIAnalysis = reviews.some(r => r.sentiment);

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">

        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div>
                <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-2">Review Moderation</h1>
                <p className="font-doodle text-doodle-text/70">
                  {hasActiveFilters 
                    ? `Showing ${filteredReviews.length} of ${reviews.length} reviews` 
                    : `${reviews.length} reviews to moderate`}
                </p>
              </div>
              
              <div className="flex gap-2 flex-wrap">
                <Button
                  onClick={runAIAnalysis}
                  disabled={isAnalyzing}
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
                  {isAnalyzing ? 'Analyzing...' : hasAIAnalysis ? 'Re-analyze' : 'Run AI Analysis'}
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
                              <p className="font-doodle text-2xl font-bold text-doodle-text">{aiSummary.total}</p>
                              <p className="font-doodle text-xs text-doodle-text/60">Total Reviews</p>
                            </div>
                            <div className="doodle-card p-3 text-center">
                              <p className="font-doodle text-2xl font-bold text-doodle-accent">{aiSummary.avgRating}★</p>
                              <p className="font-doodle text-xs text-doodle-text/60">Avg Rating</p>
                            </div>
                          </div>
                          
                          <div className="doodle-card p-4">
                            <p className="font-doodle text-sm font-bold mb-3">Sentiment Distribution</p>
                            <div className="flex gap-2">
                              <div className="flex-1 text-center p-2 rounded bg-doodle-green/10">
                                <ThumbsUp className="w-4 h-4 mx-auto text-doodle-green mb-1" />
                                <p className="font-doodle text-lg font-bold text-doodle-green">{aiSummary.sentimentCounts.positive}</p>
                                <p className="font-doodle text-xs text-doodle-text/60">Positive</p>
                              </div>
                              <div className="flex-1 text-center p-2 rounded bg-yellow-500/10">
                                <Minus className="w-4 h-4 mx-auto text-yellow-500 mb-1" />
                                <p className="font-doodle text-lg font-bold text-yellow-600">{aiSummary.sentimentCounts.neutral}</p>
                                <p className="font-doodle text-xs text-doodle-text/60">Neutral</p>
                              </div>
                              <div className="flex-1 text-center p-2 rounded bg-doodle-accent/10">
                                <ThumbsDown className="w-4 h-4 mx-auto text-doodle-accent mb-1" />
                                <p className="font-doodle text-lg font-bold text-doodle-accent">{aiSummary.sentimentCounts.negative}</p>
                                <p className="font-doodle text-xs text-doodle-text/60">Negative</p>
                              </div>
                            </div>
                          </div>

                          <div className="doodle-card p-4">
                            <p className="font-doodle text-sm font-bold mb-2">Common Themes</p>
                            <div className="flex flex-wrap gap-2">
                              {aiSummary.themes.map((theme, i) => (
                                <Badge key={i} variant="secondary" className="font-doodle">
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
                            <p className="font-doodle text-sm text-doodle-text/80">{aiSummary.recommendation}</p>
                          </div>

                          <p className="font-doodle text-[10px] text-doodle-text/40 text-center">
                            Demo mode - simulated AI analysis
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
                  onClick={() => setSearchQuery('')}
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
                <span className="font-doodle text-sm font-bold text-doodle-text">Filters:</span>
              </div>
              
              <div className="flex flex-wrap gap-3 flex-1">
                <Select value={sentimentFilter} onValueChange={setSentimentFilter}>
                  <SelectTrigger className="w-[140px] font-doodle text-sm h-9">
                    <SelectValue placeholder="Sentiment" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sentiment</SelectItem>
                    <SelectItem value="positive">
                      <span className="flex items-center gap-2">
                        <ThumbsUp className="w-3 h-3 text-doodle-green" /> Positive
                      </span>
                    </SelectItem>
                    <SelectItem value="neutral">
                      <span className="flex items-center gap-2">
                        <Minus className="w-3 h-3 text-yellow-500" /> Neutral
                      </span>
                    </SelectItem>
                    <SelectItem value="negative">
                      <span className="flex items-center gap-2">
                        <ThumbsDown className="w-3 h-3 text-doodle-accent" /> Negative
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
                      <span className="flex items-center gap-1">5 <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" /></span>
                    </SelectItem>
                    <SelectItem value="4">
                      <span className="flex items-center gap-1">4 <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" /></span>
                    </SelectItem>
                    <SelectItem value="3">
                      <span className="flex items-center gap-1">3 <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" /></span>
                    </SelectItem>
                    <SelectItem value="2">
                      <span className="flex items-center gap-1">2 <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" /></span>
                    </SelectItem>
                    <SelectItem value="1">
                      <span className="flex items-center gap-1">1 <Star className="w-3 h-3 fill-doodle-accent text-doodle-accent" /></span>
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
                    {allFlags.map(flag => (
                      <SelectItem key={flag} value={flag}>{flag}</SelectItem>
                    ))}
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
                    checked={selectedReviews.size === filteredReviews.length && filteredReviews.length > 0}
                    onCheckedChange={toggleSelectAll}
                    className="border-2"
                  />
                  <span className="font-doodle text-sm text-doodle-text">
                    {selectedReviews.size === 0 
                      ? 'Select all' 
                      : `${selectedReviews.size} selected`}
                  </span>
                  {selectedReviews.size > 0 && selectedReviews.size < filteredReviews.length && (
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
                <p className="font-doodle text-doodle-text/60">No reviews match your filters.</p>
                <Button variant="link" onClick={clearFilters} className="font-doodle mt-2">
                  Clear filters
                </Button>
              </div>
            ) : filteredReviews.map((review) => {
              const product = getProductById(review.productId);
              const isSelected = selectedReviews.has(review.id);
              return (
                <div key={review.id} className={`doodle-card p-4 transition-all ${isSelected ? 'ring-2 ring-doodle-primary bg-doodle-primary/5' : ''}`}>
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
                              <Star key={i} className={`w-4 h-4 ${i < review.rating ? 'fill-doodle-accent text-doodle-accent' : 'text-doodle-text/20'}`} />
                            ))}
                          </div>
                          <span className="font-doodle text-sm text-doodle-text/60">by {review.userName}</span>
                          {getSentimentBadge(review.sentiment)}
                          {review.flags && review.flags.length > 0 && review.flags.map((flag, i) => (
                            <Badge key={i} variant="destructive" className="font-doodle text-xs">
                              {flag}
                            </Badge>
                          ))}
                        </div>
                        <h3 className="font-doodle font-bold text-doodle-text">{review.title}</h3>
                        <p className="font-doodle text-sm text-doodle-text/70 mt-1">{review.comment}</p>
                        <p className="font-doodle text-xs text-doodle-accent mt-2">
                          Product: {product?.Name || 'Unknown'} • {new Date(review.createdAt).toLocaleDateString()}
                        </p>
                        
                        {review.aiSuggestedResponse && (
                          <div className="mt-3 p-3 bg-doodle-primary/5 rounded-lg border border-doodle-primary/20">
                            <div className="flex items-center gap-2 mb-2">
                              <Sparkles className="w-3 h-3 text-doodle-primary" />
                              <span className="font-doodle text-xs font-bold text-doodle-primary">AI Suggested Response</span>
                            </div>
                            <p className="font-doodle text-sm text-doodle-text/80">{review.aiSuggestedResponse}</p>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="mt-2 font-doodle text-xs h-7"
                              onClick={() => copyResponse(review.aiSuggestedResponse!)}
                            >
                              <MessageSquare className="w-3 h-3 mr-1" />
                              Copy Response
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button onClick={() => handleApprove(review.id)} className="doodle-button doodle-button-primary p-2" title="Approve">
                            <CheckCircle className="w-5 h-5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Approve Review</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button onClick={() => handleDelete(review.id)} className="doodle-button p-2 hover:bg-doodle-accent/10 hover:text-doodle-accent" title="Delete">
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Delete Review</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ReviewsPage;
