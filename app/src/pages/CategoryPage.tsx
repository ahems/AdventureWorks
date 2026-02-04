import React from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Filter, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Twemoji } from "@/components/Twemoji";
import { SEO, generateBreadcrumbStructuredData } from "@/components/SEO";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProductCard from "@/components/ProductCard";
import ProductModelCard from "@/components/ProductModelCard";
import {
  groupProductsByModel,
  isProductModelGroup,
} from "@/utils/productGrouping";
import {
  useCategory,
  useProductsByCategory,
  useSubcategoriesByCategory,
  useProductsBySubcategory,
} from "@/hooks/useProducts";
import { useAllReviews } from "@/hooks/useReviews";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CategoryPage: React.FC = () => {
  const { t } = useTranslation("common");
  const { categoryId } = useParams<{ categoryId: string }>();
  const [selectedSubcategory, setSelectedSubcategory] = React.useState<
    number | null
  >(null);
  const [currentPage, setCurrentPage] = React.useState(1);
  const [itemsPerPage, setItemsPerPage] = React.useState(6);
  const [sortBy, setSortBy] = React.useState("name-asc");

  const { data: category, isLoading: categoryLoading } = useCategory(
    categoryId ? parseInt(categoryId) : 0,
  );
  const { data: subcategories = [] } = useSubcategoriesByCategory(
    categoryId ? parseInt(categoryId) : 0,
  );
  const { data: allCategoryProducts = [], isLoading: categoryProductsLoading } =
    useProductsByCategory(categoryId ? parseInt(categoryId) : 0);
  const {
    data: subcategoryProducts = [],
    isLoading: subcategoryProductsLoading,
  } = useProductsBySubcategory(selectedSubcategory || 0);
  const { data: allReviews = [] } = useAllReviews();

  const isLoadingProducts = selectedSubcategory
    ? subcategoryProductsLoading
    : categoryProductsLoading;

  // Create a map of product ratings from all reviews
  const productRatings = React.useMemo(() => {
    const ratingsMap = new Map<number, { total: number; count: number }>();

    allReviews.forEach((review) => {
      const existing = ratingsMap.get(review.ProductID);
      if (existing) {
        existing.total += review.Rating;
        existing.count += 1;
      } else {
        ratingsMap.set(review.ProductID, {
          total: review.Rating,
          count: 1,
        });
      }
    });

    return ratingsMap;
  }, [allReviews]);

  const products = React.useMemo(() => {
    const productList = selectedSubcategory
      ? subcategoryProducts
      : allCategoryProducts;

    // Apply sorting
    const sorted = [...productList].sort((a, b) => {
      switch (sortBy) {
        case "price-asc":
          return a.ListPrice - b.ListPrice;
        case "price-desc":
          return b.ListPrice - a.ListPrice;
        case "name-asc":
          return a.Name.localeCompare(b.Name);
        case "name-desc":
          return b.Name.localeCompare(a.Name);
        case "newest":
          return (
            new Date(b.SellStartDate || 0).getTime() -
            new Date(a.SellStartDate || 0).getTime()
          );
        case "rating":
          const ratingDataA = productRatings.get(a.ProductID);
          const ratingDataB = productRatings.get(b.ProductID);
          const ratingA = ratingDataA
            ? ratingDataA.total / ratingDataA.count
            : 0;
          const ratingB = ratingDataB
            ? ratingDataB.total / ratingDataB.count
            : 0;
          return ratingB - ratingA;
        default:
          return 0;
      }
    });

    return sorted;
  }, [
    selectedSubcategory,
    allCategoryProducts,
    subcategoryProducts,
    sortBy,
    productRatings,
  ]);

  // Group products by model for display
  const groupedProducts = React.useMemo(() => {
    return groupProductsByModel(products);
  }, [products]);

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [selectedSubcategory, groupedProducts.length, sortBy]);

  // Pagination calculations (use groupedProducts for pagination)
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

  const handleSortChange = (value: string) => {
    setSortBy(value);
    setCurrentPage(1);
  };

  // Generate breadcrumb structured data - must be before early returns
  const breadcrumbData = React.useMemo(() => {
    if (!category) return null;

    return generateBreadcrumbStructuredData([
      { name: t("navigation.home"), url: window.location.origin },
      { name: category.Name, url: window.location.href },
    ]);
  }, [category, t]);

  // Generate category description for SEO
  const categoryDescription = category
    ? `Shop ${category.Name.toLowerCase()} at Adventure Works. Browse our collection of ${
        groupedProducts.length
      } premium products including ${subcategories
        .slice(0, 3)
        .map((s) => s.Name)
        .join(", ")} and more.`
    : "";

  if (categoryLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">
          {/* Breadcrumb Skeleton */}
          <div className="container mx-auto px-4 py-4">
            <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
          </div>

          {/* Header Skeleton */}
          <section className="container mx-auto px-4 pb-8">
            <div className="doodle-card p-6 md:p-8 space-y-3">
              <div className="h-10 w-48 bg-doodle-text/10 animate-pulse"></div>
              <div className="h-4 w-32 bg-doodle-text/10 animate-pulse"></div>
            </div>
          </section>

          {/* Filters & Products Skeleton */}
          <section className="container mx-auto px-4 pb-12">
            <div className="flex flex-col lg:flex-row gap-6">
              {/* Sidebar Filters Skeleton */}
              <aside className="lg:w-64 flex-shrink-0">
                <div className="doodle-card p-4 space-y-4">
                  <div className="h-6 w-32 bg-doodle-text/10 animate-pulse"></div>
                  {[...Array(5)].map((_, i) => (
                    <div
                      key={i}
                      className="h-10 w-full bg-doodle-text/10 animate-pulse"
                    ></div>
                  ))}
                </div>
              </aside>

              {/* Main Content Skeleton */}
              <div className="flex-1 space-y-6">
                {/* Controls Bar Skeleton */}
                <div className="doodle-card p-4">
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
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[...Array(9)].map((_, i) => (
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
                    <div
                      key={i}
                      className="h-10 w-10 bg-doodle-text/10 animate-pulse"
                    ></div>
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

  if (!category) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="text-center">
            <span className="text-6xl mb-4 block">🤷</span>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              {t("category.notFound")}
            </h1>
            <Link to="/" className="doodle-button doodle-button-primary">
              {t("category.backToHome")}
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <SEO
        title={`${category.Name} | Adventure Works`}
        description={categoryDescription}
        type="website"
        structuredData={breadcrumbData}
      />
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("category.backToHome")}
          </Link>
        </div>

        {/* Header */}
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6 md:p-8">
            <h1 className="font-doodle text-3xl md:text-5xl font-bold text-doodle-text mb-2">
              {category.Name}
            </h1>
            <p className="font-doodle text-doodle-text/70">
              {t("category.productsAvailable", {
                count: groupedProducts.length,
              })}
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
                    {t("category.subcategories")}
                  </h2>
                </div>

                <div className="space-y-2">
                  <button
                    onClick={() => setSelectedSubcategory(null)}
                    className={`w-full text-left font-doodle py-2 px-3 transition-colors ${
                      selectedSubcategory === null
                        ? "bg-doodle-accent text-white"
                        : "hover:bg-doodle-text/10 text-doodle-text"
                    }`}
                  >
                    * {t("category.allProducts", { name: category.Name })}
                  </button>

                  {subcategories.map((sub) => (
                    <button
                      key={sub.ProductSubcategoryID}
                      onClick={() =>
                        setSelectedSubcategory(sub.ProductSubcategoryID)
                      }
                      className={`w-full text-left font-doodle py-2 px-3 transition-colors ${
                        selectedSubcategory === sub.ProductSubcategoryID
                          ? "bg-doodle-accent text-white"
                          : "hover:bg-doodle-text/10 text-doodle-text"
                      }`}
                      data-testid={`subcategory-filter-${sub.ProductSubcategoryID}`}
                    >
                      * {sub.Name}
                    </button>
                  ))}
                </div>
              </div>
            </aside>

            {/* Product Grid */}
            <div className="flex-1">
              {isLoadingProducts ? (
                <>
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                    {[...Array(6)].map((_, i) => (
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
                </>
              ) : groupedProducts.length > 0 ? (
                <>
                  {/* Controls Bar */}
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
                            <SelectItem value="6" className="font-doodle">
                              6
                            </SelectItem>
                            <SelectItem value="12" className="font-doodle">
                              12
                            </SelectItem>
                            <SelectItem value="24" className="font-doodle">
                              24
                            </SelectItem>
                            <SelectItem value="48" className="font-doodle">
                              48
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
                          {t("search.sortBy")}
                        </span>
                        <Select value={sortBy} onValueChange={handleSortChange}>
                          <SelectTrigger className="w-48 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-white border-2 border-doodle-text">
                            <SelectItem
                              value="name-asc"
                              className="font-doodle"
                            >
                              {t("category.sortNameAsc")}
                            </SelectItem>
                            <SelectItem
                              value="name-desc"
                              className="font-doodle"
                            >
                              {t("category.sortNameDesc")}
                            </SelectItem>
                            <SelectItem
                              value="price-asc"
                              className="font-doodle"
                            >
                              {t("search.sortPriceAsc")}
                            </SelectItem>
                            <SelectItem
                              value="price-desc"
                              className="font-doodle"
                            >
                              {t("search.sortPriceDesc")}
                            </SelectItem>
                            <SelectItem value="newest" className="font-doodle">
                              {t("category.sortNewest")}
                            </SelectItem>
                            <SelectItem value="rating" className="font-doodle">
                              {t("category.sortRating")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Right side: Results count */}
                      <div className="font-doodle text-sm text-doodle-text">
                        {t("search.showingResults", {
                          start: startIndex + 1,
                          end: Math.min(endIndex, groupedProducts.length),
                          total: groupedProducts.length,
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Products */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6 mb-8">
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
                  <div className="mb-4 inline-block">
                    <Twemoji emoji="📦" size="4rem" />
                  </div>
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-2">
                    {t("category.noProductsFound")}
                  </h2>
                  <p className="font-doodle text-doodle-text/70">
                    {t("category.tryDifferentSubcategory")}
                  </p>
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
