import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLocations, fetchPartDocuments, type ManufacturingPartDocument } from '@/services/api';
import PartInstructions from './PartInstructions';
import blade from '@/data/manufacturing/part-316.json';
import seat from '@/data/manufacturing/part-514.json';

vi.mock('@/services/api', () => ({
  fetchPartDocuments: vi.fn(), fetchLocations: vi.fn(), fetchProductsByNumbers: vi.fn().mockResolvedValue([]),
  fetchActiveBOM: vi.fn().mockResolvedValue([]), fetchProductInventory: vi.fn().mockResolvedValue([]),
}));

function sheet(source: { productId: number; documentNode: string; title: string; sourceInstructions: string }, xml = source.sourceInstructions): ManufacturingPartDocument {
  return {
    productId: source.productId, documentNode: source.documentNode, title: source.title, fileName: 'sheet.xml', fileExtension: '.xml',
    revision: '2', changeNumber: 1, status: 2, documentSummary: null, modifiedDate: '2026-11-05', generated: true, instructionsXml: xml,
  };
}

function show(productId: number, documents: ManufacturingPartDocument[] | Error, embeddedCenter?: number) {
  if (documents instanceof Error) vi.mocked(fetchPartDocuments).mockRejectedValue(documents);
  else vi.mocked(fetchPartDocuments).mockResolvedValue(documents);
  vi.mocked(fetchLocations).mockResolvedValue([]);
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[`/define/parts/${productId}/instructions`]}><Routes>
      <Route path="/define/parts/:id/instructions" element={<PartInstructions embedded={embeddedCenter !== undefined} workCenterId={embeddedCenter} />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('part sheet page', () => {
  it('renders the live sheet with demo-assumption labels, figures, where-used and history', async () => {
    show(316, [sheet(blade)]);
    expect(await screen.findByRole('heading', { name: 'Blade part sheet' })).toBeInTheDocument();
    expect(fetchPartDocuments).toHaveBeenCalledWith(316, expect.anything());
    expect(screen.getAllByText(/Demo assumption - no historical routing/).length).toBeGreaterThan(1);
    expect(screen.getByAltText('Assembly illustration 2003161')).toHaveAttribute('src', '/illustrations/illustration-2003161.svg');
    expect(screen.getByRole('heading', { name: 'Where used' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Document change management history' })).toBeInTheDocument();
    expect(screen.getAllByText(blade.history.documentNumber, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/AI-generated fictional demo instructions/)).not.toBeInTheDocument();
  });
  it('omits the demo-assumption label for historically routed parts and lists original documents', async () => {
    show(514, [sheet(seat), { ...sheet(seat), documentNode: '/1/', title: 'Seat Assembly', fileName: 'Seat Assembly.doc', generated: false, instructionsXml: null }]);
    expect(await screen.findByRole('heading', { name: seat.title })).toBeInTheDocument();
    expect(screen.queryByText(/Demo assumption - no historical routing/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Other linked documents' }).parentElement).toHaveTextContent('Seat Assembly.doc');
  });
  it('ignores bundled metadata when the live XML no longer matches', async () => {
    show(316, [sheet(blade, '<root xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions">Edited<Location LocationID="10"><step>Cut.</step></Location></root>')]);
    expect(await screen.findByText('Edited')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Document change management history' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Demo assumption - no historical routing/)).not.toBeInTheDocument();
  });
  it('filters to the workstation centre when embedded', async () => {
    show(316, [sheet(blade)], 30);
    expect(await screen.findByRole('heading', { name: /Work Center 30/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Work Center 10/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Where used' })).not.toBeInTheDocument();
  });
  it('shows empty and error states', async () => {
    show(400, []);
    expect(await screen.findByText('No part sheet is available for this product yet.')).toBeInTheDocument();
    cleanup();
    show(316, new Error('boom'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the part sheet');
  });
});
