import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchEffectiveProductBOM, fetchProduct } from '@/services/api';
import type { BillOfMaterials, Product } from '@/types/production';
import InstructionProductContext from './InstructionProductContext';

vi.mock('@/services/api', () => ({ fetchEffectiveProductBOM: vi.fn(), fetchProduct: vi.fn() }));
beforeEach(() => {
  vi.mocked(fetchProduct).mockImplementation(async id => ({
    ProductID: id, ProductModelID: 125, Name: `Wheel ${id}`, ProductNumber: `RW-${id}`, Color: 'Black', Size: null,
  } as Product));
  vi.mocked(fetchEffectiveProductBOM).mockResolvedValue([
    { ComponentID: 401, PerAssemblyQty: 1, UnitMeasureCode: 'EA' } as BillOfMaterials,
  ]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function show(representativeId?: number) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><InstructionProductContext productId={825} modelId={125} representativeId={representativeId} /></MemoryRouter>
  </QueryClientProvider>);
}
it('shows actual variant attributes and a grounded current BOM comparison', async () => {
  show(826);
  expect(await screen.findByText(/component IDs, quantities and units match/)).toBeInTheDocument();
  expect(screen.getByText(/Size: Not specified/)).toHaveTextContent('Colour: Black');
  expect(screen.getByRole('link', { name: 'Component #401' })).toHaveAttribute('href', '/define/products/401');
});
it('does not invent substitutions without representative evidence', async () => {
  show();
  expect(await screen.findByText(/representative product is not recorded/)).toBeInTheDocument();
  expect(screen.queryByText(/units match the representative/)).not.toBeInTheDocument();
});
it('rejects a selected product belonging to another model', async () => {
  vi.mocked(fetchProduct).mockResolvedValue({ ProductID: 825, ProductModelID: 19 } as Product);
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('does not belong to this model');
  expect(fetchEffectiveProductBOM).not.toHaveBeenCalled();
});
it('identifies BOM differences without adapting the shared diagram', async () => {
  vi.mocked(fetchEffectiveProductBOM).mockImplementation(async id => [
    { ComponentID: 401, PerAssemblyQty: id === 825 ? 2 : 1, UnitMeasureCode: 'EA' } as BillOfMaterials,
  ]);
  show(826);
  expect(await screen.findByText(/differ from the representative BOM/)).toHaveTextContent('shared diagram has not been adapted');
});
it('distinguishes evidence failures from an empty BOM', async () => {
  vi.mocked(fetchEffectiveProductBOM).mockRejectedValue(new Error('Forbidden'));
  show(826);
  expect(await screen.findByRole('alert')).toHaveTextContent('evidence could not be loaded');
  expect(screen.queryByText('No effective BOM records are available for this product.')).not.toBeInTheDocument();
});
