import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import ProductCard from './ProductCard';
import { useFeaturedProducts } from '@/hooks/useProducts';

const FeaturedProducts: React.FC = () => {
  const { data: featuredProducts = [], isLoading } = useFeaturedProducts();

  if (isLoading) {
    return (
      <section className="py-12 bg-doodle-text/5">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
            <div>
              <div className="h-10 w-48 bg-doodle-text/10 rounded animate-pulse mb-2"></div>
              <div className="h-4 w-64 bg-doodle-text/10 rounded animate-pulse"></div>
            </div>
            <div className="h-10 w-40 bg-doodle-text/10 rounded animate-pulse"></div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="doodle-card p-4 animate-pulse">
                <div className="aspect-square bg-doodle-text/10 rounded mb-4"></div>
                <div className="h-6 bg-doodle-text/10 rounded mb-2"></div>
                <div className="h-4 bg-doodle-text/10 rounded w-3/4 mb-4"></div>
                <div className="flex justify-between items-center">
                  <div className="h-8 w-24 bg-doodle-text/10 rounded"></div>
                  <div className="h-10 w-10 bg-doodle-text/10 rounded"></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="py-12 bg-doodle-text/5">
      <div className="container mx-auto px-4">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h2 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text">
              Featured Gear
            </h2>
            <p className="font-doodle text-doodle-text/70 mt-1">
              Top picks from our collection
            </p>
          </div>
          <Link 
            to="/category/1"
            className="doodle-button inline-flex items-center gap-2"
          >
            View All Products
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {featuredProducts.map((product) => (
            <ProductCard key={product.ProductID} product={product} variant="featured" />
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturedProducts;
