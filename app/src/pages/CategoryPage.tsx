import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Filter } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ProductCard from '@/components/ProductCard';
import { 
  useCategory,
  useProductsByCategory,
  useSubcategoriesByCategory,
  useProductsBySubcategory
} from '@/hooks/useProducts';

const CategoryPage: React.FC = () => {
  const { categoryId } = useParams<{ categoryId: string }>();
  const [selectedSubcategory, setSelectedSubcategory] = React.useState<number | null>(null);
  
  const { data: category, isLoading: categoryLoading } = useCategory(categoryId ? parseInt(categoryId) : 0);
  const { data: subcategories = [] } = useSubcategoriesByCategory(categoryId ? parseInt(categoryId) : 0);
  const { data: allCategoryProducts = [] } = useProductsByCategory(categoryId ? parseInt(categoryId) : 0);
  const { data: subcategoryProducts = [] } = useProductsBySubcategory(selectedSubcategory || 0);
  
  const products = React.useMemo(() => {
    if (selectedSubcategory) {
      return subcategoryProducts;
    }
    return allCategoryProducts;
  }, [selectedSubcategory, allCategoryProducts, subcategoryProducts]);

  if (categoryLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="text-center">
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              Loading category...
            </h1>
          </div>
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
              Category Not Found
            </h1>
            <Link to="/" className="doodle-button doodle-button-primary">
              Back to Home
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link 
            to="/" 
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
        </div>

        {/* Header */}
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6 md:p-8">
            <h1 className="font-doodle text-3xl md:text-5xl font-bold text-doodle-text mb-2">
              {category.Name}
            </h1>
            <p className="font-doodle text-doodle-text/70">
              {products.length} product{products.length !== 1 ? 's' : ''} available
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
              {products.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                  {products.map((product) => (
                    <ProductCard key={product.ProductID} product={product} />
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
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default CategoryPage;
