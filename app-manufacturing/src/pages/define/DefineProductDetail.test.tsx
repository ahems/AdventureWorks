import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchProduct } from '@/services/api';
import { fetchCurrentCost } from '@/services/planningApi';
import type { Product } from '@/types/production';
import DefineProductDetail from './DefineProductDetail';

vi.mock('@/services/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/api')>(),
  fetchProduct: vi.fn(),
  fetchProductModel: vi.fn().mockResolvedValue(null),
  fetchProductCategories: vi.fn().mockResolvedValue([]),
  fetchProductSubcategories: vi.fn().mockResolvedValue([]),
  fetchProductModelDescCultures: vi.fn().mockResolvedValue([]),
  fetchProductDescriptions: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/services/planningApi', () => ({ fetchCurrentCost: vi.fn() }));
vi.mock('@/components/ManufacturingInstructionsLink', () => ({ default: () => null }));

const base = { ProductID: 316, Name: 'Blade', ProductNumber: 'BL-2036', StandardCost: 3.9, ListPrice: 0, MakeFlag: true } as Product;
beforeEach(() => {
  vi.mocked(fetchCurrentCost).mockResolvedValue({
    totalManufacturingCost: 10, currentMaterialCost: 8, estimatedRoutingCost: 2, grossMarginPct: 0.2, listPrice: 20,
  } as Awaited<ReturnType<typeof fetchCurrentCost>>);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function show() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/define/products/316']}>
      <Routes><Route path="/define/products/:id" element={<DefineProductDetail />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>);
}

it('does not request a cost roll-up for manufactured sub-assemblies', async () => {
  vi.mocked(fetchProduct).mockResolvedValue({ ...base, FinishedGoodsFlag: false });
  show();
  expect(await screen.findByRole('heading', { name: 'Blade' })).toBeInTheDocument();
  expect(fetchCurrentCost).not.toHaveBeenCalled();
});

it('shows the cost roll-up for manufactured finished goods', async () => {
  vi.mocked(fetchProduct).mockResolvedValue({ ...base, FinishedGoodsFlag: true });
  show();
  expect(await screen.findByText('$10.00')).toBeInTheDocument();
  expect(fetchCurrentCost).toHaveBeenCalledWith(316);
});
