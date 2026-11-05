import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchActiveBOM, fetchProductInventory, fetchProductsByNumbers, sqlUtcTimestamp } from '@/services/api';
import { hasGeneratedPartSheet } from '@/lib/generatedManufacturingContent';
import type { GeneratedFigure } from '@/lib/generatedManufacturingContent';
import { Skeleton } from '@/components/ui/skeleton';

export default function ManufacturingComponentLegend({ callouts }: { callouts: GeneratedFigure['callouts'] }) {
  const { pathname } = useLocation();
  const numbers = [...new Set(callouts.map(callout => callout.productNumber))].sort();
  const products = useQuery({
    queryKey: ['instruction-components', numbers], queryFn: () => fetchProductsByNumbers(numbers),
    enabled: numbers.length > 0,
  });
  const bom = useQuery({ queryKey: ['active-bom'], queryFn: fetchActiveBOM, enabled: !!products.data?.length });
  const inventory = useQuery({
    queryKey: ['product-inventory'], queryFn: () => fetchProductInventory(), enabled: !!products.data?.length,
  });
  return <div>
    {products.isLoading && <Skeleton className="mb-2 h-5 w-56 print:hidden" aria-label="Loading component links" />}
    {products.isError && <p role="alert" className="text-sm text-destructive">Component links could not be loaded. Component names remain available.</p>}
    {(bom.isError || inventory.isError) && <p role="alert" className="text-sm text-destructive">Some BOM or inventory links could not be loaded.</p>}
    <ul className="space-y-2 text-sm">{callouts.map(callout => {
      const matches = products.data?.filter(product => product.ProductNumber === callout.productNumber) ?? [];
      const product = matches.length === 1 ? matches[0] : undefined;
      const name = <>{callout.name} ({callout.productNumber})</>;
      return <li key={callout.number}>
        <strong>{callout.number}:</strong>{' '}
        {product ? <Link className="text-doodle-blue underline print:text-inherit print:no-underline"
          to={`/define/products/${product.ProductID}`}>{name}</Link> : name}
        {products.isSuccess && !product && <span className="ml-2 text-muted-foreground">
          {matches.length > 1 ? 'Product match is ambiguous' : 'Product unavailable'}
        </span>}
        {product && <span className="ml-3 inline-flex gap-3 print:hidden">
          {(bom.isLoading || inventory.isLoading) && <Skeleton className="h-5 w-24" aria-label="Loading BOM and inventory links" />}
          {bom.data?.some(row => row.ProductAssemblyID === product.ProductID &&
            new Date(sqlUtcTimestamp(row.StartDate)).getTime() <= Date.now()) &&
            <Link className="text-doodle-blue underline" to={`/engineer/bom/${product.ProductID}`}>BOM</Link>}
          {inventory.data?.some(row => row.ProductID === product.ProductID) &&
            <Link className="text-doodle-blue underline" to={`/receive/inventory/${product.ProductID}`}>Inventory</Link>}
          {hasGeneratedPartSheet(product.ProductID) && pathname !== `/define/parts/${product.ProductID}/instructions` &&
            <Link className="text-doodle-blue underline" to={`/define/parts/${product.ProductID}/instructions`}>Part sheet</Link>}
        </span>}
      </li>;
    })}</ul>
  </div>;
}
