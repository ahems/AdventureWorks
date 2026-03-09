import React from "react";
import { Link } from "react-router-dom";
import { Bike, Mail, MapPin, Phone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCategories } from "@/hooks/useProducts";
import { useLanguage } from "@/context/LanguageContext";
import { TwemojiText } from "@/components/TwemojiText";

const Footer: React.FC = () => {
  const { t } = useTranslation("footer");
  const { selectedLanguage } = useLanguage();
  const { data: categories = [] } = useCategories(selectedLanguage);

  return (
    <footer className="bg-doodle-text text-doodle-bg mt-16">
      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="space-y-4">
            <Link to="/" className="flex items-center gap-2">
              <div className="bg-doodle-bg p-1.5 border-2 border-doodle-bg">
                <Bike className="w-6 h-6 text-doodle-text" />
              </div>
              <span className="font-doodle text-xl font-bold">
                Adventure<span className="text-doodle-accent">Works</span>
              </span>
            </Link>
            <p className="font-doodle text-sm opacity-80">{t("tagline")}</p>
          </div>

          {/* Categories */}
          <div>
            <h3 className="font-doodle text-lg font-bold mb-4 text-doodle-accent">
              {t("shop")}
            </h3>
            <ul className="space-y-2">
              {categories.map((category) => (
                <li key={category.ProductCategoryID}>
                  <Link
                    to={`/category/${category.ProductCategoryID}`}
                    className="font-doodle text-sm opacity-80 hover:opacity-100 hover:text-doodle-accent transition-colors"
                  >
                    * {category.Name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Quick Links */}
          <div>
            <h3 className="font-doodle text-lg font-bold mb-4 text-doodle-accent">
              {t("quickLinks")}
            </h3>
            <ul className="space-y-2">
              <li>
                <Link
                  to="/cart"
                  className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors"
                >
                  * {t("shoppingCart")}
                </Link>
              </li>
              <li>
                <Link
                  to="/order-tracking"
                  className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors"
                >
                  * {t("trackOrder")}
                </Link>
              </li>
              <li>
                <Link
                  to="/returns"
                  className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors"
                >
                  * {t("returnsPolicy")}
                </Link>
              </li>
              <li>
                <Link
                  to="/faq"
                  className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors"
                >
                  * {t("faq")}
                </Link>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="font-doodle text-lg font-bold mb-4 text-doodle-accent">
              {t("contactUs")}
            </h3>
            <ul className="space-y-3">
              <li className="flex items-start gap-2">
                <MapPin className="w-4 h-4 mt-1 flex-shrink-0" />
                <span className="font-doodle text-sm opacity-80">
                  {t("address")}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Phone className="w-4 h-4 flex-shrink-0" />
                <span className="font-doodle text-sm opacity-80">
                  {t("phone")}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Mail className="w-4 h-4 flex-shrink-0" />
                <span className="font-doodle text-sm opacity-80">
                  {t("email")}
                </span>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-6 border-t-2 border-dashed border-doodle-bg/30">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="font-doodle text-sm opacity-60">
              {t("copyright", { year: new Date().getFullYear() })}
            </p>
            <div className="flex items-center gap-4">
              <Link
                to="/health"
                className="font-doodle text-xs opacity-40 hover:opacity-100 transition-opacity"
                title="System Health Check"
              >
                Health
              </Link>
              <p className="font-doodle text-sm opacity-60">
                <TwemojiText text={t("builtWith")} size="0.875rem" />
              </p>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
