import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, X, Star, ShoppingCart, Scale, Plus } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useCompare } from '@/context/CompareContext';
import { useCart } from '@/context/CartContext';
import { useReviews } from '@/hooks/useReviews';
import { getSalePrice } from '@/types/product';

const CompareProductReview: React.FC<{ productId: number }> = ({ productId }) => {
  const { averageRating, reviewCount } = useReviews(productId);
  
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-0.5">
        {[...Array(5)].map((_, i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${
              i < Math.round(averageRating)
                ? 'text-doodle-accent fill-current'
                : 'text-doodle-text/20'
            }`}
          />
        ))}
      </div>
      <span className="font-doodle text-sm text-doodle-text/70">
        {averageRating.toFixed(1)} ({reviewCount} reviews)
      </span>
    </div>
  );
};

const ComparePage: React.FC = () => {
  const { items, removeFromCompare, clearCompare } = useCompare();
  const { addToCart } = useCart();

  const specs = [
    { key: 'Price', getValue: (p: typeof items[0]) => {
      const salePrice = getSalePrice(p);
      if (salePrice) {
        return (
          <div className="flex flex-col items-center">
            <span className="font-doodle text-sm text-doodle-text/50 line-through">
              ${p.ListPrice.toFixed(2)}
            </span>
            <span className="font-doodle text-xl font-bold text-doodle-accent">
              ${salePrice.toFixed(2)}
            </span>
            <span className="font-doodle text-xs text-doodle-green font-bold">
              Save {p.salePercent}%
            </span>
          </div>
        );
      }
      return (
        <span className="font-doodle text-xl font-bold text-doodle-green">
          ${p.ListPrice.toFixed(2)}
        </span>
      );
    }},
    { key: 'Color', getValue: (p: typeof items[0]) => p.Color || '—' },
    { key: 'Size', getValue: (p: typeof items[0]) => p.Size || '—' },
    { key: 'Weight', getValue: (p: typeof items[0]) => p.Weight ? `${p.Weight} lbs` : '—' },
    { key: 'Product Number', getValue: (p: typeof items[0]) => p.ProductNumber },
    { key: 'Available Sizes', getValue: (p: typeof items[0]) => 
      p.availableSizes?.join(', ') || '—' 
    },
    { key: 'Available Colors', getValue: (p: typeof items[0]) => 
      p.availableColors?.join(', ') || '—' 
    },
  ];

  if (items.length === 0) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <div className="doodle-card p-12">
              <Scale className="w-20 h-20 mx-auto mb-6 text-doodle-text/40" />
              <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
                No Products to Compare
              </h1>
              <p className="font-doodle text-doodle-text/70 mb-8">
                Add products to compare their specs, pricing, and reviews side by side.
              </p>
              <Link to="/" className="doodle-button doodle-button-primary inline-flex items-center gap-2">
                <ArrowLeft className="w-4 h-4" />
                Browse Products
              </Link>
            </div>
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
            Back to Shop
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <Scale className="w-8 h-8 text-doodle-accent" />
              <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text">
                Compare Products
              </h1>
            </div>
            <button
              onClick={clearCompare}
              className="doodle-button text-sm"
            >
              Clear All
            </button>
          </div>

          <div className="doodle-card overflow-x-auto">
            <table className="w-full min-w-[600px]">
              {/* Product Headers */}
              <thead>
                <tr>
                  <th className="p-4 text-left font-doodle font-bold text-doodle-text border-b-2 border-dashed border-doodle-text/20 w-40">
                    Product
                  </th>
                  {items.map((product) => (
                    <th key={product.ProductID} className="p-4 border-b-2 border-dashed border-doodle-text/20 relative">
                      <button
                        onClick={() => removeFromCompare(product.ProductID)}
                        className="absolute top-2 right-2 p-1 hover:bg-doodle-accent/10 rounded transition-colors"
                        aria-label={`Remove ${product.Name}`}
                      >
                        <X className="w-4 h-4 text-doodle-accent" />
                      </button>
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-24 h-24 bg-doodle-bg border-2 border-doodle-text border-dashed flex items-center justify-center">
                          <span className="font-doodle text-3xl">🚴</span>
                        </div>
                        <Link 
                          to={`/product/${product.ProductID}`}
                          className="font-doodle font-bold text-doodle-text hover:text-doodle-accent transition-colors text-center line-clamp-2"
                        >
                          {product.Name}
                        </Link>
                      </div>
                    </th>
                  ))}
                  {/* Empty columns for remaining slots */}
                  {Array.from({ length: 3 - items.length }).map((_, i) => (
                    <th key={`empty-${i}`} className="p-4 border-b-2 border-dashed border-doodle-text/20">
                      <Link
                        to="/"
                        className="flex flex-col items-center justify-center gap-3 py-8 border-2 border-dashed border-doodle-text/10 hover:border-doodle-accent/30 transition-colors"
                      >
                        <Plus className="w-8 h-8 text-doodle-text/30" />
                        <span className="font-doodle text-sm text-doodle-text/50">
                          Add product
                        </span>
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {/* Reviews Row */}
                <tr>
                  <td className="p-4 font-doodle font-bold text-doodle-text border-b border-dashed border-doodle-text/10">
                    Reviews
                  </td>
                  {items.map((product) => (
                    <td key={product.ProductID} className="p-4 text-center border-b border-dashed border-doodle-text/10">
                      <CompareProductReview productId={product.ProductID} />
                    </td>
                  ))}
                  {Array.from({ length: 3 - items.length }).map((_, i) => (
                    <td key={`empty-${i}`} className="p-4 border-b border-dashed border-doodle-text/10" />
                  ))}
                </tr>

                {/* Spec Rows */}
                {specs.map((spec) => (
                  <tr key={spec.key}>
                    <td className="p-4 font-doodle font-bold text-doodle-text border-b border-dashed border-doodle-text/10">
                      {spec.key}
                    </td>
                    {items.map((product) => (
                      <td key={product.ProductID} className="p-4 text-center border-b border-dashed border-doodle-text/10">
                        <span className="font-doodle text-doodle-text">
                          {spec.getValue(product)}
                        </span>
                      </td>
                    ))}
                    {Array.from({ length: 3 - items.length }).map((_, i) => (
                      <td key={`empty-${i}`} className="p-4 border-b border-dashed border-doodle-text/10" />
                    ))}
                  </tr>
                ))}

                {/* Description Row */}
                <tr>
                  <td className="p-4 font-doodle font-bold text-doodle-text border-b border-dashed border-doodle-text/10">
                    Description
                  </td>
                  {items.map((product) => (
                    <td key={product.ProductID} className="p-4 text-center border-b border-dashed border-doodle-text/10">
                      <p className="font-doodle text-sm text-doodle-text/70 line-clamp-4">
                        {product.Description || 'No description available'}
                      </p>
                    </td>
                  ))}
                  {Array.from({ length: 3 - items.length }).map((_, i) => (
                    <td key={`empty-${i}`} className="p-4 border-b border-dashed border-doodle-text/10" />
                  ))}
                </tr>

                {/* Add to Cart Row */}
                <tr>
                  <td className="p-4 font-doodle font-bold text-doodle-text">
                    Action
                  </td>
                  {items.map((product) => (
                    <td key={product.ProductID} className="p-4 text-center">
                      <button
                        onClick={() => addToCart(product)}
                        className="doodle-button doodle-button-primary flex items-center gap-2 mx-auto"
                      >
                        <ShoppingCart className="w-4 h-4" />
                        Add to Cart
                      </button>
                    </td>
                  ))}
                  {Array.from({ length: 3 - items.length }).map((_, i) => (
                    <td key={`empty-${i}`} className="p-4" />
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ComparePage;
