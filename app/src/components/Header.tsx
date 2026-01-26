import React from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import {
  ShoppingCart,
  Menu,
  X,
  Bike,
  User,
  LogOut,
  ChevronDown,
  Search,
  Globe,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCart } from "@/context/CartContext";
import { useAuth } from "@/context/AuthContext";
import { useCategories } from "@/hooks/useProducts";
import { useLanguage } from "@/context/LanguageContext";
import { useCurrency } from "@/context/CurrencyContext";
import { useUnitMeasure } from "@/context/UnitMeasureContext";
import { getUnitSystemForLanguage } from "@/lib/unitMeasureUtils";
import SearchBar from "@/components/SearchBar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Twemoji } from "@/components/Twemoji";

const Header: React.FC = () => {
  const { t, i18n } = useTranslation("common");
  const { getTotalItems } = useCart();
  const { user, isAuthenticated, logout } = useAuth();
  const { data: categories = [], isLoading: categoriesLoading } =
    useCategories();
  const { selectedLanguage, setSelectedLanguage, languages } = useLanguage();
  const { setSelectedCurrency, getCurrencyForLanguage } = useCurrency();
  const { setUnitSystem } = useUnitMeasure();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const [showSearch, setShowSearch] = React.useState(false);
  const totalItems = getTotalItems();

  const userMenuRef = React.useRef<HTMLDivElement>(null);
  const currentLanguage =
    languages.find((l) => l.code === selectedLanguage) || languages[0];

  const handleLanguageChange = (code: string) => {
    setSelectedLanguage(code);
    i18n.changeLanguage(code);
    // Automatically change currency based on language
    const newCurrency = getCurrencyForLanguage(code);
    setSelectedCurrency(newCurrency);
    // Automatically change unit system based on language
    const newUnitSystem = getUnitSystemForLanguage(code);
    setUnitSystem(newUnitSystem);
  };

  const handleSearch = (query: string) => {
    navigate(`/search?q=${encodeURIComponent(query)}`);
    setShowSearch(false);
  };

  // Close user menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="sticky top-0 z-50 bg-doodle-bg border-b-4 border-doodle-text">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 group">
            <div className="doodle-border-light p-1.5 group-hover:rotate-6 transition-transform">
              <Bike className="w-6 h-6 md:w-8 md:h-8 text-doodle-text" />
            </div>
            <span className="font-doodle text-lg md:text-2xl font-bold text-doodle-text">
              Adventure<span className="text-doodle-accent">Works</span>
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-6">
            {categoriesLoading ? (
              // Loading skeleton for categories
              <>
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="h-4 w-20 bg-doodle-text/10 animate-pulse"
                  ></div>
                ))}
                <div className="h-4 w-16 bg-doodle-accent/20 animate-pulse"></div>
              </>
            ) : (
              <>
                {categories.map((category) => (
                  <Link
                    key={category.ProductCategoryID}
                    to={`/category/${category.ProductCategoryID}`}
                    className={`font-doodle text-doodle-text hover:text-doodle-accent transition-colors ${
                      location.pathname ===
                      `/category/${category.ProductCategoryID}`
                        ? "squiggle"
                        : ""
                    }`}
                    data-testid={`category-link-${category.ProductCategoryID}`}
                  >
                    {category.Name}
                  </Link>
                ))}
                <Link
                  to="/sale"
                  className={`font-doodle text-doodle-accent font-bold hover:text-doodle-green transition-colors flex items-center gap-1 ${
                    location.pathname === "/sale" ? "squiggle" : ""
                  }`}
                >
                  <Twemoji emoji="🏷️" size="1rem" /> Sale
                </Link>
              </>
            )}
          </nav>

          {/* Right Side: Search + Auth + Cart + Mobile Menu */}
          <div className="flex items-center gap-2 md:gap-3">
            {/* Search Button */}
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="doodle-button p-2"
              aria-label={t("headerAria.search")}
              data-testid="search-toggle-button"
            >
              <Search className="w-5 h-5" />
            </button>

            {/* Auth Section */}
            {/* Auth Section */}
            {isAuthenticated && user ? (
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                  className="doodle-button flex items-center gap-2 py-2 px-3"
                >
                  <div className="w-6 h-6 rounded-full bg-doodle-accent flex items-center justify-center">
                    <span className="text-white text-xs font-bold">
                      {user.firstName[0]}
                      {user.lastName[0]}
                    </span>
                  </div>
                  <span className="hidden sm:inline font-doodle text-sm">
                    {user.firstName}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${
                      userMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {/* Dropdown Menu */}
                {userMenuOpen && (
                  <div className="absolute right-0 mt-2 w-48 doodle-card p-2 z-50">
                    <div className="px-3 py-2 border-b-2 border-dashed border-doodle-text/20 mb-2">
                      <p className="font-doodle font-bold text-doodle-text">
                        {user.firstName} {user.lastName}
                      </p>
                      <p className="font-doodle text-xs text-doodle-text/60 truncate">
                        {user.email}
                      </p>
                    </div>
                    <Link
                      to="/account"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 font-doodle text-doodle-text hover:bg-doodle-text/10 transition-colors"
                    >
                      <User className="w-4 h-4" />
                      {t("header.myAccount")}
                    </Link>
                    <button
                      onClick={() => {
                        logout();
                        setUserMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 font-doodle text-doodle-accent hover:bg-doodle-text/10 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      {t("header.signOut")}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Link
                to="/auth"
                className="doodle-button flex items-center gap-2 py-2 px-3"
              >
                <User className="w-5 h-5" />
                <span className="hidden sm:inline font-doodle">
                  {t("header.signIn")}
                </span>
              </Link>
            )}

            {/* Language Selector */}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="doodle-button flex items-center gap-2 py-2 px-3"
                data-testid="language-selector"
              >
                <Twemoji
                  emoji={currentLanguage.flag}
                  size="1.25rem"
                  className="inline-flex items-center"
                />
                <Globe className="w-4 h-4 hidden sm:block" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-48 bg-doodle-bg border-2 border-doodle-text"
              >
                {languages.map((lang) => (
                  <DropdownMenuItem
                    key={lang.code}
                    onClick={() => handleLanguageChange(lang.code)}
                    className={`flex items-center gap-2 cursor-pointer font-doodle ${
                      selectedLanguage === lang.code
                        ? "bg-doodle-accent/20"
                        : ""
                    }`}
                    data-testid={`language-option-${lang.code}`}
                  >
                    <Twemoji
                      emoji={lang.flag}
                      size="1.25rem"
                      className="inline-flex items-center flex-shrink-0"
                    />
                    <span>{lang.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Cart */}
            <Link
              to="/cart"
              className="doodle-button relative flex items-center gap-2 py-2 px-3"
              data-testid="cart-link"
            >
              <ShoppingCart className="w-5 h-5" />
              <span className="hidden sm:inline font-doodle">
                {t("header.cart")}
              </span>
              {totalItems > 0 && (
                <span
                  className="absolute -top-2 -right-2 bg-doodle-accent text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-doodle-text"
                  data-testid="cart-count"
                >
                  {totalItems}
                </span>
              )}
            </Link>

            {/* Mobile Menu Button */}
            <button
              className="md:hidden doodle-button p-2"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={t("headerAria.toggleMenu")}
            >
              {mobileMenuOpen ? (
                <X className="w-5 h-5" />
              ) : (
                <Menu className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <nav className="md:hidden py-4 border-t-2 border-doodle-text border-dashed">
            <div className="flex flex-col gap-3">
              {categoriesLoading ? (
                // Loading skeleton for mobile menu
                <>
                  {[...Array(4)].map((_, i) => (
                    <div
                      key={i}
                      className="h-6 w-32 bg-doodle-text/10 animate-pulse"
                    ></div>
                  ))}
                  <div className="h-6 w-24 bg-doodle-accent/20 animate-pulse"></div>
                </>
              ) : (
                <>
                  {categories.map((category) => (
                    <Link
                      key={category.ProductCategoryID}
                      to={`/category/${category.ProductCategoryID}`}
                      className="font-doodle text-lg text-doodle-text hover:text-doodle-accent py-2"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      * {category.Name}
                    </Link>
                  ))}
                  <Link
                    to="/sale"
                    className="font-doodle text-lg text-doodle-accent font-bold hover:text-doodle-green py-2 flex items-center gap-2"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    * <Twemoji emoji="🏷️" size="1.25rem" /> Sale
                  </Link>
                </>
              )}
              {!isAuthenticated && (
                <Link
                  to="/auth"
                  className="font-doodle text-lg text-doodle-accent hover:text-doodle-green py-2"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  * Sign In / Create Account
                </Link>
              )}
            </div>
          </nav>
        )}

        {/* Expandable Search Bar with AI Suggestions */}
        {showSearch && (
          <div className="py-3 border-t-2 border-doodle-text border-dashed">
            <div className="flex gap-2">
              <SearchBar
                placeholder={t("header.aiSearchPlaceholder")}
                onSearch={handleSearch}
                autoFocus
                showButton
                className="flex-1"
                inputClassName="py-2 border-doodle-accent"
              />
              <button
                type="button"
                onClick={() => setShowSearch(false)}
                className="doodle-button p-2"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
