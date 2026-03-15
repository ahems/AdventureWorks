import React from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Home } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { getCategoryById, getSubcategoryById, getProductById } from '@/data/mockData';
import { getCustomerById } from '@/data/mockCustomers';

interface BreadcrumbSegment {
  label: string;
  href?: string;
}

const AppBreadcrumb: React.FC = () => {
  const location = useLocation();
  const params = useParams();

  const getBreadcrumbs = (): BreadcrumbSegment[] => {
    const path = location.pathname;
    const segments: BreadcrumbSegment[] = [];

    // Always start with Dashboard
    if (path !== '/') {
      segments.push({ label: 'Dashboard', href: '/' });
    }

    // Category page
    if (path.startsWith('/category/')) {
      const categoryId = parseInt(params.categoryId || '');
      const category = getCategoryById(categoryId);
      segments.push({ label: 'Products', href: '/category/1' });
      if (category) {
        segments.push({ label: category.Name });
      }
    }

    // Product page
    if (path.startsWith('/product/')) {
      const productId = parseInt(params.productId || '');
      const product = getProductById(productId);
      if (product) {
        const subcategory = product.ProductSubcategoryID 
          ? getSubcategoryById(product.ProductSubcategoryID) 
          : undefined;
        const category = subcategory 
          ? getCategoryById(subcategory.ProductCategoryID) 
          : undefined;

        segments.push({ label: 'Products', href: '/category/1' });
        if (category) {
          segments.push({ 
            label: category.Name, 
            href: `/category/${category.ProductCategoryID}` 
          });
        }
        segments.push({ label: product.Name });
      }
    }

    // Customers page
    if (path === '/customers') {
      segments.push({ label: 'Customers' });
    }

    // Orders page
    if (path === '/orders') {
      segments.push({ label: 'Orders' });
    }

    // Reviews page
    if (path === '/reviews') {
      segments.push({ label: 'Reviews' });
    }

    // Utilities/AI Tools page
    if (path === '/utilities') {
      segments.push({ label: 'AI Tools' });
    }

    // Promotions page
    if (path === '/promotions') {
      segments.push({ label: 'Promotions' });
    }

    // Cultures page
    if (path === '/cultures') {
      segments.push({ label: 'Cultures' });
    }

    // Currencies page
    if (path === '/currencies') {
      segments.push({ label: 'Currencies' });
    }

    // Stale Carts page
    if (path === '/stale-carts') {
      segments.push({ label: 'Stale Carts' });
    }

    // Search page
    if (path === '/search') {
      segments.push({ label: 'Search Results' });
    }

    return segments;
  };

  const breadcrumbs = getBreadcrumbs();

  // Don't show breadcrumbs on dashboard or login
  if (location.pathname === '/' || location.pathname === '/login') {
    return null;
  }

  return (
    <div className="container mx-auto px-4 pt-4">
      <Breadcrumb>
        <BreadcrumbList className="font-doodle">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/" className="flex items-center gap-1 text-doodle-text/60 hover:text-doodle-accent">
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
