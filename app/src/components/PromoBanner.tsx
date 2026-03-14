import React from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Sparkles } from "lucide-react";
import { useSaleProducts } from "@/hooks/useProducts";
import { useLanguage } from "@/context/LanguageContext";
import { Twemoji } from "@/components/Twemoji";
import { useProductNames } from "@/context/ProductNamesContext";

const PromoBanner: React.FC = () => {
  const { t } = useTranslation("common");
  const { selectedLanguage } = useLanguage();
  const { data: saleProducts = [], isLoading } =
    useSaleProducts(selectedLanguage);
  const { getLocalizedName } = useProductNames();
  const maxDiscount = Math.max(
    ...saleProducts.map((p) => {
      // Convert DiscountPct (decimal) to percentage
      return p.DiscountPct ? Math.round(p.DiscountPct * 100) : 0;
    }),
    0
  );

  if (isLoading) {
    return (
      <section className="relative overflow-hidden bg-doodle-accent">
        <div className="container mx-auto px-4 py-6 md:py-8 relative">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            {/* Left: Message Skeleton */}
            <div className="flex items-center gap-3">
              <div className="hidden sm:block w-12 h-12 bg-white/20 animate-pulse"></div>
              <div className="space-y-2">
                <div className="h-6 w-40 bg-white/20 animate-pulse"></div>
                <div className="h-4 w-48 bg-white/20 animate-pulse"></div>
              </div>
            </div>

            {/* Center: Count Skeleton */}
            <div className="hidden lg:flex flex-col items-center gap-1 border-l-2 border-r-2 border-white/20 px-6">
              <div className="h-8 w-12 bg-white/20 animate-pulse"></div>
              <div className="h-3 w-20 bg-white/20 animate-pulse"></div>
            </div>

            {/* Right: CTA Skeleton */}
            <div className="h-12 w-36 bg-white/20 animate-pulse"></div>
          </div>
        </div>
      </section>
    );
  }

  if (saleProducts.length === 0) return null;

  return (
    <section className="relative overflow-hidden bg-doodle-accent">
      {/* Animated background pattern */}
      <div className="absolute inset-0 opacity-10">
        <div
          className="absolute top-0 left-0 w-full h-full"
          style={{
            backgroundImage: `repeating-linear-gradient(
            45deg,
            transparent,
            transparent 20px,
            rgba(0,0,0,0.1) 20px,
            rgba(0,0,0,0.1) 40px
          )`,
          }}
        />
      </div>

      {/* Decorative elements */}
      <div
        className="absolute top-2 left-[10%] text-white/20 animate-bounce"
        style={{ animationDelay: "0s" }}
      >
        <Twemoji emoji="🏷️" size="2.5rem" className="opacity-20" />
      </div>
      <div
        className="absolute bottom-2 right-[15%] text-white/20 animate-bounce"
        style={{ animationDelay: "0.5s" }}
      >
        <Twemoji emoji="⭐" size="2rem" className="opacity-20" />
      </div>
      <div
        className="absolute top-4 right-[25%] text-white/20 animate-bounce"
        style={{ animationDelay: "1s" }}
      >
        <Twemoji emoji="🎉" size="1.5rem" className="opacity-20" />
      </div>

      <div className="container mx-auto px-4 py-6 md:py-8 relative">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-center md:text-left">
          {/* Left: Message */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center justify-center w-12 h-12 bg-white/20 border-2 border-white/30 rotate-3">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div>
              <h3 className="font-doodle text-xl md:text-2xl font-bold text-white">
                {t("promo.limitedSale")}
              </h3>
              <p className="font-doodle text-white/90 text-sm md:text-base">
                {t("promo.saveUpTo")}{" "}
                <span className="font-bold text-doodle-bg">
                  {maxDiscount}% {t("promo.offText")}
                </span>{" "}
                {t("promo.onSelectGear")}
              </p>
            </div>
          </div>

          {/* Center: Sale items count */}
          <div className="hidden lg:block font-doodle text-white/80 text-sm border-l-2 border-r-2 border-white/20 px-6">
            <span className="text-2xl font-bold text-white">
              {saleProducts.length}
            </span>
            <br />
            {t("promo.itemsOnSale")}
          </div>

          {/* Right: CTA */}
          <Link
            to="/sale"
            className="group inline-flex items-center gap-2 bg-white text-doodle-accent font-doodle font-bold px-6 py-3 border-2 border-doodle-text hover:bg-doodle-bg transition-all hover:rotate-1"
          >
            {t("promo.shopSaleNow")}
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Link>
        </div>

        {/* Scrolling ticker for mobile */}
        <div className="mt-4 md:mt-0 md:hidden overflow-hidden">
          <div className="flex gap-8 animate-marquee whitespace-nowrap font-doodle text-xs text-white/70">
            {saleProducts.map((product) => (
              <span key={product.ProductID} className="flex items-center gap-1">
                🏷️ {getLocalizedName(product.ProductID) ?? product.Name} -{" "}
                {Math.round((product.DiscountPct || 0) * 100)}% OFF
              </span>
            ))}
            {saleProducts.map((product) => (
              <span
                key={`dup-${product.ProductID}`}
                className="flex items-center gap-1"
              >
                🏷️ {getLocalizedName(product.ProductID) ?? product.Name} -{" "}
                {Math.round((product.DiscountPct || 0) * 100)}% OFF
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default PromoBanner;
