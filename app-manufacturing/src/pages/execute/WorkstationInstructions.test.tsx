import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchActiveOperations, fetchProduct, fetchWorkOrder, fetchWorkOrderRouting, type ActiveOperation } from '@/services/api';
import type { Product, WorkOrder, WorkOrderRouting } from '@/types/production';
import WorkstationInstructions from './WorkstationInstructions';

vi.mock('@/services/api', () => ({
  fetchActiveOperations: vi.fn(), fetchProduct: vi.fn(), fetchWorkOrder: vi.fn(), fetchWorkOrderRouting: vi.fn(),
}));
vi.mock('@/pages/define/PartInstructions', () => ({
  default: ({ productId, workCenterId }: { productId: number; workCenterId: number }) =>
    <p>Part sheet {productId} - Center {workCenterId}</p>,
}));
vi.mock('@/pages/define/ModelInstructions', () => ({
  default: ({ modelId, workCenterId, productId }: { modelId: number; workCenterId: number; productId: number }) =>
    <p>Model {modelId} - Center {workCenterId} - Product {productId}</p>,
}));
beforeEach(() => {
  vi.mocked(fetchWorkOrder).mockResolvedValue({ WorkOrderID: 1, ProductID: 825, OrderQty: 7 } as WorkOrder);
  vi.mocked(fetchProduct).mockResolvedValue({ ProductID: 825, ProductModelID: 125, Name: 'Wheel', ProductNumber: 'RW-1' } as Product);
  vi.mocked(fetchWorkOrderRouting).mockResolvedValue([
    { OperationSequence: 20, LocationID: 50, ActualEndDate: null },
    { OperationSequence: 10, LocationID: 50, ActualEndDate: '2026-11-01' },
    { OperationSequence: 30, LocationID: 60, ActualEndDate: null },
  ] as WorkOrderRouting[]);
  vi.mocked(fetchActiveOperations).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function show(query = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[`/execute/work-order/1/instructions${query}`]}><Routes>
      <Route path="/execute/work-order/:id/instructions" element={<WorkstationInstructions />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>) };
}
it('defaults to the first unfinished operation and navigates repeated work centers by sequence', async () => {
  show();
  expect(await screen.findByText('Model 125 - Center 50 - Product 825')).toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('20');
  fireEvent.click(screen.getByRole('button', { name: 'View previous operation' }));
  expect(screen.getByRole('combobox')).toHaveValue('10');
  expect(screen.getByRole('button', { name: 'View previous operation' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '30' } });
  expect(screen.getByText('Model 125 - Center 60 - Product 825')).toBeInTheDocument();
  expect(fetchWorkOrder).toHaveBeenCalledWith(1);
});
it('does not silently replace an invalid requested operation', async () => {
  show('?operation=99');
  expect(await screen.findByRole('alert')).toHaveTextContent('not part of this work order');
  expect(screen.queryByText(/Model 125 -/)).not.toBeInTheDocument();
});
it('takes the work-order product identity rather than a query parameter', async () => {
  show('?operation=30&productId=999');
  expect(await screen.findByText('Model 125 - Center 60 - Product 825')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open full document' })).toHaveAttribute('href', '/define/models/125/instructions?productId=825');
});
it('retains full-document access for missing routing', async () => {
  vi.mocked(fetchWorkOrderRouting).mockResolvedValue([]);
  show();
  expect(await screen.findByText('No routing is available for this work order.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open full document' })).toBeInTheDocument();
});
it('reports read failures explicitly', async () => {
  vi.mocked(fetchWorkOrder).mockRejectedValue(new Error('Forbidden'));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
});
it('prefers the active operation unless an explicit operation is requested', async () => {
  vi.mocked(fetchActiveOperations).mockResolvedValue([{ workOrderId: 1, operationSequence: 30 } as ActiveOperation]);
  show();
  expect(await screen.findByText('Model 125 - Center 60 - Product 825')).toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('30');
  cleanup();
  show('?operation=10');
  expect(await screen.findByText('Model 125 - Center 50 - Product 825')).toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('10');
});
it('shows the first operation for completed orders', async () => {
  const operations = await vi.mocked(fetchWorkOrderRouting)(1);
  vi.mocked(fetchWorkOrderRouting).mockResolvedValue(operations.map(operation => ({ ...operation, ActualEndDate: '2026-11-01' })));
  show();
  expect(await screen.findByText('Model 125 - Center 50 - Product 825')).toBeInTheDocument();
  expect(screen.getByRole('combobox')).toHaveValue('10');
});
it('retains explicit viewing selection when push-invalidated activity changes', async () => {
  const { client } = show('?operation=30');
  expect(await screen.findByText('Model 125 - Center 60 - Product 825')).toBeInTheDocument();
  vi.mocked(fetchActiveOperations).mockResolvedValue([{ workOrderId: 1, operationSequence: 20 } as ActiveOperation]);
  await act(async () => { await client.invalidateQueries({ queryKey: ['active-operations'] }); });
  expect(screen.getByRole('combobox')).toHaveValue('30');
  expect(screen.getByText('Model 125 - Center 60 - Product 825')).toBeInTheDocument();
});
it('embeds the part sheet for model-less manufactured parts', async () => {
  vi.mocked(fetchWorkOrder).mockResolvedValue({ WorkOrderID: 1, ProductID: 514, OrderQty: 3 } as WorkOrder);
  vi.mocked(fetchProduct).mockResolvedValue({ ProductID: 514, ProductModelID: null, Name: 'LL Mountain Seat Assembly', ProductNumber: 'SA-M198' } as Product);
  show('?operation=20');
  expect(await screen.findByText('Part sheet 514 - Center 50')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open full part sheet' })).toHaveAttribute('href', '/define/parts/514/instructions');
});
