import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Package, ChevronRight } from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import CreateProductDialog from "@/components/CreateProductDialog";
import GenerateProductsWizardDialog from "@/components/GenerateProductsWizardDialog";
import { useAuth } from "@/context/AuthContext";
import {
  useAdminCategories,
  useAdminAllSubcategories,
  useAdminProductCountsBySubcategory,
} from "@/hooks/useAdminProducts";

const CategoryCardSkeleton: React.FC = () => (
  <div className="doodle-card p-5 animate-pulse">
    <div className="h-6 bg-doodle-text/10 rounded-md w-3/4 mb-3" />
    <div className="h-4 bg-doodle-text/10 rounded-md w-1/2 mb-2" />
    <div className="h-4 bg-doodle-text/10 rounded-md w-1/3" />
  </div>
);

const ProductsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const { data: categories = [], isLoading: categoriesLoading } =
    useAdminCategories();
  const { data: allSubcategories = [], isLoading: subcategoriesLoading } =
    useAdminAllSubcategories();

  const allSubcategoryIds = useMemo(
    () => allSubcategories.map((s) => s.ProductSubcategoryID),
    [allSubcategories],
  );

  const { data: productCounts = new Map() } =
    useAdminProductCountsBySubcategory(allSubcategoryIds);

  const categoriesWithStats = useMemo(() => {
    return categories.map((cat) => {
      const subs = allSubcategories.filter(
        (s) => s.ProductCategoryID === cat.ProductCategoryID,
      );
      const totalProducts = subs.reduce(
        (sum, s) => sum + (productCounts.get(s.ProductSubcategoryID) ?? 0),
        0,
      );
      return { ...cat, subcategoryCount: subs.length, totalProducts };
    });
  }, [categories, allSubcategories, productCounts]);

  const isLoading = categoriesLoading || subcategoriesLoading;

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-doodle-bg flex flex-col">
        <AdminHeader />
        <main className="flex-1 flex items-center justify-center">
          <p className="font-doodle text-doodle-text/60">
            Please log in to view products.
          </p>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-doodle-bg flex flex-col">
      <AdminHeader />

      <main className="flex-1 container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-2">
              <Package className="w-7 h-7" />
              Products
            </h1>
            <p className="font-doodle text-doodle-text/60 mt-1">
              Browse by category or create a new product
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <GenerateProductsWizardDialog />
            <CreateProductDialog subcategories={allSubcategories} />
          </div>
        </div>

        {/* Category Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <CategoryCardSkeleton key={i} />
            ))}
          </div>
        ) : categoriesWithStats.length === 0 ? (
          <div className="text-center py-16">
            <Package className="w-12 h-12 text-doodle-text/30 mx-auto mb-3" />
            <p className="font-doodle text-doodle-text/60 text-lg">
              No categories found.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {categoriesWithStats.map((cat) => (
              <Link
                key={cat.ProductCategoryID}
                to={`/category/${cat.ProductCategoryID}`}
                className="doodle-card p-5 hover:shadow-lg transition-shadow group flex flex-col gap-3"
                data-testid={`category-card-${cat.ProductCategoryID}`}
              >
                <div className="flex items-start justify-between">
                  <h2 className="font-doodle text-lg font-bold text-doodle-text group-hover:text-doodle-accent transition-colors leading-tight">
                    {cat.Name}
                  </h2>
                  <ChevronRight className="w-5 h-5 text-doodle-text/40 group-hover:text-doodle-accent flex-shrink-0 mt-0.5 transition-colors" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="font-doodle text-sm text-doodle-text/70">
                    {cat.subcategoryCount} subcategor
                    {cat.subcategoryCount === 1 ? "y" : "ies"}
                  </span>
                  <span className="font-doodle text-sm text-doodle-text/70">
                    {cat.totalProducts} product
                    {cat.totalProducts !== 1 ? "s" : ""}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
};

export default ProductsPage;
