import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchEffectiveProductBOM, fetchProduct } from '@/services/api';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
  productId: number;
  modelId: number;
  representativeId?: number;
}

export default function InstructionProductContext({ productId, modelId, representativeId }: Props) {
  const validId = Number.isSafeInteger(productId) && productId > 0;
  const product = useQuery({ queryKey: ['product', productId], queryFn: () => fetchProduct(productId), enabled: validId });
  const matches = product.data?.ProductModelID === modelId;
  const bom = useQuery({
    queryKey: ['instruction-bom', productId], queryFn: () => fetchEffectiveProductBOM(productId), enabled: matches,
  });
  const representative = useQuery({
    queryKey: ['product', representativeId], queryFn: () => fetchProduct(representativeId!), enabled: matches && !!representativeId,
  });
  const representativeMatches = representative.data?.ProductModelID === modelId;
  const representativeBOM = useQuery({
    queryKey: ['instruction-bom', representativeId], queryFn: () => fetchEffectiveProductBOM(representativeId!),
    enabled: matches && !!representativeId && representativeMatches,
  });
  if (!validId) return <p role="alert" className="text-destructive">Invalid selected-product ID.</p>;
  if (product.isLoading) return <Skeleton className="h-24 w-full" aria-label="Loading selected product" />;
  if (product.isError) return <p role="alert" className="text-destructive">Could not load selected product: {product.error.message}</p>;
  if (!product.data) return <p role="alert" className="text-destructive">Selected product not found.</p>;
  if (!matches) return <p role="alert" className="text-destructive">
    The selected product does not belong to this model. <Link className="underline" to={`/define/products/${productId}`}>Open the selected product</Link>.
  </p>;
  const selected = product.data;
  const comparable = !!bom.data?.length && !!representativeBOM.data?.length && representativeMatches;
  const totals = (rows: NonNullable<typeof bom.data>) => {
    const result = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.ComponentID}/${row.UnitMeasureCode.trim()}`;
      result.set(key, (result.get(key) ?? 0) + row.PerAssemblyQty);
    }
    return result;
  };
  const selectedTotals = totals(bom.data ?? []);
  const representativeTotals = totals(representativeBOM.data ?? []);
  const changed = comparable && (selectedTotals.size !== representativeTotals.size ||
    [...selectedTotals].some(([key, quantity]) => representativeTotals.get(key) !== quantity));
  return <section className="doodle-card-static space-y-3 p-6">
    <h2 className="font-doodle text-lg font-bold">Selected product</h2>
    <p>{selected.Name} ({selected.ProductNumber}) · Size: {selected.Size ?? 'Not specified'} · Colour: {selected.Color ?? 'Not specified'}</p>
    <p className="text-sm">Instructions and drawings are model-wide schematics, not variant-specific geometry.</p>
    {representativeMatches && <p className="text-sm">Document representative: {representative.data.Name} ({representative.data.ProductNumber}).</p>}
    {!representativeId && <p className="text-sm">The document's representative product is not recorded. No component substitutions are inferred.</p>}
    {(bom.isLoading || representative.isLoading || representativeBOM.isLoading) && <Skeleton className="h-12 w-full" aria-label="Loading variant component evidence" />}
    {(bom.isError || representative.isError || representativeBOM.isError) && <p role="alert" className="text-destructive">Some variant component evidence could not be loaded.</p>}
    {representative.data && !representativeMatches && <p role="alert" className="text-destructive">The recorded representative no longer belongs to this model; comparison is unavailable.</p>}
    {bom.isSuccess && (!bom.data.length ? <p>No effective BOM records are available for this product.</p> : <>
      <h3 className="font-semibold">Selected-product components per assembly</h3>
      <ul className="space-y-1 text-sm">{[...selectedTotals].map(([key, quantity]) => {
        const [componentId, unit] = key.split('/');
        return <li key={key}><Link className="text-doodle-blue underline" to={`/define/products/${componentId}`}>Component #{componentId}</Link>: {quantity} {unit}</li>;
      })}</ul>
    </>)}
    {comparable ? <p className="text-sm">
      {changed ? 'The current component IDs, quantities or units differ from the representative BOM. Use the selected-product component list; the shared diagram has not been adapted.' :
        'The current component IDs, quantities and units match the representative BOM.'}
    </p> : bom.isSuccess && <p className="text-sm">No complete current BOM comparison is available; substitutions are not inferred.</p>}
    <p className="text-xs text-muted-foreground">BOM evidence reflects current effective records, not a reconstruction of the document's release date.</p>
  </section>;
}
