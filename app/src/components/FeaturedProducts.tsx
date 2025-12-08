import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import ProductCard from './ProductCard';
import { getFeaturedProducts } from '@/data/mockData';

const FeaturedProducts: React.FC = () => {
  const featuredProducts = getFeaturedProducts();

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
