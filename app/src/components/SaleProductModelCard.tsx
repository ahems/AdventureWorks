import React, { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShoppingCart, Star, Bell } from "lucide-react";
import {
  ProductModelGroup,
  getSalePrice,
  isVariantAvailable,
} from "@/types/product";
import { getProductVariant } from "@/utils/productGrouping";
import { OptimizedImage } from "@/components/OptimizedImage";
import { useCart } from "@/context/CartContext";
import { useReviews } from "@/hooks/useReviews";
import { toast } from "@/hooks/use-toast";
import { useCurrency } from "@/context/CurrencyContext";
import { useUnitMeasure } from "@/context/UnitMeasureContext";
import NotifyWhenAvailable from "@/components/NotifyWhenAvailable";
import { TwemojiText } from "@/components/TwemojiText";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SaleProductModelCardProps {
  productGroup: ProductModelGroup;
}

const SaleProductModelCard: React.FC<SaleProductModelCardProps> = ({
  productGroup,
}) => {
  const { t } = useTranslation("common");
  const { addToCart } = useCart();
  const { formatPrice } = useCurrency();
  const { formatSize } = useUnitMeasure();

  // State for selected variants
  const [selectedColor, setSelectedColor] = useState<string | undefined>(
    productGroup.colors.length > 0 ? productGroup.colors[0] : undefined
  );
  const [selectedSize, setSelectedSize] = useState<string | undefined>(
    productGroup.sizes.length > 0 ? productGroup.sizes[0] : undefined
  );

  // Get the current product variant based on selections
  const currentProduct = useMemo(() => {
    return getProductVariant(productGroup, selectedColor, selectedSize);
  }, [productGroup, selectedColor, selectedSize]);

  const { averageRating } = useReviews(currentProduct.ProductID);
  const salePrice = getSalePrice(currentProduct);
  const hasVariants =
    productGroup.colors.length > 0 || productGroup.sizes.length > 0;

  // Check if current selection is available
  const currentVariantAvailable = isVariantAvailable(
    currentProduct,
    selectedSize,
    selectedColor
  );
  const showUnavailable =
    hasVariants && selectedSize && selectedColor && !currentVariantAvailable;

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!hasVariants || (selectedSize && selectedColor)) {
      if (currentVariantAvailable && currentProduct.inStock) {
        addToCart(currentProduct, 1, selectedSize, selectedColor);
        toast({
          title: t("toast.addedToCart"),
          description: `${currentProduct.Name} ${t(
            "toast.addedToCartDescription"
          )}`,
        });
      }
    } else {
      if (!selectedSize && productGroup.sizes.length > 0) {
        toast({
          title: t("saleProductCard.pleasSelectSize"),
          description: t("saleProductCard.chooseASizeBeforeAddingToCart"),
          variant: "destructive",
        });
      } else if (!selectedColor && productGroup.colors.length > 0) {
        toast({
          title: t("saleProductCard.pleaseSelectColor"),
          description: t("saleProductCard.chooseAColorBeforeAddingToCart"),
          variant: "destructive",
        });
      }
    }
  };

  const handleColorChange = (value: string) => {
    setSelectedColor(value);
  };

  const handleSizeChange = (value: string) => {
    setSelectedSize(value);
  };

  return (
    <Link
      to={`/product/${currentProduct.ProductID}`}
      className="doodle-card block p-4 group relative bg-white"
    >
      {/* Sale Badge */}
      {currentProduct.DiscountPct && (
        <div className="absolute top-4 right-4 z-10 bg-doodle-accent text-white font-doodle text-sm font-bold px-3 py-1.5 border-2 border-doodle-text rotate-3 shadow-doodle">
          {t("saleProductCard.save", {
            percent: Math.round((currentProduct.DiscountPct || 0) * 100),
          })}
        </div>
      )}

      {/* Product Image */}
      <div className="aspect-square mb-4 bg-doodle-bg border-2 border-doodle-text border-dashed flex items-center justify-center overflow-hidden relative">
        {currentProduct.ThumbNailPhoto ? (
          <OptimizedImage
            src={`data:image/gif;base64,${currentProduct.ThumbNailPhoto}`}
            alt={`${productGroup.modelName}${
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
            {t("productCard.variants", { count: productGroup.variants.length })}
          </div>
        )}
      </div>

      {/* Product Info */}
      <div className="space-y-3">
        <h3 className="font-doodle text-lg font-bold text-doodle-text group-hover:text-doodle-accent transition-colors line-clamp-2">
          {productGroup.modelName}
        </h3>

        {/* Variant Selectors */}
        <div className="space-y-2" onClick={(e) => e.preventDefault()}>
          {/* Color Selector */}
          {productGroup.colors.length > 0 && (
            <div className="space-y-1">
              <label className="font-doodle text-xs text-doodle-text/70">
                {t("saleProductCard.selectColor")}:
              </label>
              <Select value={selectedColor} onValueChange={handleColorChange}>
                <SelectTrigger className="w-full font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent h-9 text-sm">
                  <SelectValue placeholder={t("saleProductCard.selectColor")} />
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
          {productGroup.sizes.length > 0 && (
            <div className="space-y-1">
              <label className="font-doodle text-xs text-doodle-text/70">
                {t("saleProductCard.selectSize")}:
              </label>
              <Select value={selectedSize} onValueChange={handleSizeChange}>
                <SelectTrigger className="w-full font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent h-9 text-sm">
                  <SelectValue placeholder={t("saleProductCard.selectSize")} />
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
        </div>

        {/* Price */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-doodle text-sm text-doodle-text/50 line-through">
              {productGroup.priceRange.min === productGroup.priceRange.max
                ? formatPrice(currentProduct.ListPrice)
                : `${formatPrice(productGroup.priceRange.min)} - ${formatPrice(
                    productGroup.priceRange.max
                  )}`}
            </span>
          </div>
          {salePrice && (
            <div className="flex items-baseline gap-2">
              <span className="font-doodle text-2xl font-bold text-doodle-accent">
                {formatPrice(salePrice)}
              </span>
              <span className="font-doodle text-sm font-bold text-doodle-green">
                {t("saleProductCard.save", {
                  percent: Math.round((currentProduct.DiscountPct || 0) * 100),
                })}
              </span>
            </div>
          )}
        </div>

        {/* Stock/Availability Status */}
        {showUnavailable ? (
          <div className="bg-doodle-accent/10 border border-dashed border-doodle-accent p-2 space-y-2">
            <p className="font-doodle text-xs text-doodle-accent font-bold">
              <TwemojiText
                text={t("saleProductCard.currentlyUnavailableWarning")}
                size="0.75rem"
              />
            </p>
            <NotifyWhenAvailable
              productName={currentProduct.Name}
              size={selectedSize}
              color={selectedColor}
              trigger={
                <button
                  onClick={(e) => e.preventDefault()}
                  className="w-full doodle-button flex items-center justify-center gap-1 text-xs py-1"
                >
                  <Bell className="w-3 h-3" />
                  <span>{t("saleProductCard.notifyMe")}</span>
                </button>
              }
            />
          </div>
        ) : !currentProduct.inStock ? (
          <div className="bg-red-50 border-2 border-red-300 p-2">
            <p className="font-doodle text-xs text-red-600 text-center">
              {t("saleProductCard.outOfStock")}
            </p>
          </div>
        ) : (
          <button
            onClick={handleAddToCart}
            className="w-full doodle-button doodle-button-primary flex items-center justify-center gap-2"
          >
            <ShoppingCart className="w-4 h-4" />
            <span>{t("saleProductCard.addToCart")}</span>
          </button>
        )}
      </div>
    </Link>
  );
};

export default SaleProductModelCard;
