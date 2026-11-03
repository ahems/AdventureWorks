import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProductModel, fetchLocations } from '@/services/api';
import ModelInstructions from './ModelInstructions';
import type { ProductModel } from '@/types/production';

vi.mock('@/services/api', () => ({ fetchProductModel: vi.fn(), fetchLocations: vi.fn() }));

const model: ProductModel = {
  ProductModelID: 67, Name: 'HL Touring Seat/Saddle', CatalogDescription: null,
  Instructions: '<root xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions">Original summary<Location LocationID="50" LaborHours="1"><step>See illustration <diag>6</diag>.</step></Location></root>',
  ModifiedDate: '2026-11-03',
};

function show(data: ProductModel | null, error?: Error) {
  if (error) vi.mocked(fetchProductModel).mockRejectedValue(error);
  else vi.mocked(fetchProductModel).mockResolvedValue(data);
  vi.mocked(fetchLocations).mockResolvedValue([]);
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/define/models/67/instructions']}><Routes>
      <Route path="/define/models/:id/instructions" element={<ModelInstructions />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

describe('instruction page', () => {
  it('renders steps and SVG figures with an enlargement dialog', async () => {
    show(model);
    expect(await screen.findByText('Original summary')).toBeInTheDocument();
    const image = screen.getByAltText('Assembly illustration 6');
    expect(image).toHaveAttribute('src', '/illustrations/illustration-6.svg');
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge illustration 6' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
  it('handles models without instructions', async () => {
    show({ ...model, Instructions: null });
    expect(await screen.findByText('No manufacturing instructions are available for this model yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Print' })).not.toBeInTheDocument();
  });
  it('reports invalid XML instead of displaying partial instructions', async () => {
    show({ ...model, Instructions: '<root>' });
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid XML');
  });
  it('reports unavailable images but preserves the step text', async () => {
    show(model);
    fireEvent.error(await screen.findByAltText('Assembly illustration 6'));
    expect(screen.getByRole('alert')).toHaveTextContent('Illustration 6 is unavailable');
    expect(screen.getByText('See illustration', { exact: false })).toBeInTheDocument();
  });
  it('reports database read failures', async () => {
    show(model, new Error('Database unavailable'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Database unavailable'));
  });
});
