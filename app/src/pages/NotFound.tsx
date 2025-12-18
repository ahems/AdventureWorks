import { useLocation, Link } from "react-router-dom";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Home } from "lucide-react";

const NotFound = () => {
  const { t } = useTranslation("common");
  const location = useLocation();

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-doodle-bg">
      <div className="text-center max-w-md mx-auto px-4">
        <div className="doodle-card p-8 md:p-12">
          <span className="text-8xl block mb-6">🗺️</span>
          <h1 className="font-doodle text-5xl font-bold text-doodle-text mb-2">
            404
          </h1>
          <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-4">
            {t("notFound.title")}
          </h2>
          <p className="font-doodle text-doodle-text/70 mb-8">
            {t("notFound.description")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/"
              className="doodle-button doodle-button-primary inline-flex items-center justify-center gap-2"
            >
              <Home className="w-4 h-4" />
              {t("notFound.backToCamp")}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
