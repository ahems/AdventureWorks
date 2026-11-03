import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProductModel } from '@/services/api';
import ManufacturingInstructionsLink from './ManufacturingInstructionsLink';

vi.mock('@/services/api', () => ({ fetchProductModel: vi.fn() }));

function show(modelId: number | null, locationId?: number) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><ManufacturingInstructionsLink modelId={modelId} locationId={locationId} /></MemoryRouter>
  </QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe('manufacturing instruction entry points', () => {
  it('links to the current work center when instructions exist', async () => {
    vi.mocked(fetchProductModel).mockResolvedValue({
      ProductModelID: 67, Name: 'Saddle', CatalogDescription: null, Instructions: 'Assemble saddle.', ModifiedDate: '2026-11-03',
    });
    show(67, 50);
    expect(await screen.findByRole('link')).toHaveAttribute('href', '/define/models/67/instructions#work-center-50');
  });
  it('does not offer a broken instruction link when instructions are absent', async () => {
    vi.mocked(fetchProductModel).mockResolvedValue({
      ProductModelID: 5, Name: 'Frame', CatalogDescription: null, Instructions: null, ModifiedDate: '2026-11-03',
    });
    show(5);
    expect(await screen.findByText('No manufacturing instructions available')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('does not query an unassigned model', () => {
    show(null);
    expect(screen.getByText('No product model assigned')).toBeInTheDocument();
    expect(fetchProductModel).not.toHaveBeenCalled();
  });
  it('distinguishes API failures from absent instructions', async () => {
    vi.mocked(fetchProductModel).mockRejectedValue(new Error('Unavailable'));
    show(67);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.queryByText('No manufacturing instructions available')).not.toBeInTheDocument();
  });
});
