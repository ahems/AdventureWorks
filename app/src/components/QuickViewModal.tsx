import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  X,
  ShoppingCart,
  Heart,
  Star,
  Scale,
  Eye,
  Plus,
  Minus,
} from "lucide-react";
import { Twemoji } from "@/components/Twemoji";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Product, getSalePrice, isVariantAvailable } from "@/types/product";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { useCompare } from "@/context/CompareContext";
import { useReviews } from "@/hooks/useReviews";
import { useTranslation } from "react-i18next";

interface QuickViewModalProps {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const QuickViewModal: React.FC<QuickViewModalProps> = ({
  product,
  open,
  onOpenChange,
}) => {
  const { addToCart } = useCart();
  const { addToWishlist, removeFromWishlist, isInWishlist } = useWishlist();
  const { addToCompare, removeFromCompare, isInCompare } = useCompare();
  const { averageRating, reviewCount } = useReviews(product.ProductID);
  const { t } = useTranslation("common");

  const [selectedSize, setSelectedSize] = useState<string | undefined>(
    product.availableSizes?.[0]
  );
  const [selectedColor, setSelectedColor] = useState<string | undefined>(
    product.availableColors?.[0]
  );
  const [quantity, setQuantity] = useState(1);

  const inWishlist = isInWishlist(product.ProductID);
  const inCompare = isInCompare(product.ProductID);
  const salePrice = getSalePrice(product);
  const currentPrice = salePrice || product.ListPrice;

  const variantAvailable = isVariantAvailable(
    product,
    selectedSize,
    selectedColor
  );

  const handleAddToCart = () => {
    if (!product.inStock || !variantAvailable) return;
    addToCart(product, quantity, selectedSize, selectedColor);
    onOpenChange(false);
  };

  const handleToggleWishlist = () => {
    if (inWishlist) {
      removeFromWishlist(product.ProductID);
    } else {
      addToWishlist(product);
    }
  };

  const handleToggleCompare = () => {
    if (inCompare) {
      removeFromCompare(product.ProductID);
    } else {
      addToCompare(product);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden bg-doodle-bg border-4 border-doodle-text">
        <DialogTitle className="sr-only">
          {product.Name} - {t("quickViewModal.quickView")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t("quickViewModal.viewProductDetails")}
        </DialogDescription>

        <div className="grid grid-cols-1 md:grid-cols-2">
          {/* Product Image */}
          <div className="relative bg-doodle-bg border-b-4 md:border-b-0 md:border-r-4 border-doodle-text p-8 flex items-center justify-center">
            {/* Sale Badge */}
            {product.DiscountPct && (
              <div className="absolute top-4 left-4 z-10 bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text rotate-[-3deg]">
                {product.SpecialOfferDescription ||
                  `${Math.round((product.DiscountPct || 0) * 100)}${t(
                    "quickViewModal.percentOff"
                  )}`}
              </div>
            )}

            {/* Stock Badge */}
            {!product.inStock && (
              <div className="absolute bottom-4 left-4 z-10 bg-red-500 text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text">
                {t("quickViewModal.outOfStock")}
              </div>
            )}

            {product.LargePhoto || product.ThumbNailPhoto ? (
              <img
                src={`data:image/gif;base64,${
                  product.LargePhoto || product.ThumbNailPhoto
                }`}
                alt={product.Name}
                className="max-w-full max-h-96 object-contain"
              />
            ) : (
              <div className="text-center">
                <span className="font-doodle text-8xl">🚴</span>
                <p className="font-doodle text-sm text-doodle-text/60 mt-4">
                  {product.Color || t("quickViewModal.productImage")}
                </p>
              </div>
            )}
          </div>

          {/* Product Details */}
          <div className="p-6 space-y-4">
            <div>
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-2">
                {product.Name}
              </h2>

              {/* Star Rating */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`w-4 h-4 ${
                        i < Math.round(averageRating)
                          ? "text-doodle-accent fill-current"
                          : "text-doodle-text/20"
                      }`}
                    />
                  ))}
                </div>
                <span className="font-doodle text-sm text-doodle-text/70">
                  {averageRating.toFixed(1)} ({reviewCount}{" "}
                  {t("quickViewModal.reviews")})
                </span>
              </div>
            </div>

            {/* Price */}
            <div className="flex items-center gap-3">
              {salePrice ? (
                <>
                  <span className="font-doodle text-2xl font-bold text-doodle-accent">
                    ${salePrice.toFixed(2)}
                  </span>
                  <span className="font-doodle text-lg text-doodle-text/50 line-through">
                    ${product.ListPrice.toFixed(2)}
                  </span>
                  <span className="font-doodle text-sm font-bold text-doodle-green">
                    {t("quickViewModal.save")}{" "}
                    {Math.round((product.DiscountPct || 0) * 100)}%
                  </span>
                </>
              ) : (
                <span className="font-doodle text-2xl font-bold text-doodle-green">
                  ${product.ListPrice.toFixed(2)}
                </span>
              )}
            </div>

