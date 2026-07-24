import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Menu,
  X,
  ClipboardList,
  Cog,
  Calendar,
  Play,
  PackageCheck,
  LayoutDashboard,
  MapPin,
  ChevronDown,
  ChevronUp,
  HardHat,
  Truck,
  Users,
  BarChart3,
  ShoppingCart,
  Settings as SettingsIcon,
  LogOut,
  Warehouse,
  Bot,
  DollarSign,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import AppBreadcrumb from "@/components/AppBreadcrumb";
import ManufacturingLogo from "@/components/ManufacturingLogo";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

const primaryNav = [
  {
    to: "/define",
    label: "Define",
    icon: ClipboardList,
    stage: 1,
    desc: "What we make — product catalog, models, categories and specs.",
  },
  {
    to: "/engineer",
    label: "Engineer",
    icon: Cog,
    stage: 2,
    desc: "How we make it — bills of materials, routings and manufacturing locations.",
  },
  {
    to: "/plan",
    label: "Plan",
    icon: Calendar,
    stage: 3,
    desc: "When we make it — demand, work orders, scheduling and planning intelligence.",
  },
  {
    to: "/execute",
    label: "Execute",
    icon: Play,
    stage: 4,
    desc: "Making it now — shop floor, work order tracking, workforce and finished-good tracker.",
  },
  {
    to: "/supply",
    label: "Supply",
    icon: Truck,
    stage: 5,
    desc: "Sourcing components — vendors, purchase orders and supply-chain risk.",
  },
  {
    to: "/receive",
    label: "Receive",
    icon: PackageCheck,
    stage: 6,
    desc: "Closing the loop — inventory by location and product, costing and margin analysis.",
  },
  {
    to: "/warehouse",
    label: "Warehouse",
    icon: Warehouse,
    stage: 7,
    desc: "Finished Goods Storage — put-away, order picking, supplier receiving and damage tracking.",
  },
];

const secondaryNavGroups = [
  {
    label: "Operations",
    items: [
      { to: "/execute/shop-floor", label: "Shop Floor", icon: HardHat },
      { to: "/execute/tracker", label: "Product Tracker", icon: HardHat },
      { to: "/execute/workforce", label: "Workforce", icon: Users },
      { to: "/warehouse/floor", label: "Warehouse Floor", icon: Warehouse },
      { to: "/warehouse/workforce", label: "Warehouse Workers", icon: Users },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { to: "/plan/demand", label: "Demand", icon: ShoppingCart },
      { to: "/plan/intelligence", label: "Planning", icon: BarChart3 },
      { to: "/plan/finance", label: "Finance", icon: DollarSign },
    ],
  },
  {
    label: "Reference",
    items: [{ to: "/engineer/locations", label: "Locations", icon: MapPin }],
  },
  {
    label: "Admin",
    items: [
      { to: "/manufacturing-agent", label: "AI Agent", icon: Bot },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

const ProductionHeader: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const userMenuRef = React.useRef<HTMLDivElement>(null);

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
  const [showSecondaryNav, setShowSecondaryNav] = React.useState(() => {
    const saved = localStorage.getItem("showSecondaryNav");
    return saved !== null ? saved === "true" : true;
  });

  React.useEffect(() => {
    localStorage.setItem("showSecondaryNav", String(showSecondaryNav));
  }, [showSecondaryNav]);

  return (
    <header className="sticky top-0 z-50 bg-doodle-bg border-b-4 border-doodle-text">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 group">
            <div className="group-hover:rotate-6 transition-transform">
              <ManufacturingLogo className="w-8 h-8 md:w-10 md:h-10" />
            </div>
            <div className="flex flex-col">
              <span className="font-doodle text-lg md:text-2xl font-bold text-doodle-text leading-tight">
                Adventure<span className="text-doodle-accent">Works</span>
              </span>
              <span className="font-doodle text-xs text-doodle-text/60 -mt-1">
                Production Hub
              </span>
            </div>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            <Link
              to="/"
              className={`font-doodle text-sm text-doodle-text hover:text-doodle-accent transition-colors flex items-center gap-1 px-2 py-1 ${location.pathname === "/" ? "squiggle" : ""}`}
            >
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </Link>
            {primaryNav.map((item) => (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>
                  <Link
                    to={item.to}
                    className={`font-doodle text-sm text-doodle-text hover:text-doodle-accent transition-colors flex items-center gap-1 px-2 py-1 ${location.pathname.startsWith(item.to) ? "squiggle" : ""}`}
                  >
                    <item.icon className="w-4 h-4" />
                    <span className="text-doodle-accent/60 text-xs mr-0.5">
                      {item.stage}.
                    </span>
                    {item.label}
                  </Link>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="max-w-[240px] font-doodle text-xs"
                >
                  <p className="font-bold mb-0.5">
                    {item.stage}. {item.label}
                  </p>
                  <p>{item.desc}</p>
                </TooltipContent>
              </Tooltip>
            ))}
          </nav>

          {/* Right Side */}
          <div className="flex items-center gap-2">
            {/* User Avatar Dropdown - desktop */}
            {user && (
              <div className="relative hidden md:block" ref={userMenuRef}>
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
                    </div>
                    <button
                      onClick={() => {
                        logout();
                        setUserMenuOpen(false);
                        navigate("/login");
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 font-doodle text-doodle-accent hover:bg-doodle-text/10 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                )}
              </div>
            )}
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
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <nav className="md:hidden py-4 border-t-2 border-doodle-text border-dashed">
            <div className="flex flex-col gap-3">
              <Link
                to="/"
                className="font-doodle text-lg text-doodle-text hover:text-doodle-accent py-2"
                onClick={() => setMobileMenuOpen(false)}
              >
                ✦ Dashboard
              </Link>
              {primaryNav.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="font-doodle text-lg text-doodle-text hover:text-doodle-accent py-2"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  ✦ {item.stage}. {item.label}
                </Link>
              ))}
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
                      ✦ {item.label}
                    </Link>
                  ))}
                </div>
              ))}
              {user && (
                <div className="border-t-2 border-dashed border-doodle-text/30 my-2 pt-2">
                  <p className="font-doodle text-xs text-doodle-text/50 mb-2">
                    {user.firstName} {user.lastName}
                  </p>
                  <button
                    onClick={() => {
                      logout();
                      navigate("/login");
                      setMobileMenuOpen(false);
                    }}
                    className="font-doodle text-base text-doodle-accent hover:text-doodle-accent/70 py-1 flex items-center gap-2"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          </nav>
        )}
      </div>

      {/* Breadcrumb */}
      <AppBreadcrumb />

      {/* Secondary Navigation */}
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
                        className={`font-doodle text-sm text-doodle-text/70 hover:text-doodle-accent transition-colors flex items-center gap-1 shrink-0 px-1.5 ${location.pathname === item.to ? "text-doodle-accent font-bold" : ""}`}
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
            >
              {showSecondaryNav ? "Hide" : "Ref"}
              {showSecondaryNav ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};

export default ProductionHeader;
