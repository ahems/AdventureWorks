import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home } from 'lucide-react';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

interface BreadcrumbSegment {
  label: string;
  href?: string;
}

const routeMap: Record<string, string> = {
  define: 'Define',
  engineer: 'Engineer',
  plan: 'Plan',
  execute: 'Execute',
  receive: 'Receive',
  departments: 'Departments & Shifts',
  products: 'Products',
  models: 'Models',
  categories: 'Categories',
  bom: 'Bill of Materials',
  routing: 'Routing',
  locations: 'Locations',
  'work-orders': 'Work Orders',
  schedule: 'Schedule',
  'shop-floor': 'Shop Floor',
  'work-order': 'Work Order',
  tracker: 'Product Tracker',
  scrap: 'Scrap Reasons',
  inventory: 'Inventory',
  costing: 'Cost Analysis',
};

const AppBreadcrumb: React.FC = () => {
  const location = useLocation();

  if (location.pathname === '/') return null;

  const parts = location.pathname.split('/').filter(Boolean);
  const segments: BreadcrumbSegment[] = [{ label: 'Dashboard', href: '/' }];

  let path = '';
  parts.forEach((part, i) => {
    path += `/${part}`;
    const label = routeMap[part] || (isNaN(Number(part)) ? part : `#${part}`);
    if (i < parts.length - 1) {
      segments.push({ label, href: path });
    } else {
      segments.push({ label });
    }
  });

  return (
    <div className="container mx-auto px-4 pt-3 pb-1">
      <Breadcrumb>
        <BreadcrumbList className="font-doodle text-sm">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/" className="flex items-center gap-1 text-doodle-text/60 hover:text-doodle-accent">
                <Home className="w-4 h-4" />
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {segments.map((crumb, index) => (
            <React.Fragment key={index}>
              <BreadcrumbSeparator className="text-doodle-text/40" />
              <BreadcrumbItem>
                {crumb.href && index < segments.length - 1 ? (
                  <BreadcrumbLink asChild>
                    <Link to={crumb.href} className="text-doodle-text/60 hover:text-doodle-accent transition-colors">{crumb.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="text-doodle-text font-medium">{crumb.label}</BreadcrumbPage>
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
