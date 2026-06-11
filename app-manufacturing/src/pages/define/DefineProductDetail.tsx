import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchProduct, fetchProductModel, fetchProductCategories, fetchProductSubcategories, fetchProductModelDescCultures, fetchProductDescriptions } from '@/services/api';
import { fetchCurrentCost } from '@/services/planningApi';
import { ArrowLeft, Info } from 'lucide-react';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const DefineProductDetail = () => {
  const { id } = useParams();
  const productId = Number(id);

  const { data: product, isLoading } = useQuery({ queryKey: ['product', productId], queryFn: () => fetchProduct(productId) });
  const { data: model } = useQuery({
    queryKey: ['product-model', product?.ProductModelID],
    queryFn: () => fetchProductModel(product!.ProductModelID!),
    enabled: !!product?.ProductModelID,
  });
  const { data: categories } = useQuery({ queryKey: ['categories'], queryFn: fetchProductCategories });
  const { data: subcategories } = useQuery({ queryKey: ['subcategories'], queryFn: fetchProductSubcategories });
  const { data: descCultures } = useQuery({
    queryKey: ['desc-cultures', product?.ProductModelID],
    queryFn: () => fetchProductModelDescCultures(product!.ProductModelID!),
    enabled: !!product?.ProductModelID,
  });
  const { data: descriptions } = useQuery({ queryKey: ['descriptions'], queryFn: fetchProductDescriptions });
  const { data: currentCost } = useQuery({
    queryKey: ['current-cost', productId],
    queryFn: () => fetchCurrentCost(productId),
    enabled: !!product?.MakeFlag,
    staleTime: 60_000,
  });

  if (isLoading) return <div className="container mx-auto px-4 py-8"><DetailPageSkeleton /></div>;
  if (!product) return <div className="container mx-auto px-4 py-8 font-doodle">Product not found</div>;

  const subcategory = subcategories?.find(s => s.ProductSubcategoryID === product.ProductSubcategoryID);
  const category = subcategory ? categories?.find(c => c.ProductCategoryID === subcategory.ProductCategoryID) : null;

  const descId = descCultures?.[0]?.ProductDescriptionID;
  const description = descId ? descriptions?.find(d => d.ProductDescriptionID === descId) : null;

  const specs = [
    { label: 'Product Line', value: product.ProductLine },
    { label: 'Class', value: product.Class },
    { label: 'Style', value: product.Style },
    { label: 'Size', value: product.Size },
    { label: 'Weight', value: product.Weight ? `${product.Weight} ${product.WeightUnitMeasureCode || ''}` : null },
    { label: 'Color', value: product.Color },
    { label: 'Days to Manufacture', value: product.DaysToManufacture },
    { label: 'Safety Stock', value: product.SafetyStockLevel },
    { label: 'Reorder Point', value: product.ReorderPoint },
  ];

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <Link to="/define" className="inline-flex items-center gap-2 font-doodle text-doodle-blue hover:underline">
        <ArrowLeft className="w-4 h-4" /> Back to Products
      </Link>

      <div className="doodle-card-static p-6">
        <div className="flex flex-col md:flex-row justify-between gap-4">
          <div>
            <h1 className="font-doodle text-2xl font-bold text-doodle-text">{product.Name}</h1>
            <p className="font-doodle text-sm text-muted-foreground">{product.ProductNumber}</p>
            {category && subcategory && (
              <p className="font-doodle text-xs text-muted-foreground mt-1">{category.Name} → {subcategory.Name}</p>
            )}
          </div>
          <div className="flex gap-4 items-start flex-wrap">
            <div className="text-center">
              <p className="font-doodle text-xs text-muted-foreground">Standard Cost</p>
              <p className="font-doodle text-xl font-bold text-doodle-green">${product.StandardCost.toFixed(2)}</p>
            </div>
            {currentCost && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-center cursor-help">
                      <p className="font-doodle text-xs text-muted-foreground flex items-center gap-1 justify-center">
                        Mfg Cost <Info className="w-3 h-3" />
                      </p>
                      <p className="font-doodle text-xl font-bold text-doodle-accent">${currentCost.totalManufacturingCost.toFixed(2)}</p>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="font-doodle text-xs">
                    <p>Material: ${currentCost.currentMaterialCost.toFixed(2)}</p>
                    <p>Routing: ${currentCost.estimatedRoutingCost.toFixed(2)}</p>
                    <p className="mt-1 text-muted-foreground">Based on latest vendor costs & cost history</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <div className="text-center">
              <p className="font-doodle text-xs text-muted-foreground">List Price</p>
              <p className="font-doodle text-xl font-bold text-doodle-accent">${product.ListPrice.toFixed(2)}</p>
            </div>
            {currentCost && (
              <div className="text-center">
                <p className="font-doodle text-xs text-muted-foreground">Margin</p>
                <p className={`font-doodle text-xl font-bold ${currentCost.grossMarginPct >= 0.15 ? 'text-doodle-green' : currentCost.grossMarginPct >= 0 ? 'text-yellow-600' : 'text-destructive'}`}>
                  {(currentCost.grossMarginPct * 100).toFixed(1)}%
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Specs */}
        <div className="doodle-card-static p-6">
          <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Engineering Specs</h2>
          <div className="space-y-2">
            {specs.map((s) => (
              <div key={s.label} className="flex justify-between py-1 border-b border-dashed border-doodle-text/10">
                <span className="font-doodle text-sm text-muted-foreground">{s.label}</span>
                <span className="font-doodle text-sm font-bold text-doodle-text">{s.value ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Model & Description */}
        <div className="doodle-card-static p-6">
          <h2 className="font-doodle text-lg font-bold text-doodle-text mb-4">Model & Description</h2>
          {model ? (
            <div className="space-y-3">
              <p className="font-doodle text-sm"><span className="text-muted-foreground">Model:</span> <span className="font-bold">{model.Name}</span></p>
              {description && <p className="font-doodle text-sm text-doodle-text/80">{description.Description}</p>}
            </div>
          ) : (
            <p className="font-doodle text-sm text-muted-foreground">No model assigned</p>
          )}
        </div>
      </div>

      {/* Quick Links */}
      <div className="flex flex-wrap gap-3">
        <Link to={`/engineer/bom/${productId}`} className="doodle-button doodle-button-accent text-sm">View BOM →</Link>
        <Link to={`/engineer/routing/${productId}`} className="doodle-button text-sm">View Routing →</Link>
        <Link to={`/receive/inventory/${productId}`} className="doodle-button text-sm">View Inventory →</Link>
        <Link to={`/receive/costing/${productId}`} className="doodle-button text-sm">Cost History →</Link>
      </div>
    </div>
  );
};

export default DefineProductDetail;
