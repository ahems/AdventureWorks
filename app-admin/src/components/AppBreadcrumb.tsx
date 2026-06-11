import React, { useMemo } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Home } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  useAdminCategoryById,
  useAdminProductById,
} from "@/hooks/useAdminProducts";

interface BreadcrumbSegment {
  label: string;
  href?: string;
}

const AppBreadcrumb: React.FC = () => {
  const location = useLocation();
  const params = useParams();
  const path = location.pathname;

  const catIdNum = path.startsWith("/category/")
    ? parseInt(params.categoryId || "")
    : 0;
  const prodIdNum = path.startsWith("/product/")
    ? parseInt(params.productId || "")
    : 0;

  const { data: category } = useAdminCategoryById(catIdNum);
  const { data: product } = useAdminProductById(prodIdNum);

  const breadcrumbs = useMemo((): BreadcrumbSegment[] => {
    const segments: BreadcrumbSegment[] = [];

    // Always start with Dashboard
    if (path !== "/") {
      segments.push({ label: "Dashboard", href: "/" });
    }

    // Category page
    if (path.startsWith("/category/")) {
      segments.push({ label: "Products", href: "/products" });
      if (category) {
        segments.push({ label: category.Name });
      }
    }

    // Product page
    if (path.startsWith("/product/")) {
      segments.push({ label: "Products", href: "/products" });
      if (product) {
        segments.push({ label: product.Name });
      }
    }

    if (path === "/customers") segments.push({ label: "Customers" });
    if (path === "/orders") segments.push({ label: "Orders" });
    if (path === "/reviews") segments.push({ label: "Reviews" });
    if (path === "/utilities") segments.push({ label: "AI Tools" });
    if (path === "/promotions") segments.push({ label: "Promotions" });
    if (path === "/cultures") segments.push({ label: "Cultures" });
    if (path === "/currencies") segments.push({ label: "Currencies" });
    if (path === "/stale-carts") segments.push({ label: "Stale Carts" });
    if (path === "/search") segments.push({ label: "Search Results" });

    return segments;
  }, [path, category, product]);

  // Don't show breadcrumbs on dashboard or login
  if (location.pathname === "/" || location.pathname === "/login") {
    return null;
  }

  return (
    <div className="container mx-auto px-4 pt-4">
      <Breadcrumb>
        <BreadcrumbList className="font-doodle">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link
                to="/"
                className="flex items-center gap-1 text-doodle-text/60 hover:text-doodle-accent"
              >
                <Home className="w-4 h-4" />
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>

          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={index}>
              <BreadcrumbSeparator className="text-doodle-text/40" />
              <BreadcrumbItem>
                {crumb.href && index < breadcrumbs.length - 1 ? (
                  <BreadcrumbLink asChild>
                    <Link
                      to={crumb.href}
                      className="text-doodle-text/60 hover:text-doodle-accent transition-colors"
                    >
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="text-doodle-text font-medium">
                    {crumb.label}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </React.Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
};

export default AppBreadcrumb;