            {/* Stock Status */}
            <div
              className={`p-2 border-2 ${
                product.inStock
                  ? "bg-green-50 border-green-300"
                  : "bg-red-50 border-red-300"
              }`}
            >
              <div className="flex items-center gap-2">
                <Twemoji emoji={product.inStock ? "✅" : "❌"} size="1.25rem" />
                <div>
                  <span
                    className={`font-doodle text-sm font-bold ${
                      product.inStock ? "text-green-700" : "text-red-700"
                    }`}
                  >
                    {product.inStock
                      ? t("quickViewModal.inStock")
                      : t("quickViewModal.outOfStock")}
                  </span>
                  {product.quantityAvailable !== undefined &&
                    product.inStock && (
                      <span className="font-doodle text-xs text-doodle-text/70 ml-2">
                        ({product.quantityAvailable}{" "}
                        {t("quickViewModal.available")})
                      </span>
                    )}
                </div>
              </div>
            </div>

            {/* Description */}
            {product.Description && (
              <p className="font-doodle text-sm text-doodle-text/70 line-clamp-3">
                {product.Description}
              </p>
            )}

            {/* Size Selection */}
            {product.availableSizes && product.availableSizes.length > 0 && (
              <div>
                <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
                  {t("quickViewModal.size")}
                </label>
                <select
                  value={selectedSize}
                  onChange={(e) => setSelectedSize(e.target.value)}
                  className="doodle-input w-full"
                >
                  {product.availableSizes.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Color Selection */}
            {product.availableColors && product.availableColors.length > 0 && (
              <div>
                <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
                  {t("quickViewModal.color")}
                </label>
                <select
                  value={selectedColor}
                  onChange={(e) => setSelectedColor(e.target.value)}
                  className="doodle-input w-full"
                >
                  {product.availableColors.map((color) => (
                    <option key={color} value={color}>
                      {color}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Variant Unavailable Warning */}
            {!variantAvailable && (
              <div className="p-3 bg-doodle-accent/10 border-2 border-dashed border-doodle-accent">
                <p className="font-doodle text-sm text-doodle-accent font-bold">
                  {t("quickViewModal.combinationUnavailable")}
                </p>
              </div>
            )}

            {/* Quantity */}
            <div>
              <label className="font-doodle text-sm font-bold text-doodle-text block mb-2">
                {t("quickViewModal.quantity")}
              </label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="doodle-button p-2"
                  disabled={quantity <= 1}
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="font-doodle text-lg font-bold w-12 text-center">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity(quantity + 1)}
                  className="doodle-button p-2"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-2">
              <button
                onClick={handleAddToCart}
                disabled={!product.inStock || !variantAvailable}
                className="doodle-button doodle-button-primary flex-1 py-3 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ShoppingCart className="w-5 h-5" />
                {!product.inStock
                  ? t("quickViewModal.outOfStock")
                  : variantAvailable
                  ? t("quickViewModal.addToCart")
                  : t("quickViewModal.unavailable")}
              </button>
              <button
                onClick={handleToggleWishlist}
                className={`doodle-button p-3 ${
                  inWishlist
                    ? "bg-doodle-accent text-white border-doodle-accent"
                    : ""
                }`}
                aria-label={
                  inWishlist
                    ? t("quickViewModal.removeFromWishlist")
                    : t("quickViewModal.addToWishlist")
                }
              >
                <Heart
                  className={`w-5 h-5 ${inWishlist ? "fill-current" : ""}`}
                />
              </button>
              <button
                onClick={handleToggleCompare}
                className={`doodle-button p-3 ${
                  inCompare
                    ? "bg-doodle-green text-white border-doodle-green"
                    : ""
                }`}
                aria-label={
                  inCompare
                    ? t("quickViewModal.removeFromComparison")
                    : t("quickViewModal.addToComparison")
                }
              >
                <Scale className="w-5 h-5" />
              </button>
            </div>

            {/* View Full Details Link */}
            <Link
              to={`/product/${product.ProductID}`}
              className="font-doodle text-sm text-doodle-accent hover:underline flex items-center gap-1 justify-center"
              onClick={() => onOpenChange(false)}
            >
              <Eye className="w-4 h-4" />
              {t("quickViewModal.viewFullDetails")}
            </Link>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuickViewModal;
