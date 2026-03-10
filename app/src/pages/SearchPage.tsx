import React, { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  SlidersHorizontal,
  X,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import SearchBar from "@/components/SearchBar";
import ProductCard from "@/components/ProductCard";
import ProductModelCard from "@/components/ProductModelCard";
import {
  groupProductsByModel,
  isProductModelGroup,
} from "@/utils/productGrouping";
import {
  useProducts,
  useCategories,
  useSubcategories,
} from "@/hooks/useProducts";
import { Product, getSalePrice } from "@/types/product";
import { useAllReviews } from "@/hooks/useReviews";
import { useLanguage } from "@/context/LanguageContext";
import { useSemanticSearch } from "@/hooks/useSemanticSearch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SortOption =
  | "relevance"
  | "price-asc"
  | "price-desc"
  | "discount"
  | "rating";

const SearchPage: React.FC = () => {
  const { t } = useTranslation("common");
  const { selectedLanguage } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") || "";

  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 5000]);
  const [sortBy, setSortBy] = useState<SortOption>("rating");
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(12);
  const [semanticQuerySubmitted, setSemanticQuerySubmitted] =
    useState(initialQuery);

  const { data: products = [], isLoading: productsLoading } = useProducts();
  const { data: categories = [], isLoading: categoriesLoading } =
    useCategories(selectedLanguage);
  const { data: subcategories = [] } = useSubcategories(selectedLanguage);
  const { data: allReviews = [] } = useAllReviews();

  // Semantic search hook - always enabled when query is submitted
  const {
    data: semanticSearchData,
    isLoading: semanticSearchLoading,
    error: semanticSearchError,
  } = useSemanticSearch(
    semanticQuerySubmitted,
    semanticQuerySubmitted.length > 0,
  );

  const isLoading =
    productsLoading || categoriesLoading || semanticSearchLoading;

  // Create a map of product ratings from all reviews
  const productRatings = useMemo(() => {
    const ratingsMap = new Map<number, { total: number; count: number }>();

    allReviews.forEach((review) => {
      const current = ratingsMap.get(review.ProductID) || {
        total: 0,
        count: 0,
      };
      ratingsMap.set(review.ProductID, {
        total: current.total + review.Rating,
        count: current.count + 1,
      });
    });

    return ratingsMap;
  }, [allReviews]);

  // Get min/max prices from products
  const priceStats = useMemo(() => {
    if (products.length === 0) return { min: 0, max: 5000 };
    const prices = products.map((p) => p.ListPrice);
    return {
      min: Math.floor(Math.min(...prices)),
      max: Math.ceil(Math.max(...prices)),
    };
  }, [products]);

  // Map semantic search results to Product objects
  const semanticProducts = useMemo(() => {
    if (!semanticSearchData || !semanticSearchData.results) {
      return [];
    }

    // Convert semantic search results directly to Product objects
    // No need to fetch from products array - semantic search already has all the data
    return semanticSearchData.results.map(
      (result: any) =>
        ({
          // Use type any to handle case variations from API
          ProductID: result.ProductID || result.productID,
          Name: result.Name || result.name || "",
          ProductNumber: "",
          Color: result.Color || result.color,
          ListPrice: result.ListPrice || result.listPrice || 0,
          Description: result.Description || result.description,
          ThumbNailPhoto: result.ThumbNailPhoto || result.thumbNailPhoto,
          Size: null,
          SizeUnitMeasureCode: null,
          Weight: null,
          WeightUnitMeasureCode: null,
          ProductSubcategoryID: null,
          ProductModelID: null,
          inStock: true,
        }) as Product,
    );
  }, [semanticSearchData]);

  // Filter and sort products using semantic search ONLY
  const filteredProducts = useMemo(() => {
    // ONLY use semantic search results - no fallback to all products
    // This showcases AI-powered search capabilities
    let result: Product[] = [];

    if (
      semanticQuerySubmitted &&
      !semanticSearchError &&
      semanticProducts.length > 0
    ) {
      // Use semantic search results
      result = [...semanticProducts];
    } else if (!semanticQuerySubmitted) {
      // No search submitted yet - show nothing (user needs to search)
      result = [];
    } else {
      // Search was submitted but returned no results or had error
      result = [];
    }

    // Filter out out-of-stock items
    result = result.filter((p) => p.inStock !== false);

    // Apply category filter
    if (selectedCategory !== null) {
      const categorySubcategoryIds = subcategories
        .filter((s) => s.ProductCategoryID === selectedCategory)
        .map((s) => s.ProductSubcategoryID);
      result = result.filter(
        (p) =>
          p.ProductSubcategoryID &&
          categorySubcategoryIds.includes(p.ProductSubcategoryID),
      );
    }

    // Apply price range filter
    result = result.filter((p) => {
      const price = getSalePrice(p) || p.ListPrice;
      return price >= priceRange[0] && price <= priceRange[1];
    });

    // Semantic results are already sorted by relevance
    // But allow re-sorting by price, discount, or rating
    if (sortBy !== "relevance") {
      switch (sortBy) {
        case "price-asc":
          result.sort((a, b) => {
            const priceA = getSalePrice(a) || a.ListPrice;
            const priceB = getSalePrice(b) || b.ListPrice;
            return priceA - priceB;
          });
          break;
        case "price-desc":
          result.sort((a, b) => {
            const priceA = getSalePrice(a) || a.ListPrice;
            const priceB = getSalePrice(b) || b.ListPrice;
            return priceB - priceA;
          });
          break;
        case "discount":
          result.sort((a, b) => (b.DiscountPct || 0) - (a.DiscountPct || 0));
          break;
        case "rating":
          result.sort((a, b) => {
            const ratingDataA = productRatings.get(a.ProductID);
            const ratingDataB = productRatings.get(b.ProductID);
            const ratingA = ratingDataA
              ? ratingDataA.total / ratingDataA.count
              : 0;
            const ratingB = ratingDataB
              ? ratingDataB.total / ratingDataB.count
              : 0;
            return ratingB - ratingA;
          });
          break;
      }
    }

    return result;
  }, [
    products,
    selectedCategory,
    priceRange,
    sortBy,
    productRatings,
    subcategories,
    semanticQuerySubmitted,
    semanticProducts,
    semanticSearchError,
  ]);

  // Group products by model
  const groupedProducts = useMemo(
    () => groupProductsByModel(filteredProducts),
    [filteredProducts],
  );

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [
    initialQuery,
    selectedCategory,
    priceRange,
    sortBy,
    filteredProducts.length,
  ]);

  // Pagination calculations
  const totalPages = Math.ceil(groupedProducts.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedItems = groupedProducts.slice(startIndex, endIndex);

  // Generate page numbers to display
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 5;

    if (totalPages <= maxVisible) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    if (currentPage <= 3) {
      pages.push(1, 2, 3, 4, "...", totalPages);
    } else if (currentPage >= totalPages - 2) {
      pages.push(
        1,
        "...",
        totalPages - 3,
        totalPages - 2,
        totalPages - 1,
        totalPages,
      );
    } else {
      pages.push(
        1,
        "...",
        currentPage - 1,
        currentPage,
        currentPage + 1,
        "...",
        totalPages,
      );
    }

    return pages;
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleItemsPerPageChange = (value: string) => {
    setItemsPerPage(parseInt(value));
    setCurrentPage(1);
  };

  const handleSortChange = (value: SortOption) => {
    setSortBy(value);
    setCurrentPage(1);
  };

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [
    initialQuery,
    selectedCategory,
    priceRange,
    sortBy,
    filteredProducts.length,
  ]);

  const handleSearch = (query: string) => {
    setSearchParams({ q: query });
    setSemanticQuerySubmitted(query);
  };

  const clearFilters = () => {
    setSelectedCategory(null);
    setPriceRange([priceStats.min, priceStats.max]);
    setSortBy("rating");
  };

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: "relevance", label: t("search.sortRelevance") },
    { value: "price-asc", label: t("search.sortPriceAsc") },
    { value: "price-desc", label: t("search.sortPriceDesc") },
    { value: "discount", label: t("search.sortDiscount") },
    { value: "rating", label: t("search.sortRating") },
  ];

  return (
    <div className="min-h-screen flex flex-col" data-testid="search-page">
      <Header />
      <main className="flex-1">
        {/* Search Header - always rendered so the input is immediately available */}
        <section className="bg-doodle-text/5 border-b-2 border-dashed border-doodle-text/20 py-6">
          <div className="container mx-auto px-4">
            <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text mb-4">
              {t("search.pageTitle")}
            </h1>

            {/* Search Form with AI Suggestions */}
            <div className="space-y-3">
              <div className="flex gap-2">
                <SearchBar
                  initialQuery={initialQuery}
                  onSearch={handleSearch}
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={() => setShowFilters(!showFilters)}
                  className="doodle-button flex items-center gap-2 md:hidden"
                >
                  <SlidersHorizontal className="w-5 h-5" />
                </button>
              </div>

              {/* AI Search Info Banner */}
              <div className="bg-doodle-accent/10 border-2 border-doodle-accent/30 p-3">
                <div className="flex items-start gap-2">
                  <Sparkles className="w-5 h-5 text-doodle-accent flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-doodle text-sm text-doodle-text font-bold mb-1">
                      AI-Powered Search Features
                    </p>
                    <p className="font-doodle text-xs text-doodle-text/80">
                      <strong>Type-ahead suggestions:</strong> Start typing to
                      get AI-powered search completions.{" "}
                      <strong>Semantic search:</strong> Uses AI embeddings to
                      understand natural language queries. Try: "red bikes",
                      "waterproof gear for rainy hikes", or "lightweight
                      equipment for cyclists"
                    </p>
                    {semanticSearchData && semanticQuerySubmitted && (
                      <p className="font-doodle text-xs text-doodle-text/60 mt-1">
                        Found {semanticSearchData.descriptionMatches}{" "}
                        description matches,{" "}
                        {semanticSearchData.reviewMatches} review matches, and{" "}
                        {semanticSearchData.nameMatches ?? 0} name matches
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {semanticSearchError && (
                <div className="bg-red-50 border-2 border-red-200 p-3">
                  <p className="font-doodle text-xs text-red-600">
                    ⚠️ Semantic search service unavailable. Please check that
                    the AI service is running and embeddings are indexed.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Main Content */}
        <section className="container mx-auto px-4 py-8">
          {isLoading ? (
            <div className="flex flex-col lg:flex-row gap-8">
              {/* Filters Sidebar Skeleton */}
              <aside className="lg:w-64 flex-shrink-0">
                <div className="doodle-card p-4 space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="h-6 w-16 bg-doodle-text/10 animate-pulse"></div>
                    <div className="h-4 w-16 bg-doodle-text/10 animate-pulse"></div>
                  </div>
                  <div className="space-y-3">
                    <div className="h-5 w-24 bg-doodle-text/10 animate-pulse"></div>
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className="h-10 w-full bg-doodle-text/10 animate-pulse"></div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <div className="h-5 w-24 bg-doodle-text/10 animate-pulse"></div>
                    <div className="h-20 w-full bg-doodle-text/10 animate-pulse"></div>
                  </div>
                </div>
              </aside>

              {/* Products Grid Skeleton */}
              <div className="flex-1">
                <div className="doodle-card p-4 mb-6">
                  <div className="flex items-center justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                      <div className="h-4 w-12 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-10 w-20 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="h-4 w-16 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-10 w-48 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                    <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mb-8">
                  {[...Array(12)].map((_, i) => (
                    <div key={i} className="doodle-card overflow-hidden">
                      <div className="aspect-square bg-doodle-text/10 animate-pulse"></div>
                      <div className="p-4 space-y-3">
                        <div className="h-4 w-3/4 bg-doodle-text/10 animate-pulse"></div>
                        <div className="h-4 w-1/2 bg-doodle-text/10 animate-pulse"></div>
                        <div className="h-6 w-24 bg-doodle-text/10 animate-pulse"></div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-center gap-2">
                  <div className="h-10 w-10 bg-doodle-text/10 animate-pulse"></div>
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="h-10 w-10 bg-doodle-text/10 animate-pulse"></div>
                  ))}
                  <div className="h-10 w-10 bg-doodle-text/10 animate-pulse"></div>
                </div>
              </div>
            </div>
          ) : (
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Filters Sidebar */}
            <aside
              className={`lg:w-64 flex-shrink-0 ${
                showFilters ? "block" : "hidden lg:block"
              }`}
            >
              <div className="doodle-card p-4 space-y-6 sticky top-24">
                <div className="flex items-center justify-between">
                  <h2 className="font-doodle text-lg font-bold text-doodle-text">
                    {t("search.filters")}
                  </h2>
                  <button
                    onClick={clearFilters}
                    className="font-doodle text-xs text-doodle-accent hover:text-doodle-text transition-colors"
                  >
                    {t("search.clearAll")}
                  </button>
                </div>

                {/* Category Filter */}
                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    {t("search.category")}
                  </h3>
                  <div className="space-y-2">
                    <button
                      onClick={() => setSelectedCategory(null)}
                      className={`w-full text-left font-doodle text-sm px-3 py-2 border-2 transition-all ${
                        selectedCategory === null
                          ? "border-doodle-accent bg-doodle-accent/10"
                          : "border-transparent hover:border-doodle-text/20"
                      }`}
                    >
                      {t("search.allCategories")}
                    </button>
                    {categories.map((cat) => (
                      <button
                        key={cat.ProductCategoryID}
                        onClick={() =>
                          setSelectedCategory(cat.ProductCategoryID)
                        }
                        className={`w-full text-left font-doodle text-sm px-3 py-2 border-2 transition-all ${
                          selectedCategory === cat.ProductCategoryID
                            ? "border-doodle-accent bg-doodle-accent/10"
                            : "border-transparent hover:border-doodle-text/20"
                        }`}
                      >
                        {cat.Name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Price Range Filter */}
                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    {t("search.priceRange")}
                  </h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <label className="font-doodle text-xs text-doodle-text/60">
                          {t("search.min")}
                        </label>
                        <input
                          type="number"
                          value={priceRange[0]}
                          onChange={(e) =>
                            setPriceRange([
                              Number(e.target.value),
                              priceRange[1],
                            ])
                          }
                          min={priceStats.min}
                          max={priceRange[1]}
                          className="w-full px-2 py-1 font-doodle text-sm border-2 border-doodle-text/30 focus:border-doodle-accent focus:outline-none"
                        />
                      </div>
                      <span className="font-doodle text-doodle-text/50 mt-4">
                        -
                      </span>
                      <div className="flex-1">
                        <label className="font-doodle text-xs text-doodle-text/60">
                          {t("search.max")}
                        </label>
                        <input
                          type="number"
                          value={priceRange[1]}
                          onChange={(e) =>
                            setPriceRange([
                              priceRange[0],
                              Number(e.target.value),
                            ])
                          }
                          min={priceRange[0]}
                          max={priceStats.max}
                          className="w-full px-2 py-1 font-doodle text-sm border-2 border-doodle-text/30 focus:border-doodle-accent focus:outline-none"
                        />
                      </div>
                    </div>
                    <input
                      type="range"
                      min={priceStats.min}
                      max={priceStats.max}
                      value={priceRange[1]}
                      onChange={(e) =>
                        setPriceRange([priceRange[0], Number(e.target.value)])
                      }
                      className="w-full accent-doodle-accent"
                    />
                  </div>
                </div>

                {/* Mobile Close Button */}
                <button
                  onClick={() => setShowFilters(false)}
                  className="w-full doodle-button lg:hidden"
                >
                  {t("search.applyFilters")}
                </button>
              </div>
            </aside>

            {/* Products Grid */}
            <div className="flex-1">
              {/* Controls Bar */}
              {filteredProducts.length > 0 && (
                <div className="doodle-card p-4 mb-6">
                  <div className="flex items-center justify-between flex-wrap gap-4">
                    {/* Left side: Items per page */}
                    <div className="flex items-center gap-3">
                      <span className="font-doodle text-sm text-doodle-text">
                        {t("search.show")}
                      </span>
                      <Select
                        value={itemsPerPage.toString()}
                        onValueChange={handleItemsPerPageChange}
                      >
                        <SelectTrigger className="w-20 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-2 border-doodle-text">
                          <SelectItem value="12" className="font-doodle">
                            12
                          </SelectItem>
                          <SelectItem value="24" className="font-doodle">
                            24
                          </SelectItem>
                          <SelectItem value="48" className="font-doodle">
                            48
                          </SelectItem>
                          <SelectItem value="96" className="font-doodle">
                            96
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="font-doodle text-sm text-doodle-text">
                        {t("search.perPage")}
                      </span>
                    </div>

                    {/* Middle: Sort options */}
                    <div className="flex items-center gap-3">
                      <span className="font-doodle text-sm text-doodle-text">
                        Sort by:
                      </span>
                      <Select value={sortBy} onValueChange={handleSortChange}>
                        <SelectTrigger className="w-48 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-2 border-doodle-text">
                          <SelectItem value="relevance" className="font-doodle">
                            Relevance
                          </SelectItem>
                          <SelectItem value="price-asc" className="font-doodle">
                            Price (Low to High)
                          </SelectItem>
                          <SelectItem
                            value="price-desc"
                            className="font-doodle"
                          >
                            Price (High to Low)
                          </SelectItem>
                          <SelectItem value="discount" className="font-doodle">
                            Biggest Discount
                          </SelectItem>
                          <SelectItem value="rating" className="font-doodle">
                            Highest Rated
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Right side: Results count */}
                    <div className="font-doodle text-sm text-doodle-text">
                      Showing {startIndex + 1}-
                      {Math.min(endIndex, groupedProducts.length)} of{" "}
                      {groupedProducts.length}
                    </div>
                  </div>
                </div>
              )}

              {/* Products */}
              {filteredProducts.length > 0 ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                    {paginatedItems.map((item) =>
                      isProductModelGroup(item) ? (
                        <ProductModelCard
                          key={`model-${item.ProductModelID}`}
                          productGroup={item}
                        />
                      ) : (
                        <ProductCard
                          key={`product-${item.ProductID}`}
                          product={item}
                        />
                      ),
                    )}
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      {/* Previous Button */}
                      <button
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1}
                        className="doodle-button p-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label={t("search.previousPage")}
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>

                      {/* Page Numbers */}
                      {getPageNumbers().map((page, index) => (
                        <React.Fragment key={index}>
                          {typeof page === "number" ? (
                            <button
                              onClick={() => handlePageChange(page)}
                              className={`min-w-[40px] h-[40px] font-doodle font-bold border-2 transition-colors ${
                                currentPage === page
                                  ? "bg-doodle-accent text-white border-doodle-accent"
                                  : "bg-white text-doodle-text border-doodle-text hover:bg-doodle-accent/10 hover:border-doodle-accent"
                              }`}
                            >
                              {page}
                            </button>
                          ) : (
                            <span className="px-2 font-doodle text-doodle-text/50">
                              {page}
                            </span>
                          )}
                        </React.Fragment>
                      ))}

                      {/* Next Button */}
                      <button
                        onClick={() => handlePageChange(currentPage + 1)}
                        disabled={currentPage === totalPages}
                        className="doodle-button p-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label={t("search.nextPage")}
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="doodle-card p-12 text-center">
                  <span className="text-6xl block mb-4">🔍</span>
                  <h3 className="font-doodle text-xl font-bold text-doodle-text mb-2">
                    {semanticQuerySubmitted
                      ? "No matching products found"
                      : "Enter a search query to find products"}
                  </h3>
                  <p className="font-doodle text-doodle-text/60 mb-4">
                    {semanticQuerySubmitted ? (
                      <>
                        Our AI-powered search didn't find products matching "
                        {semanticQuerySubmitted}". Try different keywords or
                        phrases.
                      </>
                    ) : (
                      <>
                        Use the search box above to find products. Our AI
                        understands natural language like "red bikes" or
                        "waterproof gear for hiking".
                      </>
                    )}
                  </p>
                  {semanticQuerySubmitted && (
                    <button
                      onClick={() => {
                        setSearchParams({});
                        setSemanticQuerySubmitted("");
                        clearFilters();
                      }}
                      className="doodle-button doodle-button-primary"
                    >
                      Clear Search
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default SearchPage;
