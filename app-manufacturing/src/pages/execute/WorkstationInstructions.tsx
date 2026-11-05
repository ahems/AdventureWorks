import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchActiveOperations, fetchProduct, fetchWorkOrder, fetchWorkOrderRouting } from '@/services/api';
import { DetailPageSkeleton } from '@/components/LoadingSkeletons';
import ModelInstructions from '@/pages/define/ModelInstructions';

export default function WorkstationInstructions() {
  const { id } = useParams();
  const workOrderId = Number(id);
  const validId = Number.isSafeInteger(workOrderId) && workOrderId > 0;
  const [search, setSearch] = useSearchParams();
  const order = useQuery({ queryKey: ['work-order', workOrderId], queryFn: () => fetchWorkOrder(workOrderId), enabled: validId });
  const product = useQuery({
    queryKey: ['product', order.data?.ProductID], queryFn: () => fetchProduct(order.data!.ProductID), enabled: !!order.data,
  });
  const routing = useQuery({
    queryKey: ['wo-routing', workOrderId], queryFn: () => fetchWorkOrderRouting(workOrderId), enabled: !!order.data,
  });
  const active = useQuery({ queryKey: ['active-operations'], queryFn: fetchActiveOperations, enabled: !!order.data });
  if (!validId) return <p role="alert" className="p-6">Invalid work-order ID.</p>;
  const error = order.error ?? product.error ?? routing.error ?? active.error;
  if (error) return <p role="alert" className="p-6 text-destructive">Could not load workstation instructions: {error.message}</p>;
  if (order.isLoading || (!!order.data && (product.isLoading || routing.isLoading || active.isLoading))) return <DetailPageSkeleton />;
  if (!order.data || !product.data) return <p className="p-6">Work order or product not found.</p>;
  const operations = [...(routing.data ?? [])].sort((a, b) => a.OperationSequence - b.OperationSequence);
  const requested = search.get('operation');
  const sequence = requested !== null && /^[1-9]\d*$/.test(requested) ? Number(requested) : undefined;
  const explicit = requested !== null ? operations.find(operation => operation.OperationSequence === sequence) : undefined;
  const activeSequence = active.data?.find(operation => operation.workOrderId === workOrderId)?.operationSequence;
  const selected = requested !== null ? explicit :
    operations.find(operation => operation.OperationSequence === activeSequence) ??
    operations.find(operation => !operation.ActualEndDate) ?? operations[0];
  const selectedIndex = selected ? operations.indexOf(selected) : -1;
  const choose = (index: number) => {
    const next = new URLSearchParams(search);
    next.set('operation', String(operations[index].OperationSequence));
    setSearch(next);
  };
  const modelId = product.data.ProductModelID;
  return <div className="workstation-reader container mx-auto space-y-5 px-4 py-8">
    <Link className="text-doodle-blue underline" to={`/execute/work-order/${workOrderId}`}>Back to work order</Link>
    <h1 className="font-doodle text-2xl font-bold">Workstation instructions - WO #{workOrderId}</h1>
    <p>{product.data.Name} ({product.data.ProductNumber}) · Order quantity: {order.data.OrderQty}</p>
    <p className="text-sm text-muted-foreground">Reading view only. Changing the viewed operation does not advance production.</p>
    {modelId && <Link className="text-doodle-blue underline" to={`/define/models/${modelId}/instructions?productId=${product.data.ProductID}`}>Open full document</Link>}
    {!operations.length ? <p>No routing is available for this work order.</p> : <>
      <label className="block">Viewed operation{' '}
        <select className="doodle-input" value={selected?.OperationSequence ?? ''} onChange={event => {
          const index = operations.findIndex(operation => operation.OperationSequence === Number(event.target.value));
          if (index >= 0) choose(index);
        }}>
          {!selected && <option value="">Select an operation</option>}
          {operations.map(operation => <option key={operation.OperationSequence} value={operation.OperationSequence}>
            Operation {operation.OperationSequence} - Work Center {operation.LocationID}
          </option>)}
        </select>
      </label>
      {requested !== null && !explicit && <p role="alert" className="text-destructive">The requested operation is not part of this work order. Select an available operation.</p>}
      {selected && <>
        <nav className="flex gap-3" aria-label="Viewed operation navigation">
          <button className="doodle-button" disabled={selectedIndex <= 0} onClick={() => choose(selectedIndex - 1)}>View previous operation</button>
          <button className="doodle-button" disabled={selectedIndex >= operations.length - 1} onClick={() => choose(selectedIndex + 1)}>View next operation</button>
        </nav>
        <p>Operation {selected.OperationSequence} · Work Center {selected.LocationID}. Instructions are shared by operations at this work center.</p>
        {modelId ? <ModelInstructions modelId={modelId} productId={product.data.ProductID} embedded workCenterId={selected.LocationID} /> :
          <p>No product-model instructions are assigned to this product.</p>}
      </>}
    </>}
    <style>{`@media (min-width: 1024px) {
      .workstation-reader .instruction-document ol > li:has(figure) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem; }
      .workstation-reader .instruction-document ol > li:has(figure) > p { grid-column: 1; }
      .workstation-reader .instruction-document ol > li:has(figure) > div { grid-column: 2; }
    }`}</style>
  </div>;
}
