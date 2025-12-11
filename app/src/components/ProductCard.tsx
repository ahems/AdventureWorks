import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingCart, Heart, Star, Scale, Eye } from 'lucide-react';
import { Product, getSalePrice } from '@/types/product';
import { useCart } from '@/context/CartContext';
import { useWishlist } from '@/context/WishlistContext';
import { useCompare } from '@/context/CompareContext';
import { useReviews } from '@/hooks/useReviews';
import QuickViewModal from './QuickViewModal';

interface ProductCardProps {
  product: Product;
  variant?: 'default' | 'featured';
}

const ProductCard: React.FC<ProductCardProps> = ({ product, variant = 'default' }) => {
  const { addToCart } = useCart();
  const { addToWishlist, removeFromWishlist, isInWishlist } = useWishlist();
  const { addToCompare, removeFromCompare, isInCompare } = useCompare();
  const { averageRating, reviewCount } = useReviews(product.ProductID);
  const [quickViewOpen, setQuickViewOpen] = useState(false);
  
  const inWishlist = isInWishlist(product.ProductID);
  const inCompare = isInCompare(product.ProductID);
  const salePrice = getSalePrice(product);

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addToCart(product);
  };

  const handleToggleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inWishlist) {
      removeFromWishlist(product.ProductID);
    } else {
      addToWishlist(product);
    }
  };

  const handleToggleCompare = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inCompare) {
      removeFromCompare(product.ProductID);
    } else {
      addToCompare(product);
    }
  };

  const handleQuickView = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setQuickViewOpen(true);
  };

  return (
    <>
      <Link 
        to={`/product/${product.ProductID}`}
        className="doodle-card block p-4 group relative"
      >
        {/* Sale Badge */}
        {product.DiscountPct && (
          <div className="absolute top-6 left-6 z-10 bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-3deg]">
            {variant === 'featured' ? (product.SpecialOfferDescription || 'Limited-Time Special') : `${Math.round((product.DiscountPct || 0) * 100)}% OFF`}
          </div>
        )}

        {/* Stock Badge */}
        {!product.inStock && (
          <div className="absolute bottom-6 left-6 z-10 bg-red-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text">
            OUT OF STOCK
          </div>
        )}
        {product.inStock && product.quantityAvailable !== undefined && product.quantityAvailable < 50 && (
          <div className="absolute bottom-6 left-6 z-10 bg-orange-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text">
            LOW STOCK
          </div>
        )}

        {/* Wishlist & Compare Buttons */}
        <div className="absolute top-6 right-6 z-10 flex flex-col gap-2">
          <button
            onClick={handleToggleWishlist}
            className={`p-2 border-2 transition-all ${
              inWishlist 
                ? 'bg-doodle-accent border-doodle-accent text-white' 
                : 'bg-doodle-bg border-doodle-text/30 text-doodle-text/50 hover:border-doodle-accent hover:text-doodle-accent'
            }`}
            aria-label={inWishlist ? "Remove from wishlist" : "Add to wishlist"}
          >
            <Heart className={`w-4 h-4 ${inWishlist ? 'fill-current' : ''}`} />
          </button>
          <button
            onClick={handleToggleCompare}
            className={`p-2 border-2 transition-all ${
              inCompare 
                ? 'bg-doodle-green border-doodle-green text-white' 
                : 'bg-doodle-bg border-doodle-text/30 text-doodle-text/50 hover:border-doodle-green hover:text-doodle-green'
            }`}
            aria-label={inCompare ? "Remove from comparison" : "Add to comparison"}
          >
            <Scale className="w-4 h-4" />
          </button>
        </div>

        {/* Product Image */}
        <div className="aspect-square mb-4 bg-doodle-bg border-2 border-doodle-text border-dashed flex items-center justify-center overflow-hidden relative">
          {product.ThumbNailPhoto ? (
            <img 
              src={`data:image/gif;base64,${product.ThumbNailPhoto}`}
              alt={product.Name}
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="text-center p-4">
              <span className="font-doodle text-4xl">🚴</span>
              <p className="font-doodle text-xs text-doodle-text/60 mt-2">
                {product.Color || 'Product Image'}
              </p>
            </div>
          )}
          
          {/* Quick View Button - appears on hover */}
          <button
            onClick={handleQuickView}
            className="absolute inset-0 bg-doodle-text/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200"
          >
            <span className="doodle-button doodle-button-primary flex items-center gap-2">
              <Eye className="w-4 h-4" />
              Quick View
            </span>
          </button>
        </div>

        {/* Product Info */}
        <div className="space-y-2">
          <h3 className="font-doodle text-lg font-bold text-doodle-text group-hover:text-doodle-accent transition-colors line-clamp-2">
            {product.Name}
          </h3>
          
          <div className="flex items-center gap-2 flex-wrap">
            {product.Color && (
              <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                {product.Color}
              </span>
            )}
            {product.Size && (
              <span className="font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                Size: {product.Size}
              </span>
            )}
          </div>

          {/* Star Rating */}
          <div className="flex items-center gap-1">
            <div className="flex items-center gap-0.5">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`w-3 h-3 ${
                    i < Math.round(averageRating)
                      ? 'text-doodle-accent fill-current'
                      : 'text-doodle-text/20'
                  }`}
                />
              ))}
            </div>
            {reviewCount > 0 && (
              <span className="font-doodle text-xs text-doodle-text/50">
                ({reviewCount})
              </span>
            )}
          </div>

          <div className="flex items-end justify-between pt-2">
            <div className="flex flex-col">
              {salePrice ? (
                <>
                  <span className="font-doodle text-sm text-doodle-text/50 line-through">
                    ${product.ListPrice.toFixed(2)}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-doodle text-xl font-bold text-doodle-accent">
                      ${salePrice.toFixed(2)}
                    </span>
                    {variant === 'featured' && (
                      <span className="font-doodle text-xs font-bold text-doodle-green">
                        Save {Math.round((product.DiscountPct || 0) * 100)}%
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <span className="font-doodle text-xl font-bold text-doodle-green">
                  ${product.ListPrice.toFixed(2)}
                </span>
              )}
            </div>
            
            <button
              onClick={handleAddToCart}
              disabled={!product.inStock}
              className={`p-2 text-sm flex items-center gap-1 ${
                product.inStock
                  ? 'doodle-button doodle-button-primary'
                  : 'doodle-button bg-doodle-text/20 text-doodle-text/50 cursor-not-allowed border-doodle-text/30'
              }`}
              aria-label="Add to cart"
            >
              <ShoppingCart className="w-4 h-4" />
              <span className="hidden sm:inline">{product.inStock ? 'Add' : 'N/A'}</span>
            </button>
          </div>
        </div>
      </Link>

      {/* Quick View Modal */}
      <QuickViewModal
        product={product}
        open={quickViewOpen}
        onOpenChange={setQuickViewOpen}
      />
    </>
  );
};

export default ProductCard;
