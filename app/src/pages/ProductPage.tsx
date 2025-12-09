import React, { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, ShoppingCart, Minus, Plus, Star, Truck, Shield, RotateCcw, Bell, Heart } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ProductReviews from '@/components/ProductReviews';
import RecentlyViewed from '@/components/RecentlyViewed';
import ProductImageGallery from '@/components/ProductImageGallery';
import NotifyWhenAvailable from '@/components/NotifyWhenAvailable';
import { useCart } from '@/context/CartContext';
import { useWishlist } from '@/context/WishlistContext';
import { useRecentlyViewed } from '@/context/RecentlyViewedContext';
import { useProduct, useSubcategory, useCategory } from '@/hooks/useProducts';
import { getSalePrice, isVariantAvailable } from '@/types/product';
import { useReviews } from '@/hooks/useReviews';
import { toast } from '@/hooks/use-toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ProductPage: React.FC = () => {
  const { productId } = useParams<{ productId: string }>();
  const { addToCart } = useCart();
  const { addToWishlist, removeFromWishlist, isInWishlist } = useWishlist();
  const { addToRecentlyViewed } = useRecentlyViewed();
  const [quantity, setQuantity] = React.useState(1);
  const [selectedSize, setSelectedSize] = React.useState<string | undefined>(undefined);
  const [selectedColor, setSelectedColor] = React.useState<string | undefined>(undefined);
  
  const { data: product, isLoading: productLoading } = useProduct(productId ? parseInt(productId) : 0);
  const { data: subcategory } = useSubcategory(product?.ProductSubcategoryID || 0);
  const { data: category } = useCategory(subcategory?.ProductCategoryID || 0);
  
  const inWishlist = product ? isInWishlist(product.ProductID) : false;
  const salePrice = product ? getSalePrice(product) : null;
  const { averageRating, reviewCount } = useReviews(product?.ProductID || 0);

  // Check if this is a clothing item with variants
  const hasVariants = product?.availableSizes || product?.availableColors;
  const isClothing = category?.ProductCategoryID === 3; // Clothing category

  // Check if current selection is available
  const currentVariantAvailable = product 
    ? isVariantAvailable(product, selectedSize, selectedColor) 
    : true;

  // Add to recently viewed when product loads
  useEffect(() => {
    if (product) {
      addToRecentlyViewed(product);
    }
  }, [product, addToRecentlyViewed]);

  if (productLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="text-center">
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              Loading product...
            </h1>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="text-center">
            <span className="text-6xl mb-4 block">🔍</span>
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
              Product Not Found
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

  const handleAddToCart = () => {
    // Validate size and color selection for clothing items
    if (hasVariants) {
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
      // Check if the selected combination is available
      if (!isVariantAvailable(product, selectedSize, selectedColor)) {
        toast({
          title: "Currently Unavailable",
          description: "This size/color combination is out of stock",
          variant: "destructive"
        });
        return;
      }
    }
    addToCart(product, quantity, selectedSize, selectedColor);
  };

  const handleToggleWishlist = () => {
    if (!product) return;
    if (inWishlist) {
      removeFromWishlist(product.ProductID);
    } else {
      addToWishlist(product);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-wrap items-center gap-2 font-doodle text-sm text-doodle-text/70">
            <Link to="/" className="hover:text-doodle-accent transition-colors">
              Home
            </Link>
            <span>/</span>
            {category && (
              <>
                <Link 
                  to={`/category/${category.ProductCategoryID}`}
                  className="hover:text-doodle-accent transition-colors"
                >
                  {category.Name}
                </Link>
                <span>/</span>
              </>
            )}
            <span className="text-doodle-text">{product.Name}</span>
          </div>
        </div>

        {/* Product Details */}
        <section className="container mx-auto px-4 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
            {/* Product Image Gallery */}
            <ProductImageGallery 
              productName={product.Name} 
              color={selectedColor || product.Color} 
            />

            {/* Product Info */}
            <div className="space-y-6">
              {/* Title & Price */}
              <div>
                <div className="flex items-center gap-3">
                  {subcategory && (
                    <span className="font-doodle text-sm text-doodle-accent uppercase tracking-wide">
                      {subcategory.Name}
                    </span>
                  )}
                  {product.salePercent && (
                    <span className="bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-2deg]">
                      Limited-Time Special
                    </span>
                  )}
                </div>
                <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mt-1">
                  {product.Name}
                </h1>
                <div className="flex items-center gap-3 mt-2">
                  <div className="flex items-center gap-1 text-doodle-accent">
                    {[...Array(5)].map((_, i) => (
                      <Star 
                        key={i} 
                        className={`w-4 h-4 ${
                          i < Math.round(averageRating)
                            ? 'fill-current'
                            : 'text-doodle-text/20'
                        }`} 
                      />
                    ))}
                  </div>
                  <span className="font-doodle text-sm text-doodle-text/60">
                    {averageRating > 0 ? `${averageRating.toFixed(1)} (${reviewCount} reviews)` : 'No reviews yet'}
                  </span>
                </div>
              </div>

              {/* Price */}
              <div className="doodle-border-light inline-block px-6 py-3">
                {salePrice ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-3">
                      <span className="font-doodle text-xl text-doodle-text/50 line-through">
                        ${product.ListPrice.toFixed(2)}
                      </span>
                      <span className="font-doodle text-3xl font-bold text-doodle-accent">
                        ${salePrice.toFixed(2)}
                      </span>
                    </div>
                    <span className="font-doodle text-sm text-doodle-green font-bold">
                      Save {product.salePercent}%
                    </span>
                  </div>
                ) : (
                  <span className="font-doodle text-3xl font-bold text-doodle-green">
                    ${product.ListPrice.toFixed(2)}
                  </span>
                )}
              </div>

              {/* Description */}
              <p className="font-doodle text-lg text-doodle-text/80 leading-relaxed">
                {product.Description || 
                  "Premium quality gear designed for outdoor enthusiasts who demand the best. Built to last and engineered for performance."}
              </p>

              {/* Specs */}
              <div className="doodle-card p-4 space-y-2">
                <h3 className="font-doodle font-bold text-doodle-text">Specifications:</h3>
                <div className="grid grid-cols-2 gap-2 font-doodle text-sm">
                  {product.Color && !hasVariants && (
                    <>
                      <span className="text-doodle-text/60">Color:</span>
                      <span className="text-doodle-text">{product.Color}</span>
                    </>
                  )}
                  {product.Size && !hasVariants && (
                    <>
                      <span className="text-doodle-text/60">Size:</span>
                      <span className="text-doodle-text">{product.Size}</span>
                    </>
                  )}
                  {product.Weight && (
                    <>
                      <span className="text-doodle-text/60">Weight:</span>
                      <span className="text-doodle-text">{product.Weight} lbs</span>
                    </>
                  )}
                  <span className="text-doodle-text/60">SKU:</span>
                  <span className="text-doodle-text">{product.ProductNumber}</span>
                </div>
              </div>

              {/* Size Selection Dropdown */}
              {product.availableSizes && (
                <div className="space-y-3">
                  <h3 className="font-doodle font-bold text-doodle-text">
                    Size <span className="text-doodle-accent">*</span>
                  </h3>
                  <Select value={selectedSize} onValueChange={setSelectedSize}>
                    <SelectTrigger className="w-full max-w-xs font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent">
                      <SelectValue placeholder="Select a size" />
                    </SelectTrigger>
                    <SelectContent className="bg-white border-2 border-doodle-text">
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
                </div>
              )}

              {/* Color Selection for Clothing */}
              {product.availableColors && (
                <div className="space-y-3">
                  <h3 className="font-doodle font-bold text-doodle-text">
                    Color <span className="text-doodle-accent">*</span>
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {product.availableColors.map((color) => (
                      <button
                        key={color}
                        onClick={() => setSelectedColor(color)}
                        className={`font-doodle px-4 py-2 border-2 transition-all ${
                          selectedColor === color
                            ? 'border-doodle-accent bg-doodle-accent text-white'
                            : 'border-doodle-text hover:border-doodle-accent hover:bg-doodle-accent/10'
                        }`}
                      >
                        {color}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Availability Warning with Notify Button */}
              {hasVariants && selectedSize && selectedColor && !currentVariantAvailable && (
                <div className="bg-doodle-accent/10 border-2 border-dashed border-doodle-accent p-4 space-y-3">
                  <div>
                    <p className="font-doodle text-doodle-accent font-bold flex items-center gap-2">
                      ⚠️ Currently Unavailable
                    </p>
                    <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                      This size and color combination is out of stock.
                    </p>
                  </div>
                  <NotifyWhenAvailable
                    productName={product.Name}
                    size={selectedSize}
                    color={selectedColor}
                    trigger={
                      <button className="doodle-button flex items-center gap-2 text-sm">
                        <Bell className="w-4 h-4" />
                        Notify me when available
                      </button>
                    }
                  />
                </div>
              )}

              {/* Quantity & Add to Cart */}
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex items-center doodle-border-light">
                  <button
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    className="p-3 hover:bg-doodle-text/10 transition-colors"
                    aria-label="Decrease quantity"
                  >
                    <Minus className="w-5 h-5" />
                  </button>
                  <span className="font-doodle text-xl font-bold px-6 min-w-[60px] text-center">
                    {quantity}
                  </span>
                  <button
                    onClick={() => setQuantity(quantity + 1)}
                    className="p-3 hover:bg-doodle-text/10 transition-colors"
                    aria-label="Increase quantity"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>

                <button
                  onClick={handleAddToCart}
                  disabled={hasVariants && selectedSize && selectedColor && !currentVariantAvailable}
                  className={`flex-1 flex items-center justify-center gap-2 text-lg py-3 ${
                    hasVariants && selectedSize && selectedColor && !currentVariantAvailable
                      ? 'doodle-button bg-doodle-text/20 text-doodle-text/50 cursor-not-allowed border-doodle-text/30'
                      : 'doodle-button doodle-button-primary'
                  }`}
                >
                  <ShoppingCart className="w-5 h-5" />
                  {hasVariants && selectedSize && selectedColor && !currentVariantAvailable
                    ? 'Unavailable'
                    : 'Add to Cart'}
                </button>

                <button
                  onClick={handleToggleWishlist}
                  className={`p-3 border-2 transition-all ${
                    inWishlist 
                      ? 'bg-doodle-accent border-doodle-accent text-white' 
                      : 'border-doodle-text hover:border-doodle-accent hover:text-doodle-accent'
                  }`}
                  aria-label={inWishlist ? "Remove from wishlist" : "Add to wishlist"}
                >
                  <Heart className={`w-5 h-5 ${inWishlist ? 'fill-current' : ''}`} />
                </button>
              </div>

              {/* Benefits */}
              <div className="grid grid-cols-3 gap-4 pt-4 border-t-2 border-dashed border-doodle-text/20">
                <div className="text-center">
                  <Truck className="w-6 h-6 mx-auto mb-2 text-doodle-green" />
                  <span className="font-doodle text-xs text-doodle-text/70">Free Shipping</span>
                </div>
                <div className="text-center">
                  <Shield className="w-6 h-6 mx-auto mb-2 text-doodle-green" />
                  <span className="font-doodle text-xs text-doodle-text/70">2 Year Warranty</span>
                </div>
                <div className="text-center">
                  <RotateCcw className="w-6 h-6 mx-auto mb-2 text-doodle-green" />
                  <span className="font-doodle text-xs text-doodle-text/70">30 Day Returns</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Reviews Section */}
        <ProductReviews productId={product.ProductID} />

        {/* Recently Viewed */}
        <RecentlyViewed currentProductId={product.ProductID} />

        {/* Back Button */}
        <section className="container mx-auto px-4 pb-12">
          <Link 
            to={category ? `/category/${category.ProductCategoryID}` : '/'}
            className="doodle-button inline-flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to {category?.Name || 'Shop'}
          </Link>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ProductPage;
