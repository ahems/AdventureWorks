import React from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import SaleProductCard from '@/components/SaleProductCard';
import { useSaleProducts } from '@/hooks/useProducts';

const SalePage: React.FC = () => {
  const { data: saleProducts = [], isLoading } = useSaleProducts();

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Hero Section */}
        <section className="bg-doodle-accent/10 border-b-4 border-doodle-text py-8 md:py-12">
          <div className="container mx-auto px-4 text-center">
            <div className="inline-block rotate-[-2deg] mb-4">
              <span className="font-doodle text-6xl">🏷️</span>
            </div>
            <h1 className="font-doodle text-4xl md:text-5xl font-bold text-doodle-text mb-2">
              Sale Items
            </h1>
            <p className="font-doodle text-lg text-doodle-text/70 max-w-xl mx-auto">
              Don't miss out on these amazing deals! Limited time offers on top-quality gear.
            </p>
          </div>
        </section>

        {/* Products Grid */}
        <section className="container mx-auto px-4 py-8 md:py-12">
          {saleProducts.length > 0 ? (
            <>
              <p className="font-doodle text-doodle-text/60 mb-6">
                {saleProducts.length} item{saleProducts.length !== 1 ? 's' : ''} on sale
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {saleProducts.map((product) => (
                  <SaleProductCard key={product.ProductID} product={product} />
                ))}
              </div>
            </>
          ) : (
            <div className="text-center py-12">
              <span className="text-6xl mb-4 block">😢</span>
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-2">
                No Sale Items Right Now
              </h2>
              <p className="font-doodle text-doodle-text/60">
                Check back soon for amazing deals!
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
