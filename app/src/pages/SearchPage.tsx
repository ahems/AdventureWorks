import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, X, ChevronLeft, ChevronRight } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ProductCard from '@/components/ProductCard';
import { useProducts, useCategories, useSubcategories } from '@/hooks/useProducts';
import { Product, getSalePrice } from '@/types/product';
import { useAllReviews } from '@/hooks/useReviews';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type SortOption = 'relevance' | 'price-asc' | 'price-desc' | 'discount' | 'rating';

const SearchPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';
  
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 5000]);
  const [sortBy, setSortBy] = useState<SortOption>('relevance');
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(12);

  const { data: products = [], isLoading: productsLoading } = useProducts();
  const { data: categories = [], isLoading: categoriesLoading } = useCategories();
  const { data: subcategories = [] } = useSubcategories();
  const { data: allReviews = [] } = useAllReviews();

  const isLoading = productsLoading || categoriesLoading;

  // Create a map of product ratings from all reviews
  const productRatings = useMemo(() => {
    const ratingsMap = new Map<number, { total: number; count: number }>();
    
    allReviews.forEach(review => {
      const current = ratingsMap.get(review.ProductID) || { total: 0, count: 0 };
      ratingsMap.set(review.ProductID, {
        total: current.total + review.Rating,
        count: current.count + 1
      });
    });
    
    return ratingsMap;
  }, [allReviews]);

  // Get min/max prices from products
  const priceStats = useMemo(() => {
    if (products.length === 0) return { min: 0, max: 5000 };
    const prices = products.map(p => p.ListPrice);
    return {
      min: Math.floor(Math.min(...prices)),
      max: Math.ceil(Math.max(...prices))
    };
  }, [products]);

  // Filter and sort products
  const filteredProducts = useMemo(() => {
    let result = [...products];

    // Search by name
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(p => 
        p.Name.toLowerCase().includes(query)
      );
    }

    // Filter by category
    if (selectedCategory !== null) {
      const categorySubcategoryIds = subcategories
        .filter(s => s.ProductCategoryID === selectedCategory)
        .map(s => s.ProductSubcategoryID);
      result = result.filter(p => 
        p.ProductSubcategoryID && categorySubcategoryIds.includes(p.ProductSubcategoryID)
      );
    }

    // Filter by price range
    result = result.filter(p => {
      const price = getSalePrice(p) || p.ListPrice;
      return price >= priceRange[0] && price <= priceRange[1];
    });

    // Sort
    switch (sortBy) {
      case 'price-asc':
        result.sort((a, b) => {
          const priceA = getSalePrice(a) || a.ListPrice;
          const priceB = getSalePrice(b) || b.ListPrice;
          return priceA - priceB;
        });
        break;
      case 'price-desc':
        result.sort((a, b) => {
          const priceA = getSalePrice(a) || a.ListPrice;
          const priceB = getSalePrice(b) || b.ListPrice;
          return priceB - priceA;
        });
        break;
      case 'discount':
        result.sort((a, b) => (b.DiscountPct || 0) - (a.DiscountPct || 0));
        break;
      case 'rating':
        result.sort((a, b) => {
          const ratingDataA = productRatings.get(a.ProductID);
          const ratingDataB = productRatings.get(b.ProductID);
          const ratingA = ratingDataA ? ratingDataA.total / ratingDataA.count : 0;
          const ratingB = ratingDataB ? ratingDataB.total / ratingDataB.count : 0;
          return ratingB - ratingA;
        });
        break;
      default:
        // Relevance: prioritize name matches
        if (searchQuery.trim()) {
          const query = searchQuery.toLowerCase();
          result.sort((a, b) => {
            const aNameMatch = a.Name.toLowerCase().includes(query) ? 1 : 0;
            const bNameMatch = b.Name.toLowerCase().includes(query) ? 1 : 0;
            return bNameMatch - aNameMatch;
          });
        }
    }

    return result;
  }, [products, searchQuery, selectedCategory, priceRange, sortBy, productRatings, subcategories]);

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedCategory, priceRange, sortBy, filteredProducts.length]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredProducts.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedProducts = filteredProducts.slice(startIndex, endIndex);

  // Generate page numbers to display
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    
    if (currentPage <= 3) {
      pages.push(1, 2, 3, 4, '...', totalPages);
    } else if (currentPage >= totalPages - 2) {
      pages.push(1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
    }
    
    return pages;
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleItemsPerPageChange = (value: string) => {
    setItemsPerPage(parseInt(value));
    setCurrentPage(1);
  };

  const handleSortChange = (value: SortOption) => {
    setSortBy(value);
    setCurrentPage(1);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchParams(searchQuery ? { q: searchQuery } : {});
  };

  const clearFilters = () => {
    setSelectedCategory(null);
    setPriceRange([priceStats.min, priceStats.max]);
    setSortBy('relevance');
  };

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'price-asc', label: 'Price: Low to High' },
    { value: 'price-desc', label: 'Price: High to Low' },
    { value: 'discount', label: 'Biggest Discount' },
    { value: 'rating', label: 'Highest Rated' },
  ];

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">
          {/* Search Header Skeleton */}
          <section className="bg-doodle-text/5 border-b-2 border-dashed border-doodle-text/20 py-6">
            <div className="container mx-auto px-4">
              <div className="h-8 w-48 bg-doodle-text/10 animate-pulse mb-4"></div>
              <div className="flex gap-2">
                <div className="flex-1 h-12 bg-doodle-text/10 animate-pulse"></div>
                <div className="h-12 w-24 bg-doodle-text/10 animate-pulse"></div>
              </div>
            </div>
          </section>

          {/* Main Content Skeleton */}
          <section className="container mx-auto px-4 py-8">
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
                {/* Controls Bar Skeleton */}
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

                {/* Products Grid Skeleton */}
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

                {/* Pagination Skeleton */}
                <div className="flex items-center justify-center gap-2">
                  <div className="h-10 w-10 bg-doodle-text/10 animate-pulse"></div>
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="h-10 w-10 bg-doodle-text/10 animate-pulse"></div>
                  ))}
                  <div className="h-10 w-10 bg-doodle-text/10 animate-pulse"></div>
                </div>
              </div>
            </div>
          </section>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Search Header */}
        <section className="bg-doodle-text/5 border-b-2 border-dashed border-doodle-text/20 py-6">
          <div className="container mx-auto px-4">
            <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text mb-4">
              Search Products
            </h1>
            
            {/* Search Form */}
            <form onSubmit={handleSearch} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/50" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search for bikes, gear, clothing..."
                  className="w-full pl-10 pr-4 py-3 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="doodle-button doodle-button-primary px-6"
              >
                Search
              </button>
              <button
                type="button"
                onClick={() => setShowFilters(!showFilters)}
                className="doodle-button flex items-center gap-2 md:hidden"
              >
                <SlidersHorizontal className="w-5 h-5" />
              </button>
            </form>
          </div>
        </section>

        {/* Main Content */}
        <section className="container mx-auto px-4 py-8">
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Filters Sidebar */}
            <aside className={`lg:w-64 flex-shrink-0 ${showFilters ? 'block' : 'hidden lg:block'}`}>
              <div className="doodle-card p-4 space-y-6 sticky top-24">
                <div className="flex items-center justify-between">
                  <h2 className="font-doodle text-lg font-bold text-doodle-text">Filters</h2>
                  <button
                    onClick={clearFilters}
                    className="font-doodle text-xs text-doodle-accent hover:text-doodle-text transition-colors"
                  >
                    Clear all
                  </button>
                </div>

                {/* Category Filter */}
                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">Category</h3>
                  <div className="space-y-2">
                    <button
                      onClick={() => setSelectedCategory(null)}
                      className={`w-full text-left font-doodle text-sm px-3 py-2 border-2 transition-all ${
                        selectedCategory === null
                          ? 'border-doodle-accent bg-doodle-accent/10'
                          : 'border-transparent hover:border-doodle-text/20'
                      }`}
                    >
                      All Categories
                    </button>
                    {categories.map((cat) => (
                      <button
                        key={cat.ProductCategoryID}
                        onClick={() => setSelectedCategory(cat.ProductCategoryID)}
                        className={`w-full text-left font-doodle text-sm px-3 py-2 border-2 transition-all ${
                          selectedCategory === cat.ProductCategoryID
                            ? 'border-doodle-accent bg-doodle-accent/10'
                            : 'border-transparent hover:border-doodle-text/20'
                        }`}
                      >
                        {cat.Name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Price Range Filter */}
                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">Price Range</h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <label className="font-doodle text-xs text-doodle-text/60">Min</label>
                        <input
                          type="number"
                          value={priceRange[0]}
                          onChange={(e) => setPriceRange([Number(e.target.value), priceRange[1]])}
                          min={priceStats.min}
                          max={priceRange[1]}
                          className="w-full px-2 py-1 font-doodle text-sm border-2 border-doodle-text/30 focus:border-doodle-accent focus:outline-none"
                        />
                      </div>
                      <span className="font-doodle text-doodle-text/50 mt-4">-</span>
                      <div className="flex-1">
                        <label className="font-doodle text-xs text-doodle-text/60">Max</label>
                        <input
                          type="number"
                          value={priceRange[1]}
                          onChange={(e) => setPriceRange([priceRange[0], Number(e.target.value)])}
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
                      onChange={(e) => setPriceRange([priceRange[0], Number(e.target.value)])}
                      className="w-full accent-doodle-accent"
                    />
                  </div>
                </div>

                {/* Mobile Close Button */}
                <button
                  onClick={() => setShowFilters(false)}
                  className="w-full doodle-button lg:hidden"
                >
                  Apply Filters
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
                        Show:
                      </span>
                      <Select value={itemsPerPage.toString()} onValueChange={handleItemsPerPageChange}>
                        <SelectTrigger className="w-20 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-white border-2 border-doodle-text">
                          <SelectItem value="12" className="font-doodle">12</SelectItem>
                          <SelectItem value="24" className="font-doodle">24</SelectItem>
                          <SelectItem value="48" className="font-doodle">48</SelectItem>
                          <SelectItem value="96" className="font-doodle">96</SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="font-doodle text-sm text-doodle-text">
                        per page
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
                          <SelectItem value="relevance" className="font-doodle">Relevance</SelectItem>
                          <SelectItem value="price-asc" className="font-doodle">Price (Low to High)</SelectItem>
                          <SelectItem value="price-desc" className="font-doodle">Price (High to Low)</SelectItem>
                          <SelectItem value="discount" className="font-doodle">Biggest Discount</SelectItem>
                          <SelectItem value="rating" className="font-doodle">Highest Rated</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Right side: Results count */}
                    <div className="font-doodle text-sm text-doodle-text">
                      Showing {startIndex + 1}-{Math.min(endIndex, filteredProducts.length)} of {filteredProducts.length}
                    </div>
                  </div>
                </div>
              )}

              {/* Products */}
              {filteredProducts.length > 0 ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                    {paginatedProducts.map((product) => (
                      <ProductCard key={product.ProductID} product={product} />
                    ))}
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      {/* Previous Button */}
                      <button
                        onClick={() => handlePageChange(currentPage - 1)}
                        disabled={currentPage === 1}
                        className="doodle-button p-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Previous page"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>

                      {/* Page Numbers */}
                      {getPageNumbers().map((page, index) => (
                        <React.Fragment key={index}>
                          {typeof page === 'number' ? (
                            <button
                              onClick={() => handlePageChange(page)}
                              className={`min-w-[40px] h-[40px] font-doodle font-bold border-2 transition-colors ${
                                currentPage === page
                                  ? 'bg-doodle-accent text-white border-doodle-accent'
                                  : 'bg-white text-doodle-text border-doodle-text hover:bg-doodle-accent/10 hover:border-doodle-accent'
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
                        aria-label="Next page"
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
                    No products found
                  </h3>
                  <p className="font-doodle text-doodle-text/60 mb-4">
                    Try adjusting your search or filters to find what you're looking for.
                  </p>
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      clearFilters();
                    }}
                    className="doodle-button doodle-button-primary"
                  >
                    Clear Search
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default SearchPage;
