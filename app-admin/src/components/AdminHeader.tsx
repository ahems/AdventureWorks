import React, { createContext, useContext } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import {
  Menu,
  X,
  Bike,
  User,
  LogOut,
  ChevronDown,
  Search,
  Package,
  Users,
  ShoppingBag,
  Star,
  Sparkles,
  Tag,
  Globe,
  DollarSign,
  ChevronUp,
  Wrench,
  Mic,
  Bot,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { ThemeToggle } from "@/components/ThemeToggle";
import AppBreadcrumb from "@/components/AppBreadcrumb";

// Voice Assistant Context
interface VoiceAssistantContextType {
  isVoiceOpen: boolean;
  setIsVoiceOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const VoiceAssistantContext = createContext<VoiceAssistantContextType | null>(
  null,
);

export const useVoiceAssistant = () => {
  const context = useContext(VoiceAssistantContext);
  if (!context) {
    throw new Error(
      "useVoiceAssistant must be used within VoiceAssistantProvider",
    );
  }
  return context;
};

export const VoiceAssistantProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [isVoiceOpen, setIsVoiceOpen] = React.useState(false);
  return (
    <VoiceAssistantContext.Provider value={{ isVoiceOpen, setIsVoiceOpen }}>
      {children}
    </VoiceAssistantContext.Provider>
  );
};

const secondaryNavGroups = [
  {
    label: "Data",
    items: [
      { to: "/reviews", label: "Reviews", icon: Star },
      { to: "/promotions", label: "Promotions", icon: Tag },
      { to: "/cultures", label: "Cultures", icon: Globe },
      { to: "/currencies", label: "Currencies", icon: DollarSign },
    ],
  },
  {
    label: "AI",
    items: [
      { to: "/ai-features", label: "AI Showcase", icon: Sparkles },
      { to: "/stale-carts", label: "Cart Recovery", icon: Bot },
    ],
  },
];

const AdminHeader: React.FC = () => {
  const { user, isAuthenticated, logout } = useAuth();
  const voiceContext = React.useContext(VoiceAssistantContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [showSearch, setShowSearch] = React.useState(false);
  const [showSecondaryNav, setShowSecondaryNav] = React.useState(() => {
    const saved = localStorage.getItem("showSecondaryNav");
    return saved !== null ? saved === "true" : true;
  });

  const userMenuRef = React.useRef<HTMLDivElement>(null);

  // Persist secondary nav state
  React.useEffect(() => {
    localStorage.setItem("showSecondaryNav", String(showSecondaryNav));
  }, [showSecondaryNav]);

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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setSearchQuery("");
      setShowSearch(false);
    }
  };

  return (
    <header className="sticky top-0 z-50 bg-doodle-bg border-b-4 border-doodle-text">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 group">
            <div className="doodle-border-light p-1.5 group-hover:rotate-6 transition-transform">
              <Bike className="w-6 h-6 md:w-8 md:h-8 text-doodle-text" />
            </div>
            <div className="flex flex-col">
              <span className="font-doodle text-lg md:text-2xl font-bold text-doodle-text leading-tight">
                Adventure<span className="text-doodle-accent">Works</span>
              </span>
              <span className="font-doodle text-xs text-doodle-text/60 -mt-1">
                Admin Portal
              </span>
            </div>
          </Link>

          {/* Desktop Navigation - Only show when authenticated */}
          {isAuthenticated && (
            <nav className="hidden md:flex items-center gap-5">
              <Link
                to="/category/1"
                className={`font-doodle text-doodle-text hover:text-doodle-accent transition-colors flex items-center gap-1 ${location.pathname.startsWith("/category") || location.pathname.startsWith("/product") ? "squiggle" : ""}`}
              >
                <Package className="w-4 h-4" />
                Products
              </Link>
              <Link
                to="/customers"
                className={`font-doodle text-doodle-text hover:text-doodle-accent transition-colors flex items-center gap-1 ${location.pathname.startsWith("/customers") ? "squiggle" : ""}`}
              >
                <Users className="w-4 h-4" />
                Customers
              </Link>
              <Link
                to="/orders"
                className={`font-doodle text-doodle-text hover:text-doodle-accent transition-colors flex items-center gap-1 ${location.pathname.startsWith("/orders") ? "squiggle" : ""}`}
              >
                <ShoppingBag className="w-4 h-4" />
                Orders
              </Link>
              <Link
                to="/utilities"
                className={`font-doodle text-doodle-text hover:text-doodle-accent transition-colors flex items-center gap-1 ${location.pathname.startsWith("/utilities") ? "squiggle" : ""}`}
              >
                <Wrench className="w-4 h-4" />
                Utilities
              </Link>
            </nav>
          )}

          {/* Right Side */}
          <div className="flex items-center gap-2 md:gap-3">
            {/* Theme Toggle */}
            <ThemeToggle />

            {/* Voice Assistant Toggle - Only show when authenticated */}
            {isAuthenticated && voiceContext && (
              <button
                onClick={() =>
                  voiceContext.setIsVoiceOpen(!voiceContext.isVoiceOpen)
                }
                className={`doodle-button p-2 relative ${voiceContext.isVoiceOpen ? "bg-doodle-accent text-white" : ""}`}
                aria-label="Toggle Voice Assistant"
              >
                <Mic className="w-5 h-5" />
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-doodle-green rounded-full border-2 border-doodle-bg animate-pulse" />
              </button>
            )}

            {/* Search Button - Only show when authenticated */}
            {isAuthenticated && (
              <button
                onClick={() => setShowSearch(!showSearch)}
                className="doodle-button p-2"
                aria-label="Search"
              >
                <Search className="w-5 h-5" />
              </button>
            )}

            {/* Auth Section */}
            {isAuthenticated && user ? (
              <div className="flex items-center gap-2">
                {/* Always-visible Sign Out button so tests can find it directly */}
                <button
                  onClick={() => {
                    logout();
                    navigate("/login");
                  }}
                  className="doodle-button flex items-center gap-1 py-2 px-3 text-doodle-accent"
                  aria-label="Sign Out"
                >
                  <LogOut className="w-4 h-4" />
                  <span className="hidden sm:inline font-doodle text-sm">
                    Sign Out
                  </span>
                </button>
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="doodle-button flex items-center gap-2 py-2 px-3"
                  >
                    <div className="w-6 h-6 rounded-full bg-doodle-green flex items-center justify-center">
                      <span className="text-white text-xs font-bold">
                        {user.firstName[0]}
                        {user.lastName[0]}
                      </span>
                    </div>
                    <span className="hidden sm:inline font-doodle text-sm">
                      {user.firstName}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${userMenuOpen ? "rotate-180" : ""}`}
                    />
                  </button>

                  {/* Dropdown Menu */}
                  {userMenuOpen && (
                    <div className="absolute right-0 mt-2 w-56 doodle-card p-2 z-50">
                      <div className="px-3 py-2 border-b-2 border-dashed border-doodle-text/20 mb-2">
                        <p className="font-doodle font-bold text-doodle-text">
                          {user.firstName} {user.lastName}
                        </p>
                        <p className="font-doodle text-xs text-doodle-text/60 truncate">
                          {user.email}
                        </p>
                        <p className="font-doodle text-xs text-doodle-green mt-1">
                          {user.department}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          logout();
                          setUserMenuOpen(false);
                          navigate("/");
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 font-doodle text-doodle-accent hover:bg-doodle-text/10 transition-colors"
                      >
                        <LogOut className="w-4 h-4" />
                        Sign Out
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <Link
                to="/login"
                className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
              >
                <User className="w-5 h-5" />
                <span className="font-doodle">Employee Login</span>
              </Link>
            )}

            {/* Mobile Menu Button */}
            {isAuthenticated && (
              <button
                className="md:hidden doodle-button p-2"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? (
                  <X className="w-5 h-5" />
                ) : (
                  <Menu className="w-5 h-5" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && isAuthenticated && (
          <nav className="md:hidden py-4 border-t-2 border-doodle-text border-dashed">
            <div className="flex flex-col gap-3">
              <Link
                to="/category/1"
                className="font-doodle text-lg text-doodle-text hover:text-doodle-accent py-2"
                onClick={() => setMobileMenuOpen(false)}
              >
                * Products
              </Link>
              <Link
                to="/customers"
                className="font-doodle text-lg text-doodle-text hover:text-doodle-accent py-2"
                onClick={() => setMobileMenuOpen(false)}
              >
                * Customers
              </Link>
              <Link
                to="/orders"
                className="font-doodle text-lg text-doodle-text hover:text-doodle-accent py-2"
                onClick={() => setMobileMenuOpen(false)}
              >
                * Orders
              </Link>
              <Link
                to="/utilities"
                className="font-doodle text-lg text-doodle-text hover:text-doodle-accent py-2"
                onClick={() => setMobileMenuOpen(false)}
              >
                * Utilities
              </Link>
              {secondaryNavGroups.map((group) => (
                <div
                  key={group.label}
                  className="border-t-2 border-dashed border-doodle-text/30 my-2 pt-2"
                >
                  <p className="font-doodle text-xs text-doodle-text/50 mb-2">
                    {group.label}
                  </p>
                  {group.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      className="font-doodle text-base text-doodle-text/70 hover:text-doodle-accent py-1 block"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      * {item.label}
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </nav>
        )}

        {/* Expandable Search Bar */}
        {showSearch && isAuthenticated && (
          <div className="py-3 border-t-2 border-doodle-text border-dashed">
            <form onSubmit={handleSearch} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/50" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search products, customers, orders..."
                  className="w-full pl-10 pr-4 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="doodle-button doodle-button-primary px-4"
              >
                Search
              </button>
              <button
                type="button"
                onClick={() => setShowSearch(false)}
                className="doodle-button p-2"
              >
                <X className="w-5 h-5" />
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Breadcrumb Navigation */}
      {isAuthenticated && <AppBreadcrumb />}

      {/* Secondary Navigation Bar */}
      {isAuthenticated && (
        <div className="border-t-2 border-doodle-text/20 bg-doodle-bg/50">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between">
              <div
                className={`flex items-center gap-4 overflow-hidden transition-all duration-300 ${showSecondaryNav ? "max-h-10 py-2 opacity-100" : "max-h-0 py-0 opacity-0"}`}
              >
                <nav className="flex items-center gap-1 overflow-x-auto">
                  {secondaryNavGroups.map((group, gi) => (
                    <React.Fragment key={group.label}>
                      {gi > 0 && (
                        <span className="text-doodle-text/20 mx-1 shrink-0">
                          |
                        </span>
                      )}
                      <span className="font-doodle text-xs text-doodle-text/40 shrink-0 mr-1">
                        {group.label}:
                      </span>
                      {group.items.map((item) => (
                        <Link
                          key={item.to}
                          to={item.to}
                          className={`font-doodle text-sm text-doodle-text/70 hover:text-doodle-accent transition-colors flex items-center gap-1 shrink-0 px-1.5 ${
                            location.pathname === item.to
                              ? "text-doodle-accent font-bold"
                              : ""
                          }`}
                        >
                          <item.icon className="w-3.5 h-3.5" />
                          {item.label}
                        </Link>
                      ))}
                    </React.Fragment>
                  ))}
                </nav>
              </div>
              <button
                onClick={() => setShowSecondaryNav(!showSecondaryNav)}
                className="font-doodle text-xs text-doodle-text/50 hover:text-doodle-accent transition-colors flex items-center gap-1 py-2 shrink-0"
                aria-label={showSecondaryNav ? "Hide tools" : "Show tools"}
              >
                <Wrench className="w-3 h-3" />
                {showSecondaryNav ? "Hide" : "Tools"}
                {showSecondaryNav ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

export default AdminHeader;
