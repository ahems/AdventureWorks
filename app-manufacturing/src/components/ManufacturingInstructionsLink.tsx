import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { fetchProductModel } from '@/services/api';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
  modelId?: number | null;
  locationId?: number | null;
  productId?: number;
}

export default function ManufacturingInstructionsLink({ modelId, locationId, productId }: Props) {
  const model = useQuery({
    queryKey: ['product-model', modelId],
    queryFn: () => fetchProductModel(modelId!),
    enabled: !!modelId,
  });
  if (!modelId) return <span className="font-doodle text-xs text-muted-foreground">No product model assigned</span>;
  if (model.isLoading) return <Skeleton className="h-5 w-56" aria-label="Loading instruction availability" />;
  if (model.isError) return <span role="alert" className="text-sm text-destructive">Could not load instruction availability.</span>;
  if (!model.data?.Instructions?.trim()) return <span className="font-doodle text-xs text-muted-foreground">No manufacturing instructions available</span>;
  return (
    <Link to={`/define/models/${modelId}/instructions${productId ? `?productId=${productId}` : ''}${locationId ? `#work-center-${locationId}` : ''}`}
      className="inline-flex items-center gap-2 font-doodle text-sm text-doodle-blue hover:underline print:hidden">
      <BookOpen className="h-4 w-4" /> View Manufacturing Instructions
    </Link>
  );
}
