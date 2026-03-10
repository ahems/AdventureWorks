import React, { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ShoppingCart,
  Heart,
  Star,
  Scale,
  Eye,
  ChevronDown,
} from "lucide-react";
import { ProductModelGroup, getSalePrice } from "@/types/product";
import { getProductVariant } from "@/utils/productGrouping";
import { OptimizedImage } from "@/components/OptimizedImage";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { useCompare } from "@/context/CompareContext";
import { useReviews } from "@/hooks/useReviews";
import { useCurrency } from "@/context/CurrencyContext";
import { useUnitMeasure } from "@/context/UnitMeasureContext";
import { useProductNames } from "@/context/ProductNamesContext";
import QuickViewModal from "./QuickViewModal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ProductModelCardProps {
  productGroup: ProductModelGroup;
  variant?: "default" | "featured";
}

const ProductModelCard: React.FC<ProductModelCardProps> = ({
  productGroup,
  variant = "default",
}) => {
  const { t } = useTranslation("common");
  const { addToCart } = useCart();
  const { addToWishlist, removeFromWishlist, isInWishlist } = useWishlist();
  const { addToCompare, removeFromCompare, isInCompare } = useCompare();
  const { formatPrice } = useCurrency();
  const { formatSize } = useUnitMeasure();
  const { getLocalizedName } = useProductNames();

  // State for selected variants
  const [selectedColor, setSelectedColor] = useState<string | undefined>(
    productGroup.colors.length > 0 ? productGroup.colors[0] : undefined
  );
  const [selectedSize, setSelectedSize] = useState<string | undefined>(
    productGroup.sizes.length > 0 ? productGroup.sizes[0] : undefined
  );
  const [quickViewOpen, setQuickViewOpen] = useState(false);

  // Get the current product variant based on selections
  const currentProduct = useMemo(() => {
    return getProductVariant(productGroup, selectedColor, selectedSize);
  }, [productGroup, selectedColor, selectedSize]);

  const localizedModelName =
    getLocalizedName(currentProduct.ProductID) ?? productGroup.modelName;

  const { averageRating, reviewCount } = useReviews(currentProduct.ProductID);

  const inWishlist = isInWishlist(currentProduct.ProductID);
  const inCompare = isInCompare(currentProduct.ProductID);
  const salePrice = getSalePrice(currentProduct);

  // Check if current variant is in stock
  const isInStock = currentProduct.inStock !== false;

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isInStock) {
      addToCart(currentProduct);
    }
  };

  const handleToggleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inWishlist) {
      removeFromWishlist(currentProduct.ProductID);
    } else {
      addToWishlist(currentProduct);
    }
  };

  const handleToggleCompare = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inCompare) {
      removeFromCompare(currentProduct.ProductID);
    } else {
      addToCompare(currentProduct);
    }
  };

  const handleQuickView = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setQuickViewOpen(true);
  };

  const handleColorChange = (value: string) => {
    setSelectedColor(value);
  };

  const handleSizeChange = (value: string) => {
    setSelectedSize(value);
  };

  return (
    <>
      <Link
        to={`/product/${currentProduct.ProductID}`}
        className="doodle-card block p-4 group relative"
      >
        {/* Sale Badge */}
        {currentProduct.DiscountPct && (
          <div className="absolute top-6 left-6 z-10 bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-3deg]">
            {variant === "featured"
              ? currentProduct.SpecialOfferDescription ||
                t("productCard.limitedTimeSpecial")
              : t("productCard.percentOff", {
                  percent: Math.round((currentProduct.DiscountPct || 0) * 100),
                })}
          </div>
        )}

        {/* Stock Badge */}
        {!isInStock && (
          <div className="absolute bottom-6 left-6 z-10 bg-red-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text">
            {t("productCard.outOfStock")}
          </div>
        )}
        {isInStock &&
          currentProduct.quantityAvailable !== undefined &&
          currentProduct.quantityAvailable < 50 && (
            <div className="absolute bottom-6 left-6 z-10 bg-orange-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text">
              {t("productCard.lowStock")}
            </div>
          )}

        {/* Wishlist & Compare Buttons */}
        <div className="absolute top-6 right-6 z-10 flex flex-col gap-2">
          <button
            onClick={handleToggleWishlist}
            className={`p-2 border-2 transition-all ${
              inWishlist
                ? "bg-doodle-accent border-doodle-accent text-white"
                : "bg-doodle-bg border-doodle-text/30 text-doodle-text/50 hover:border-doodle-accent hover:text-doodle-accent"
            }`}
            aria-label={
              inWishlist
                ? t("productCard.removeFromWishlist")
                : t("productCard.addToWishlist")
            }
          >
            <Heart className={`w-4 h-4 ${inWishlist ? "fill-current" : ""}`} />
          </button>
          <button
            onClick={handleToggleCompare}
            className={`p-2 border-2 transition-all ${
              inCompare
                ? "bg-doodle-green border-doodle-green text-white"
                : "bg-doodle-bg border-doodle-text/30 text-doodle-text/50 hover:border-doodle-green hover:text-doodle-green"
            }`}
            aria-label={
              inCompare
                ? t("productCard.removeFromComparison")
                : t("productCard.addToComparison")
            }
          >
            <Scale className="w-4 h-4" />
          </button>
        </div>

        {/* Product Image */}
        <div className="aspect-square mb-4 bg-doodle-bg border-2 border-doodle-text border-dashed flex items-center justify-center overflow-hidden relative">
          {currentProduct.ThumbNailPhoto ? (
            <OptimizedImage
              src={`data:image/gif;base64,${currentProduct.ThumbNailPhoto}`}
              alt={`${localizedModelName}${
                currentProduct.Color ? ` - ${currentProduct.Color}` : ""
              }`}
              className="!aspect-square"
            />
          ) : (
            <div className="text-center p-4">
              <span className="font-doodle text-4xl">🚴</span>
              <p className="font-doodle text-xs text-doodle-text/60 mt-2">
                {currentProduct.Color || t("productCard.productImage")}
              </p>
            </div>
          )}

          {/* Multiple Variants Badge - only show if more than 1 variant */}
          {productGroup.variants.length > 1 && (
            <div className="absolute bottom-2 right-2 z-10 bg-doodle-green text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text">
              {productGroup.variants.length}{" "}
              {t("productCard.variants", {
                count: productGroup.variants.length,
              })}
            </div>
          )}

          {/* Quick View Button - appears on hover */}
          <button
            onClick={handleQuickView}
            className="absolute inset-0 bg-doodle-text/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200"
          >
            <span className="doodle-button doodle-button-primary flex items-center gap-2">
              <Eye className="w-4 h-4" />
              {t("productCard.quickView")}
            </span>
          </button>
        </div>

        {/* Product Info */}
        <div className="space-y-3">
          <h3 className="font-doodle text-lg font-bold text-doodle-text group-hover:text-doodle-accent transition-colors line-clamp-2">
            {localizedModelName}
          </h3>

          {/* Variant Selectors */}
          <div className="space-y-2" onClick={(e) => e.preventDefault()}>
            {/* Color Selector */}
            {productGroup.colors.length > 1 && (
              <div className="space-y-1">
                <label className="font-doodle text-xs text-doodle-text/70">
                  {t("productCard.color")}:
                </label>
                <Select value={selectedColor} onValueChange={handleColorChange}>
                  <SelectTrigger className="w-full font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-2 border-doodle-text">
                    {productGroup.colors.map((color) => (
                      <SelectItem
                        key={color}
                        value={color}
                        className="font-doodle text-sm"
                      >
                        {color}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Size Selector */}
            {productGroup.sizes.length > 1 && (
              <div className="space-y-1">
                <label className="font-doodle text-xs text-doodle-text/70">
                  {t("productCard.selectSize")}:
                </label>
                <Select value={selectedSize} onValueChange={handleSizeChange}>
                  <SelectTrigger className="w-full font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-2 border-doodle-text">
                    {productGroup.sizes.map((size) => (
                      <SelectItem
                        key={size}
                        value={size}
                        className="font-doodle text-sm"
                      >
                        {formatSize(size, currentProduct.SizeUnitMeasureCode)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Show single color/size as badge if only one option */}
            {productGroup.colors.length === 1 && (
              <span className="inline-block font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                {productGroup.colors[0]}
              </span>
            )}
            {productGroup.sizes.length === 1 && (
              <span className="inline-block font-doodle text-xs px-2 py-0.5 bg-doodle-text/10 border border-doodle-text/30">
                {t("productCard.size", {
                  size: formatSize(
                    productGroup.sizes[0],
                    currentProduct.SizeUnitMeasureCode
                  ),
                })}
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
                      ? "text-doodle-accent fill-current"
                      : "text-doodle-text/20"
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
                    {productGroup.priceRange.min === productGroup.priceRange.max
                      ? formatPrice(currentProduct.ListPrice)
                      : `${formatPrice(
                          productGroup.priceRange.min
                        )} - ${formatPrice(productGroup.priceRange.max)}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-doodle text-xl font-bold text-doodle-accent">
                      {formatPrice(salePrice)}
                    </span>
                    {variant === "featured" && (
                      <span className="font-doodle text-xs font-bold text-doodle-green">
                        {t("productCard.save", {
                          percent: Math.round(
                            (currentProduct.DiscountPct || 0) * 100
                          ),
                        })}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <span className="font-doodle text-xl font-bold text-doodle-green">
                  {productGroup.priceRange.min === productGroup.priceRange.max
                    ? formatPrice(currentProduct.ListPrice)
                    : `${formatPrice(
                        productGroup.priceRange.min
                      )} - ${formatPrice(productGroup.priceRange.max)}`}
                </span>
              )}
            </div>

            <button
              onClick={handleAddToCart}
              disabled={!isInStock}
              className={`p-2 text-sm flex items-center gap-1 ${
                isInStock
                  ? "doodle-button doodle-button-primary"
                  : "doodle-button bg-doodle-text/20 text-doodle-text/50 cursor-not-allowed border-doodle-text/30"
              }`}
              aria-label={t("productCard.addToCart")}
            >
              <ShoppingCart className="w-4 h-4" />
              <span className="hidden sm:inline">
                {isInStock
                  ? t("productCard.add")
                  : t("productCard.notAvailable")}
              </span>
            </button>
          </div>
        </div>
      </Link>

      {/* Quick View Modal */}
      <QuickViewModal
        product={currentProduct}
        open={quickViewOpen}
        onOpenChange={setQuickViewOpen}
      />
    </>
  );
};

export default ProductModelCard;
