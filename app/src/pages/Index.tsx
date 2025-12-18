import React from "react";
import { useTranslation } from "react-i18next";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import HeroSection from "@/components/HeroSection";
import PromoBanner from "@/components/PromoBanner";
import CategoryGrid from "@/components/CategoryGrid";
import FeaturedProducts from "@/components/FeaturedProducts";

const Index: React.FC = () => {
  const { t } = useTranslation("common");

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <HeroSection />
        <PromoBanner />
        <CategoryGrid />
        <FeaturedProducts />

        {/* Newsletter Section */}
        <section className="py-12">
          <div className="container mx-auto px-4">
            <div className="doodle-card max-w-2xl mx-auto p-8 text-center">
              <span className="text-4xl mb-4 block">✉️</span>
              <h2 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text mb-2">
                {t("newsletter.title")}
              </h2>
              <p className="font-doodle text-doodle-text/70 mb-6">
                {t("newsletter.description")}
              </p>
              <form className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
                <input
                  type="email"
                  placeholder={t("newsletter.emailPlaceholder")}
                  className="doodle-input flex-1"
                />
                <button
                  type="submit"
                  className="doodle-button doodle-button-accent"
                >
                  {t("newsletter.subscribe")}
                </button>
              </form>
              <p className="font-doodle text-xs text-doodle-text/50 mt-4">
                {t("newsletter.disclaimer")}
              </p>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default Index;
