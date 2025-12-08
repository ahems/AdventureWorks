import React from 'react';
import { Link } from 'react-router-dom';
import { Clock, X } from 'lucide-react';
import { useRecentlyViewed } from '@/context/RecentlyViewedContext';
import { getSalePrice } from '@/types/product';

interface RecentlyViewedProps {
  currentProductId?: number;
}

const RecentlyViewed: React.FC<RecentlyViewedProps> = ({ currentProductId }) => {
  const { recentlyViewed, clearRecentlyViewed } = useRecentlyViewed();

  // Filter out current product if viewing a product page
  const productsToShow = currentProductId 
    ? recentlyViewed.filter(p => p.ProductID !== currentProductId)
    : recentlyViewed;

  if (productsToShow.length === 0) {
    return null;
  }

  return (
    <section className="container mx-auto px-4 py-8 md:py-12">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-doodle-accent" />
          <h2 className="font-doodle text-xl md:text-2xl font-bold text-doodle-text">
            Recently Viewed
          </h2>
        </div>
        <button
          onClick={clearRecentlyViewed}
          className="font-doodle text-xs text-doodle-text/50 hover:text-doodle-accent transition-colors flex items-center gap-1"
        >
          <X className="w-3 h-3" />
          Clear
        </button>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-thin">
        {productsToShow.map((product) => {
          const salePrice = getSalePrice(product);
          
          return (
            <Link
              key={product.ProductID}
              to={`/product/${product.ProductID}`}
              className="flex-shrink-0 w-40 md:w-48 group"
            >
              <div className="doodle-card p-3 h-full hover:border-doodle-accent transition-colors">
                {/* Image */}
                <div className="aspect-square bg-doodle-bg border-2 border-dashed border-doodle-text/30 flex items-center justify-center mb-2 group-hover:border-doodle-accent transition-colors">
                  <span className="text-3xl">🚴</span>
                </div>
                
                {/* Info */}
                <h3 className="font-doodle text-sm font-bold text-doodle-text line-clamp-2 mb-1 group-hover:text-doodle-accent transition-colors">
                  {product.Name}
                </h3>
                
                {/* Price */}
                <div className="flex items-center gap-2">
                  {salePrice ? (
                    <>
                      <span className="font-doodle text-xs text-doodle-text/50 line-through">
                        ${product.ListPrice.toFixed(2)}
                      </span>
                      <span className="font-doodle text-sm font-bold text-doodle-accent">
                        ${salePrice.toFixed(2)}
                      </span>
                    </>
                  ) : (
                    <span className="font-doodle text-sm font-bold text-doodle-green">
                      ${product.ListPrice.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
};

export default RecentlyViewed;
