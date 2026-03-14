import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Sparkles } from "lucide-react";
import { useProducts } from "@/hooks/useProducts";
import { Twemoji } from "@/components/Twemoji";
import { useCurrency } from "@/context/CurrencyContext";

const HeroSection: React.FC = () => {
  const { t } = useTranslation("common");
  const { formatPrice } = useCurrency();
  const { data: products = [] } = useProducts();
  // Convert $50 threshold to local currency to match checkout logic
  const shippingThresholdDisplay = formatPrice(50);

  // Calculate available products count (in stock and for sale)
  const availableProductsCount = useMemo(() => {
    const inStockProducts = products.filter((p) => p.inStock);
    // Round down to nearest 10
    const roundedCount = Math.floor(inStockProducts.length / 10) * 10;
    return roundedCount;
  }, [products]);
  return (
    <section className="relative overflow-hidden py-12 md:py-20">
      {/* Decorative Elements */}
      <div className="absolute top-10 left-10 opacity-20 animate-float">
        <Twemoji emoji="✨" size="4rem" />
      </div>
      <div
        className="absolute bottom-10 right-10 opacity-20 animate-float"
        style={{ animationDelay: "1s" }}
      >
        <Twemoji emoji="🚴" size="4rem" />
      </div>
      <div
        className="absolute top-1/2 left-1/4 opacity-10 animate-float"
        style={{ animationDelay: "0.5s" }}
      >
        <Twemoji emoji="⭐" size="2.5rem" />
      </div>
      <div
        className="absolute top-1/3 right-1/4 text-4xl opacity-10 animate-float"
        style={{ animationDelay: "1.5s" }}
      >
        🏔️
      </div>

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 doodle-border-light px-4 py-2 mb-6 bg-doodle-bg">
            <Sparkles className="w-4 h-4 text-doodle-accent" />
            <span className="font-doodle text-sm text-doodle-text">
              {t("hero.badge")}
            </span>
          </div>

          {/* Main Heading */}
          <h1 className="font-doodle text-4xl md:text-6xl lg:text-7xl font-bold text-doodle-text mb-6 leading-tight">
            {t("hero.title")}{" "}
            <span className="relative inline-block">
              <span className="text-doodle-accent">
                {t("hero.titleHighlight")}
              </span>
              <svg
                className="absolute -bottom-2 left-0 w-full"
                viewBox="0 0 200 12"
                fill="none"
              >
                <path
                  d="M2 8C20 4 40 6 60 5C80 4 100 7 120 6C140 5 160 8 180 6C190 5 195 6 198 7"
                  stroke="#FF5E5B"
                  strokeWidth="3"
                  strokeLinecap="round"
                  className="opacity-60"
                />
              </svg>
            </span>
          </h1>

          {/* Subtitle */}
          <p className="font-doodle text-lg md:text-xl text-doodle-text/80 mb-8 max-w-2xl mx-auto">
            {t("hero.subtitle")}
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/category/1"
              className="doodle-button doodle-button-primary text-lg px-8 py-3 inline-flex items-center justify-center gap-2"
            >
              {t("hero.shopBikes")}
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              to="/category/4"
              className="doodle-button text-lg px-8 py-3 inline-flex items-center justify-center gap-2"
            >
              {t("hero.browseAccessories")}
            </Link>
          </div>

          {/* Trust Badges */}
          <div className="mt-12 flex flex-wrap justify-center gap-6 md:gap-10">
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">
                {availableProductsCount > 0
                  ? `${availableProductsCount}+`
                  : "500+"}
              </div>
              <div className="font-doodle text-sm text-doodle-text/60">
                {t("hero.products")}
              </div>
            </div>
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">
                {t("hero.freeShipping")}
              </div>
              <div className="font-doodle text-sm text-doodle-text/60">
                {t("hero.shippingThreshold", { threshold: shippingThresholdDisplay })}
              </div>
            </div>
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">
                {t("hero.returns")}
              </div>
              <div className="font-doodle text-sm text-doodle-text/60">
                {t("hero.returnsLabel")}
              </div>
            </div>
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">
                {t("hero.support")}
              </div>
              <div className="font-doodle text-sm text-doodle-text/60">
                {t("hero.supportLabel")}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
