import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchActiveBOM, fetchProductInventory, fetchProductsByNumbers } from '@/services/api';
import type { Product, BillOfMaterials, ProductInventory } from '@/types/production';
import ManufacturingComponentLegend from './ManufacturingComponentLegend';

vi.mock('@/services/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/api')>(),
  fetchActiveBOM: vi.fn(), fetchProductInventory: vi.fn(), fetchProductsByNumbers: vi.fn(),
}));
vi.mock('@/lib/generatedManufacturingContent', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/generatedManufacturingContent')>(),
  hasGeneratedPartSheet: (id: number) => id === 401,
}));
const product = { ProductID: 401, ProductNumber: 'HU-8998' } as Product;
beforeEach(() => {
  vi.mocked(fetchProductsByNumbers).mockResolvedValue([product]);
  vi.mocked(fetchActiveBOM).mockResolvedValue([{ ProductAssemblyID: 401, StartDate: '2021-01-01T00:00:00' } as BillOfMaterials]);
  vi.mocked(fetchProductInventory).mockResolvedValue([{ ProductID: 401 } as ProductInventory]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function show(path = '/') {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]}><ManufacturingComponentLegend callouts={[{ number: 2, name: 'HL Hub', productNumber: 'HU-8998' }]} /></MemoryRouter>
  </QueryClientProvider>);
}
it('links real products and available BOM/inventory', async () => {
  show();
  expect(await screen.findByRole('link', { name: 'HL Hub (HU-8998)' })).toHaveAttribute('href', '/define/products/401');
  expect(await screen.findByRole('link', { name: 'BOM' })).toHaveAttribute('href', '/engineer/bom/401');
  expect(await screen.findByRole('link', { name: 'Inventory' })).toHaveAttribute('href', '/receive/inventory/401');
});
it('does not choose ambiguous products', async () => {
  vi.mocked(fetchProductsByNumbers).mockResolvedValue([product, { ...product, ProductID: 400 }]);
  show();
  expect(await screen.findByText('Product match is ambiguous')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
it('keeps names visible for absent products and lookup errors', async () => {
  vi.mocked(fetchProductsByNumbers).mockResolvedValue([]);
  show();
  expect(await screen.findByText('Product unavailable')).toBeInTheDocument();
  expect(screen.getByText('HL Hub (HU-8998)')).toBeInTheDocument();
});
it('reports failed product lookup rather than absence', async () => {
  vi.mocked(fetchProductsByNumbers).mockRejectedValue(new Error('Unavailable'));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Component links could not be loaded');
  expect(screen.queryByText('Product unavailable')).not.toBeInTheDocument();
});
it('omits unsupported inventory and future BOM actions', async () => {
  vi.mocked(fetchActiveBOM).mockResolvedValue([{ ProductAssemblyID: 401, StartDate: '2999-01-01T00:00:00' } as BillOfMaterials]);
  vi.mocked(fetchProductInventory).mockResolvedValue([]);
  show();
  expect(await screen.findByRole('link', { name: 'HL Hub (HU-8998)' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'BOM' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Inventory' })).not.toBeInTheDocument();
});
it('links part sheets except from the same part sheet', async () => {
  show('/define/models/7/instructions');
  expect(await screen.findByRole('link', { name: 'Part sheet' })).toHaveAttribute('href', '/define/parts/401/instructions');
  cleanup();
  show('/define/parts/401/instructions');
  expect(await screen.findByRole('link', { name: 'Inventory' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Part sheet' })).not.toBeInTheDocument();
});
