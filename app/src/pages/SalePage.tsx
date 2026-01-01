import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Twemoji } from "@/components/Twemoji";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import SaleProductCard from "@/components/SaleProductCard";
import { useSaleProducts } from "@/hooks/useProducts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SalePage: React.FC = () => {
  const { t } = useTranslation("common");
  const { data: allSaleProducts = [], isLoading } = useSaleProducts();
  const [currentPage, setCurrentPage] = React.useState(1);
  const [itemsPerPage, setItemsPerPage] = React.useState(12);
  const [sortBy, setSortBy] = React.useState("discount-desc");

  // Apply sorting
  const saleProducts = React.useMemo(() => {
    const sorted = [...allSaleProducts].sort((a, b) => {
      switch (sortBy) {
        case "discount-desc":
          return (b.DiscountPct || 0) - (a.DiscountPct || 0);
        case "discount-asc":
          return (a.DiscountPct || 0) - (b.DiscountPct || 0);
        case "price-asc":
          const priceA = a.ListPrice * (1 - (a.DiscountPct || 0));
          const priceB = b.ListPrice * (1 - (b.DiscountPct || 0));
          return priceA - priceB;
        case "price-desc":
          const priceA2 = a.ListPrice * (1 - (a.DiscountPct || 0));
          const priceB2 = b.ListPrice * (1 - (b.DiscountPct || 0));
          return priceB2 - priceA2;
        case "name-asc":
          return a.Name.localeCompare(b.Name);
        case "name-desc":
          return b.Name.localeCompare(a.Name);
        default:
          return 0;
      }
    });
    return sorted;
  }, [allSaleProducts, sortBy]);

  // Reset to page 1 when filters change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [sortBy, saleProducts.length]);

  // Pagination calculations
  const totalPages = Math.ceil(saleProducts.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedProducts = saleProducts.slice(startIndex, endIndex);

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
        totalPages
      );
    } else {
      pages.push(
        1,
        "...",
        currentPage - 1,
        currentPage,
        currentPage + 1,
        "...",
        totalPages
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

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1">
          {/* Hero Section Skeleton */}
          <section className="bg-doodle-accent/10 border-b-4 border-doodle-text py-8 md:py-12">
            <div className="container mx-auto px-4 text-center space-y-4">
              <div className="h-16 w-16 bg-doodle-text/10 animate-pulse mx-auto rounded-full"></div>
              <div className="h-12 w-48 bg-doodle-text/10 animate-pulse mx-auto"></div>
              <div className="h-4 w-96 max-w-full bg-doodle-text/10 animate-pulse mx-auto"></div>
            </div>
          </section>

          {/* Products Grid Skeleton */}
          <section className="container mx-auto px-4 py-8 md:py-12">
            {/* Controls Bar Skeleton */}
            <div className="doodle-card p-4 mb-6">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-3">
                  <div className="h-4 w-12 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-10 w-20 bg-doodle-text/10 animate-pulse"></div>
                  <div className="h-4 w-16 bg-doodle-text/10 animate-pulse"></div>
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
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-16 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-4 w-12 bg-doodle-text/10 animate-pulse"></div>
                    </div>
                    <div className="h-4 w-3/4 bg-doodle-text/10 animate-pulse"></div>
                    <div className="flex items-center gap-2">
                      <div className="h-6 w-20 bg-doodle-text/10 animate-pulse"></div>
                      <div className="h-6 w-16 bg-doodle-text/10 animate-pulse"></div>
                    </div>
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
        {/* Hero Section */}
        <section className="bg-doodle-accent/10 border-b-4 border-doodle-text py-8 md:py-12">
          <div className="container mx-auto px-4 text-center">
            <div className="inline-block rotate-[-2deg] mb-4">
              <Twemoji emoji="🏷️" size="6rem" className="font-doodle" />
            </div>
            <h1 className="font-doodle text-4xl md:text-5xl font-bold text-doodle-text mb-2">
              {t("sale.title")}
            </h1>
            <p className="font-doodle text-lg text-doodle-text/70 max-w-xl mx-auto">
              {t("sale.subtitle")}
            </p>
          </div>
        </section>

        {/* Products Grid */}
        <section className="container mx-auto px-4 py-8 md:py-12">
          {saleProducts.length > 0 ? (
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
                      {t("search.sortBy")}
                    </span>
                    <Select value={sortBy} onValueChange={handleSortChange}>
                      <SelectTrigger className="w-48 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-white border-2 border-doodle-text">
                        <SelectItem
                          value="discount-desc"
                          className="font-doodle"
                        >
                          {t("sale.sortDiscountDesc")}
                        </SelectItem>
                        <SelectItem
                          value="discount-asc"
                          className="font-doodle"
                        >
                          {t("sale.sortDiscountAsc")}
                        </SelectItem>
                        <SelectItem value="price-asc" className="font-doodle">
                          {t("search.sortPriceAsc")}
                        </SelectItem>
                        <SelectItem value="price-desc" className="font-doodle">
                          {t("search.sortPriceDesc")}
                        </SelectItem>
                        <SelectItem value="name-asc" className="font-doodle">
                          {t("category.sortNameAsc")}
                        </SelectItem>
                        <SelectItem value="name-desc" className="font-doodle">
                          {t("category.sortNameDesc")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Right side: Results count */}
                  <div className="font-doodle text-sm text-doodle-text">
                    {t("search.showingResults", {
                      start: startIndex + 1,
                      end: Math.min(endIndex, saleProducts.length),
                      total: saleProducts.length,
                    })}
                  </div>
                </div>
              </div>

              {/* Products Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mb-8">
                {paginatedProducts.map((product) => (
                  <SaleProductCard key={product.ProductID} product={product} />
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
            <div className="text-center py-12">
              <span className="text-6xl mb-4 block">😢</span>
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-2">
                {t("sale.noSaleItems")}
              </h2>
              <p className="font-doodle text-doodle-text/60">
                {t("sale.checkBackSoon")}
              </p>
            </div>
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default SalePage;
