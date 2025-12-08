import React, { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ProductCard from '@/components/ProductCard';
import { products, categories, subcategories } from '@/data/mockData';
import { Product, getSalePrice } from '@/types/product';
import { useReviews } from '@/hooks/useReviews';
import { getAverageRating } from '@/data/mockReviews';

type SortOption = 'relevance' | 'price-asc' | 'price-desc' | 'discount' | 'rating';

const SearchPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';
  
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 5000]);
  const [sortBy, setSortBy] = useState<SortOption>('relevance');
  const [showFilters, setShowFilters] = useState(false);

  // Get min/max prices from products
  const priceStats = useMemo(() => {
    const prices = products.map(p => p.ListPrice);
    return {
      min: Math.floor(Math.min(...prices)),
      max: Math.ceil(Math.max(...prices))
    };
  }, []);

  // Filter and sort products
  const filteredProducts = useMemo(() => {
    let result = [...products];

    // Search by name
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(p => 
        p.Name.toLowerCase().includes(query) ||
        p.Description?.toLowerCase().includes(query)
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
        result.sort((a, b) => (b.salePercent || 0) - (a.salePercent || 0));
        break;
      case 'rating':
        result.sort((a, b) => {
          const ratingA = getAverageRating(a.ProductID);
          const ratingB = getAverageRating(b.ProductID);
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
  }, [searchQuery, selectedCategory, priceRange, sortBy]);

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
              {/* Sort & Results Count */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <p className="font-doodle text-doodle-text/70">
                  {filteredProducts.length} {filteredProducts.length === 1 ? 'product' : 'products'} found
                  {searchQuery && <span> for "<strong>{searchQuery}</strong>"</span>}
                </p>
                
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-doodle text-sm text-doodle-text/60">Sort by:</span>
                  {sortOptions.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setSortBy(option.value)}
                      className={`font-doodle text-xs px-2 py-1 border-2 transition-all ${
                        sortBy === option.value
                          ? 'border-doodle-accent bg-doodle-accent text-white'
                          : 'border-doodle-text/20 hover:border-doodle-accent hover:text-doodle-accent'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Products */}
              {filteredProducts.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredProducts.map((product) => (
                    <ProductCard key={product.ProductID} product={product} />
                  ))}
                </div>
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
