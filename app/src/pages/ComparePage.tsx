import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  X,
  Star,
  ShoppingCart,
  Scale,
  Plus,
  Trophy,
  TrendingDown,
  Sparkles,
} from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useCompare } from "@/context/CompareContext";
import { useCart } from "@/context/CartContext";
import { useReviews } from "@/hooks/useReviews";
import { getSalePrice, Product } from "@/types/product";

const CompareProductReview: React.FC<{
  productId: number;
  isBest?: boolean;
}> = ({ productId, isBest }) => {
  const { t } = useTranslation("common");
  const { averageRating, reviewCount } = useReviews(productId);

  return (
    <div
      className={`flex flex-col items-center gap-1 p-2 rounded-lg transition-colors ${
        isBest ? "bg-doodle-green/10 ring-2 ring-doodle-green ring-dashed" : ""
      }`}
    >
      {isBest && (
        <div className="flex items-center gap-1 text-doodle-green font-doodle text-xs font-bold mb-1">
          <Trophy className="w-3 h-3" />
          {t("compare.bestRated")}
        </div>
      )}
      <div className="flex items-center gap-0.5">
        {[...Array(5)].map((_, i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${
              i < Math.round(averageRating)
                ? isBest
                  ? "text-doodle-green fill-current"
                  : "text-doodle-accent fill-current"
                : "text-doodle-text/20"
            }`}
          />
        ))}
      </div>
      <span
        className={`font-doodle text-sm ${
          isBest ? "text-doodle-green font-bold" : "text-doodle-text/70"
        }`}
      >
        {averageRating.toFixed(1)} ({reviewCount} {t("compare.reviews")})
      </span>
    </div>
  );
};

// Helper to check if values differ across products
const hasDifference = (
  items: Product[],
  getValue: (p: Product) => string | number | null | undefined
): boolean => {
  if (items.length < 2) return false;
  const values = items
    .map(getValue)
    .filter((v) => v !== null && v !== undefined && v !== "—");
  if (values.length < 2) return false;
  return new Set(values.map(String)).size > 1;
};

// Get the effective price for comparison
const getEffectivePrice = (product: Product): number => {
  const salePrice = getSalePrice(product);
  return salePrice ?? product.ListPrice;
};

const ComparePage: React.FC = () => {
  const { t } = useTranslation("common");
  const { items, removeFromCompare, clearCompare } = useCompare();
  const { addToCart } = useCart();

  // Calculate best values for highlighting
  const highlights = useMemo(() => {
    if (items.length < 2) return { lowestPriceId: null, lightestId: null };

    // Find lowest price
    const lowestPrice = Math.min(...items.map(getEffectivePrice));
    const lowestPriceId =
      items.find((p) => getEffectivePrice(p) === lowestPrice)?.ProductID ??
      null;

    // Find lightest weight (if applicable)
    const weights = items
      .filter((p) => p.Weight != null)
      .map((p) => ({ id: p.ProductID, weight: p.Weight! }));
    const lightestId =
      weights.length > 1
        ? weights.reduce((min, curr) => (curr.weight < min.weight ? curr : min))
            .id
        : null;

    return { lowestPriceId, lightestId };
  }, [items]);

  const specs = [
    {
      key: t("compare.price"),
      getValue: (p: Product) => p.ListPrice,
      render: (p: Product, isBest: boolean) => {
        const salePrice = getSalePrice(p);
        if (salePrice) {
          return (
            <div
              className={`flex flex-col items-center p-2 rounded-lg transition-colors ${
                isBest
                  ? "bg-doodle-green/10 ring-2 ring-doodle-green ring-dashed"
                  : ""
              }`}
            >
              {isBest && (
                <div className="flex items-center gap-1 text-doodle-green font-doodle text-xs font-bold mb-1">
                  <TrendingDown className="w-3 h-3" />
                  {t("compare.bestPrice")}
                </div>
              )}
              <span className="font-doodle text-sm text-doodle-text/50 line-through">
                ${p.ListPrice.toFixed(2)}
              </span>
              <span
                className={`font-doodle text-xl font-bold ${
                  isBest ? "text-doodle-green" : "text-doodle-accent"
                }`}
              >
                ${salePrice.toFixed(2)}
              </span>
              <span className="font-doodle text-xs text-doodle-green font-bold">
                {t("compare.save")} {Math.round((p.DiscountPct || 0) * 100)}%
              </span>
            </div>
          );
        }
        return (
          <div
            className={`p-2 rounded-lg transition-colors ${
              isBest
                ? "bg-doodle-green/10 ring-2 ring-doodle-green ring-dashed"
                : ""
            }`}
          >
            {isBest && (
              <div className="flex items-center justify-center gap-1 text-doodle-green font-doodle text-xs font-bold mb-1">
                <TrendingDown className="w-3 h-3" />
                {t("compare.bestPrice")}
              </div>
            )}
            <span
              className={`font-doodle text-xl font-bold ${
                isBest ? "text-doodle-green" : "text-doodle-green"
              }`}
            >
              ${p.ListPrice.toFixed(2)}
            </span>
          </div>
        );
      },
    },
    { key: t("compare.color"), getValue: (p: Product) => p.Color || "—" },
    { key: t("compare.size"), getValue: (p: Product) => p.Size || "—" },
    {
      key: t("compare.weight"),
      getValue: (p: Product) => p.Weight ?? null,
      render: (p: Product, isBest: boolean) => {
        if (!p.Weight) return <span className="text-doodle-text/50">—</span>;
        return (
          <div
            className={`inline-flex flex-col items-center p-2 rounded-lg transition-colors ${
              isBest
                ? "bg-doodle-green/10 ring-2 ring-doodle-green ring-dashed"
                : ""
            }`}
          >
            {isBest && (
              <div className="flex items-center gap-1 text-doodle-green font-doodle text-xs font-bold mb-1">
                <Sparkles className="w-3 h-3" />
                {t("compare.lightest")}
              </div>
            )}
            <span
              className={`font-doodle ${
                isBest ? "text-doodle-green font-bold" : ""
              }`}
            >
              {p.Weight} {t("compare.lbs")}
            </span>
          </div>
        );
      },
    },
    {
      key: t("compare.productNumber"),
      getValue: (p: Product) => p.ProductNumber,
    },
    {
      key: t("compare.availableSizes"),
      getValue: (p: Product) => p.availableSizes?.join(", ") || "—",
    },
    {
      key: t("compare.availableColors"),
      getValue: (p: Product) => p.availableColors?.join(", ") || "—",
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
                {t("compare.noProductsToCompare")}
              </h1>
              <p className="font-doodle text-doodle-text/70 mb-8">
                {t("compare.addProductsToCompare")}
              </p>
              <Link
                to="/"
                className="doodle-button doodle-button-primary inline-flex items-center gap-2"
              >
                <ArrowLeft className="w-4 h-4" />
                {t("compare.browseProducts")}
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
            {t("compare.backToShop")}
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <Scale className="w-8 h-8 text-doodle-accent" />
              <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text">
                {t("compare.compareProducts")}
              </h1>
            </div>
            <button onClick={clearCompare} className="doodle-button text-sm">
              {t("compare.clearAll")}
            </button>
          </div>

          <div className="doodle-card overflow-x-auto">
            <table className="w-full min-w-[600px]">
              {/* Product Headers */}
              <thead>
                <tr>
                  <th className="p-4 text-left font-doodle font-bold text-doodle-text border-b-2 border-dashed border-doodle-text/20 w-40">
                    {t("compare.product")}
                  </th>
                  {items.map((product) => (
                    <th
                      key={product.ProductID}
                      className="p-4 border-b-2 border-dashed border-doodle-text/20 relative"
                    >
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
                    <th
                      key={`empty-${i}`}
                      className="p-4 border-b-2 border-dashed border-doodle-text/20"
                    >
                      <Link
                        to="/"
                        className="flex flex-col items-center justify-center gap-3 py-8 border-2 border-dashed border-doodle-text/10 hover:border-doodle-accent/30 transition-colors"
                      >
                        <Plus className="w-8 h-8 text-doodle-text/30" />
                        <span className="font-doodle text-sm text-doodle-text/50">
                          {t("compare.addProduct")}
                        </span>
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {/* Reviews Row */}
                <tr className="bg-doodle-bg/50">
                  <td className="p-4 font-doodle font-bold text-doodle-text border-b border-dashed border-doodle-text/10">
                    <div className="flex items-center gap-2">
                      {t("compare.reviews")}
                      {items.length > 1 && (
                        <span className="text-xs font-normal text-doodle-accent">
                          ({t("compare.compared")})
                        </span>
                      )}
                    </div>
                  </td>
                  {items.map((product, idx) => {
                    // Determine best rating among items
                    const ratings = items.map((p) => {
                      const { averageRating } = useReviews(p.ProductID);
                      return { id: p.ProductID, rating: averageRating };
                    });
                    const bestRating = Math.max(
                      ...ratings.map((r) => r.rating)
                    );
                    const isBest =
                      items.length > 1 &&
                      ratings.find((r) => r.id === product.ProductID)
                        ?.rating === bestRating;

                    return (
                      <td
                        key={product.ProductID}
                        className="p-4 text-center border-b border-dashed border-doodle-text/10"
                      >
                        <CompareProductReview
                          productId={product.ProductID}
                          isBest={isBest}
                        />
                      </td>
                    );
                  })}
                  {Array.from({ length: 3 - items.length }).map((_, i) => (
                    <td
                      key={`empty-${i}`}
                      className="p-4 border-b border-dashed border-doodle-text/10"
                    />
                  ))}
                </tr>

                {/* Spec Rows */}
                {specs.map((spec) => {
                  const isDifferent = hasDifference(
                    items,
                    spec.getValue as (
                      p: Product
                    ) => string | number | null | undefined
                  );

                  return (
                    <tr
                      key={spec.key}
                      className={isDifferent ? "bg-doodle-accent/5" : ""}
                    >
                      <td className="p-4 font-doodle font-bold text-doodle-text border-b border-dashed border-doodle-text/10">
                        <div className="flex items-center gap-2">
                          {spec.key}
                          {isDifferent && (
                            <span className="inline-flex items-center gap-1 text-xs font-normal text-doodle-accent bg-doodle-accent/10 px-2 py-0.5 rounded-full">
                              <Sparkles className="w-3 h-3" />
                              {t("compare.differs")}
                            </span>
                          )}
                        </div>
                      </td>
                      {items.map((product) => {
                        const isBestPrice =
                          spec.key === t("compare.price") &&
                          product.ProductID === highlights.lowestPriceId;
                        const isLightest =
                          spec.key === t("compare.weight") &&
                          product.ProductID === highlights.lightestId;
                        const isBest = isBestPrice || isLightest;

                        return (
                          <td
                            key={product.ProductID}
                            className="p-4 text-center border-b border-dashed border-doodle-text/10"
                          >
                            {spec.render ? (
                              spec.render(product, isBest)
                            ) : (
                              <span
                                className={`font-doodle ${
                                  isDifferent
                                    ? "font-semibold text-doodle-text"
                                    : "text-doodle-text"
                                }`}
                              >
                                {spec.getValue(product)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      {Array.from({ length: 3 - items.length }).map((_, i) => (
                        <td
                          key={`empty-${i}`}
                          className="p-4 border-b border-dashed border-doodle-text/10"
                        />
                      ))}
                    </tr>
                  );
                })}

                {/* Description Row */}
                <tr>
                  <td className="p-4 font-doodle font-bold text-doodle-text border-b border-dashed border-doodle-text/10">
                    {t("compare.description")}
                  </td>
                  {items.map((product) => (
                    <td
                      key={product.ProductID}
                      className="p-4 text-center border-b border-dashed border-doodle-text/10"
                    >
                      <p className="font-doodle text-sm text-doodle-text/70 line-clamp-4">
                        {product.Description ||
                          t("compare.noDescriptionAvailable")}
                      </p>
                    </td>
                  ))}
                  {Array.from({ length: 3 - items.length }).map((_, i) => (
                    <td
                      key={`empty-${i}`}
                      className="p-4 border-b border-dashed border-doodle-text/10"
                    />
                  ))}
                </tr>

                {/* Add to Cart Row */}
                <tr>
                  <td className="p-4 font-doodle font-bold text-doodle-text">
                    {t("compare.action")}
                  </td>
                  {items.map((product) => (
                    <td key={product.ProductID} className="p-4 text-center">
                      <button
                        onClick={() => addToCart(product)}
                        className="doodle-button doodle-button-primary flex items-center gap-2 mx-auto"
                      >
                        <ShoppingCart className="w-4 h-4" />
                        {t("compare.addToCart")}
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
