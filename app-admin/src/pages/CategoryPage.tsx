import React, { useState, useEffect } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Filter, ChevronLeft, ChevronRight, ArrowUpDown, Edit } from 'lucide-react';
import AdminHeader from '@/components/AdminHeader';
import Footer from '@/components/Footer';
import AdminProductCard from '@/components/AdminProductCard';
import AdminProductCardSkeleton from '@/components/AdminProductCardSkeleton';
import { useAuth } from '@/context/AuthContext';
import { getProductAverageRating } from '@/hooks/useReviews';
import { 
  getCategoryById, 
  getProductsByCategory, 
  getSubcategoriesByCategory,
  getProductsBySubcategory 
} from '@/data/mockData';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Product } from '@/types/product';

const ITEMS_PER_PAGE_OPTIONS = [6, 12, 24, 48];

type SortOption = 'name-asc' | 'name-desc' | 'price-asc' | 'price-desc' | 'rating' | 'sku';

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'name-asc', label: 'Name A-Z' },
  { value: 'name-desc', label: 'Name Z-A' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'rating', label: 'Highest Rated' },
  { value: 'sku', label: 'SKU' },
];

const CategoryPage: React.FC = () => {
  const { categoryId } = useParams<{ categoryId: string }>();
  const { isAuthenticated } = useAuth();
  const [selectedSubcategory, setSelectedSubcategory] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(12);
  const [sortBy, setSortBy] = useState<SortOption>('name-asc');
  const [isLoading, setIsLoading] = useState(true);

  // Redirect if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Simulate loading state
  useEffect(() => {
    setIsLoading(true);
    const timer = setTimeout(() => setIsLoading(false), 400);
    return () => clearTimeout(timer);
  }, [categoryId, selectedSubcategory, sortBy]);
  
  const category = categoryId ? getCategoryById(parseInt(categoryId)) : undefined;
  const subcategories = categoryId ? getSubcategoriesByCategory(parseInt(categoryId)) : [];
  
  const baseProducts = React.useMemo(() => {
    if (selectedSubcategory) {
      return getProductsBySubcategory(selectedSubcategory);
    }
    return categoryId ? getProductsByCategory(parseInt(categoryId)) : [];
  }, [categoryId, selectedSubcategory]);

  // Sort products
  const allProducts = React.useMemo(() => {
    const sorted = [...baseProducts];
    
    const getEffectivePrice = (p: Product) => 
      p.salePercent ? p.ListPrice * (1 - p.salePercent / 100) : p.ListPrice;

    switch (sortBy) {
      case 'name-asc':
        return sorted.sort((a, b) => a.Name.localeCompare(b.Name));
      case 'name-desc':
        return sorted.sort((a, b) => b.Name.localeCompare(a.Name));
      case 'price-asc':
        return sorted.sort((a, b) => getEffectivePrice(a) - getEffectivePrice(b));
      case 'price-desc':
        return sorted.sort((a, b) => getEffectivePrice(b) - getEffectivePrice(a));
      case 'rating':
        return sorted.sort((a, b) => 
          getProductAverageRating(b.ProductID) - getProductAverageRating(a.ProductID)
        );
      case 'sku':
        return sorted.sort((a, b) => a.ProductNumber.localeCompare(b.ProductNumber));
      default:
        return sorted;
    }
  }, [baseProducts, sortBy]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedSubcategory, itemsPerPage, sortBy]);

  const totalPages = Math.ceil(allProducts.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedProducts = allProducts.slice(startIndex, endIndex);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisiblePages = 5;
    
    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  if (!category) {
    return (
      <div className="min-h-screen flex flex-col">
        <AdminHeader />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="text-center">
            <span className="text-6xl mb-4 block">🤷</span>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              Category Not Found
            </h1>
            <Link to="/" className="doodle-button doodle-button-primary">
              Back to Dashboard
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        {/* Header */}
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6 md:p-8">
            <div className="flex items-center gap-3 mb-2">
              <Edit className="w-6 h-6 text-doodle-accent" />
              <span className="font-doodle text-sm text-doodle-accent uppercase tracking-wide">Product Management</span>
            </div>
            <h1 className="font-doodle text-3xl md:text-5xl font-bold text-doodle-text mb-2">
              {category.Name}
            </h1>
            <p className="font-doodle text-doodle-text/70">
              {allProducts.length} product{allProducts.length !== 1 ? 's' : ''} • Click any product to edit
            </p>
          </div>
        </section>

        {/* Filters & Products */}
        <section className="container mx-auto px-4 pb-12">
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Sidebar Filters */}
            <aside className="lg:w-64 flex-shrink-0">
              <div className="doodle-card p-4 sticky top-24">
                <div className="flex items-center gap-2 mb-4">
                  <Filter className="w-5 h-5 text-doodle-text" />
                  <h2 className="font-doodle text-lg font-bold text-doodle-text">
                    Subcategories
                  </h2>
                </div>
                
                <div className="space-y-2">
                  <button
                    onClick={() => setSelectedSubcategory(null)}
                    className={`w-full text-left font-doodle py-2 px-3 transition-colors ${
                      selectedSubcategory === null
                        ? 'bg-doodle-accent text-white'
                        : 'hover:bg-doodle-text/10 text-doodle-text'
                    }`}
                  >
                    * All {category.Name}
                  </button>
                  
                  {subcategories.map((sub) => (
                    <button
                      key={sub.ProductSubcategoryID}
                      onClick={() => setSelectedSubcategory(sub.ProductSubcategoryID)}
                      className={`w-full text-left font-doodle py-2 px-3 transition-colors ${
                        selectedSubcategory === sub.ProductSubcategoryID
                          ? 'bg-doodle-accent text-white'
                          : 'hover:bg-doodle-text/10 text-doodle-text'
                      }`}
                    >
                      * {sub.Name}
                    </button>
                  ))}
                </div>
              </div>
            </aside>

            {/* Product Grid */}
            <div className="flex-1">
              {/* Controls - Top */}
              {allProducts.length > 0 && (
                <div className="doodle-card p-4 mb-6 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="font-doodle text-doodle-text/70 text-sm">Show:</span>
                      <Select
                        value={itemsPerPage.toString()}
                        onValueChange={(value) => setItemsPerPage(parseInt(value))}
                      >
                        <SelectTrigger className="w-20 font-doodle">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ITEMS_PER_PAGE_OPTIONS.map((option) => (
                            <SelectItem key={option} value={option.toString()} className="font-doodle">
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <ArrowUpDown className="w-4 h-4 text-doodle-text/70" />
                      <Select
                        value={sortBy}
                        onValueChange={(value) => setSortBy(value as SortOption)}
                      >
                        <SelectTrigger className="w-44 font-doodle">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SORT_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value} className="font-doodle">
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  
                  <span className="font-doodle text-doodle-text/70 text-sm">
                    Showing {startIndex + 1}-{Math.min(endIndex, allProducts.length)} of {allProducts.length}
                  </span>
                </div>
              )}

              {isLoading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                  {Array.from({ length: itemsPerPage }).map((_, i) => (
                    <AdminProductCardSkeleton key={i} />
                  ))}
                </div>
              ) : paginatedProducts.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                  {paginatedProducts.map((product) => (
                    <AdminProductCard key={product.ProductID} product={product} />
                  ))}
                </div>
              ) : (
                <div className="doodle-card p-12 text-center">
                  <span className="text-6xl mb-4 block">📦</span>
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-2">
                    No products found
                  </h2>
                  <p className="font-doodle text-doodle-text/70">
                    Try selecting a different subcategory
                  </p>
                </div>
              )}

              {/* Pagination Controls - Bottom */}
              {totalPages > 1 && (
                <div className="doodle-card p-4 mt-6 flex items-center justify-center gap-2">
                  <button
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                    className="p-2 font-doodle disabled:opacity-40 disabled:cursor-not-allowed hover:bg-doodle-text/10 transition-colors"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  
                  {getPageNumbers().map((page, index) => (
                    page === '...' ? (
                      <span key={`ellipsis-${index}`} className="px-2 font-doodle text-doodle-text/50">
                        ...
                      </span>
                    ) : (
                      <button
                        key={page}
                        onClick={() => handlePageChange(page as number)}
                        className={`min-w-[40px] h-10 font-doodle transition-colors ${
                          currentPage === page
                            ? 'bg-doodle-accent text-white'
                            : 'hover:bg-doodle-text/10 text-doodle-text'
                        }`}
                      >
                        {page}
                      </button>
                    )
                  ))}
                  
                  <button
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage === totalPages}
                    className="p-2 font-doodle disabled:opacity-40 disabled:cursor-not-allowed hover:bg-doodle-text/10 transition-colors"
                    aria-label="Next page"
                  >
                    <ChevronRight className="w-5 h-5" />
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

export default CategoryPage;