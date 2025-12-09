import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingCart, Star, Bell } from 'lucide-react';
import { Product, getSalePrice, isVariantAvailable } from '@/types/product';
import { useCart } from '@/context/CartContext';
import { useReviews } from '@/hooks/useReviews';
import { toast } from '@/hooks/use-toast';
import NotifyWhenAvailable from '@/components/NotifyWhenAvailable';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SaleProductCardProps {
  product: Product;
}

const SaleProductCard: React.FC<SaleProductCardProps> = ({ product }) => {
  const { addToCart } = useCart();
  const { averageRating } = useReviews(product.ProductID);
  const [selectedSize, setSelectedSize] = useState<string | undefined>(undefined);
  const [selectedColor, setSelectedColor] = useState<string | undefined>(undefined);
  
  const salePrice = getSalePrice(product);
  const hasVariants = product.availableSizes || product.availableColors;

  // Check if current selection is available
  const currentVariantAvailable = isVariantAvailable(product, selectedSize, selectedColor);
  const showUnavailable = hasVariants && selectedSize && selectedColor && !currentVariantAvailable;

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (product.availableSizes && !selectedSize) {
      toast({
        title: "Please select a size",
        description: "Choose a size before adding to cart",
        variant: "destructive"
      });
      return;
    }
    if (product.availableColors && !selectedColor) {
      toast({
        title: "Please select a color",
        description: "Choose a color before adding to cart",
        variant: "destructive"
      });
      return;
    }

    if (!currentVariantAvailable) {
      toast({
        title: "Currently Unavailable",
        description: "This size/color combination is out of stock",
        variant: "destructive"
      });
      return;
    }
    
    addToCart(product, 1, selectedSize, selectedColor);
  };

  return (
    <div className="doodle-card group hover:border-doodle-accent transition-all duration-200 flex flex-col h-full">
      {/* Image & Badge */}
      <Link to={`/product/${product.ProductID}`} className="block relative">
        <div className="aspect-square bg-doodle-bg border-b-2 border-dashed border-doodle-text flex items-center justify-center overflow-hidden">
          {product.ThumbNailPhoto ? (
            <img 
              src={`data:image/gif;base64,${product.ThumbNailPhoto}`}
              alt={product.Name}
              className="w-full h-full object-contain group-hover:scale-110 transition-transform duration-300"
            />
          ) : (
            <span className="text-6xl group-hover:scale-110 transition-transform duration-300">
              🚴
            </span>
          )}
        </div>
        
        {/* Sale Badge */}
        <div className="absolute top-2 left-2">
          <span className="bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-3deg] inline-block">
            {product.SpecialOfferDescription || 'Limited-Time Special'}
          </span>
        </div>

        {/* Stock Badge */}
        {!product.inStock && (
          <div className="absolute bottom-2 left-2">
            <span className="bg-red-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text inline-block">
              OUT OF STOCK
            </span>
          </div>
        )}
      </Link>

      {/* Content */}
      <div className="p-4 flex-1 flex flex-col">
        {/* Title & Rating */}
        <Link to={`/product/${product.ProductID}`}>
          <h3 className="font-doodle font-bold text-doodle-text group-hover:text-doodle-accent transition-colors line-clamp-2 mb-1">
            {product.Name}
          </h3>
        </Link>
        
        {/* Star Rating */}
        {averageRating > 0 && (
          <div className="flex items-center gap-1 mb-2">
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
            <span className="font-doodle text-xs text-doodle-text/50 ml-1">
              {averageRating.toFixed(1)}
            </span>
          </div>
        )}

        {/* Price */}
        <div className="mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-doodle text-sm text-doodle-text/50 line-through">
              ${product.ListPrice.toFixed(2)}
            </span>
            <span className="font-doodle text-xl font-bold text-doodle-accent">
              ${salePrice?.toFixed(2)}
            </span>
          </div>
          <span className="font-doodle text-xs text-doodle-green font-bold">
            Save {Math.round((product.DiscountPct || product.salePercent! / 100) * 100)}%
          </span>
        </div>

        {/* Variant Selectors */}
        {hasVariants && (
          <div className="space-y-2 mb-3">
            {product.availableSizes && (
              <Select value={selectedSize} onValueChange={setSelectedSize}>
                <SelectTrigger 
                  className="w-full font-doodle text-sm border-2 border-doodle-text/50 bg-white focus:border-doodle-accent h-9"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectValue placeholder="Select Size" />
                </SelectTrigger>
                <SelectContent className="bg-white border-2 border-doodle-text z-50">
                  {product.availableSizes.map((size) => (
                    <SelectItem 
                      key={size} 
                      value={size}
                      className="font-doodle cursor-pointer hover:bg-doodle-accent/10"
                    >
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            
            {product.availableColors && (
              <Select value={selectedColor} onValueChange={setSelectedColor}>
                <SelectTrigger 
                  className="w-full font-doodle text-sm border-2 border-doodle-text/50 bg-white focus:border-doodle-accent h-9"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SelectValue placeholder="Select Color" />
                </SelectTrigger>
                <SelectContent className="bg-white border-2 border-doodle-text z-50">
                  {product.availableColors.map((color) => (
                    <SelectItem 
                      key={color} 
                      value={color}
                      className="font-doodle cursor-pointer hover:bg-doodle-accent/10"
                    >
                      {color}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        {/* Unavailable Warning with Notify */}
        {showUnavailable && (
          <div className="bg-doodle-accent/10 border border-dashed border-doodle-accent p-2 mb-2 space-y-2">
            <p className="font-doodle text-xs text-doodle-accent font-bold">
              ⚠️ Currently Unavailable
            </p>
            <NotifyWhenAvailable
              productName={product.Name}
              size={selectedSize}
              color={selectedColor}
              trigger={
                <button 
                  onClick={(e) => e.preventDefault()}
                  className="w-full doodle-button flex items-center justify-center gap-1 text-xs py-1"
                >
                  <Bell className="w-3 h-3" />
                  Notify me
                </button>
              }
            />
          </div>
        )}

        {/* Add to Cart Button */}
        <div className="mt-auto">
          <button
            onClick={handleAddToCart}
            disabled={!product.inStock || showUnavailable}
            className={`w-full flex items-center justify-center gap-2 py-2 ${
              !product.inStock || showUnavailable
                ? 'doodle-button bg-doodle-text/20 text-doodle-text/50 cursor-not-allowed border-doodle-text/30'
                : 'doodle-button doodle-button-primary'
            }`}
          >
            <ShoppingCart className="w-4 h-4" />
            {!product.inStock ? 'Out of Stock' : (showUnavailable ? 'Unavailable' : 'Add to Cart')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SaleProductCard;
