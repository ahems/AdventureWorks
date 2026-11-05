import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import AppBreadcrumb from './AppBreadcrumb';

describe('breadcrumb', () => {
  it('places part sheets under their product rather than a missing parts index', () => {
    render(<MemoryRouter initialEntries={['/define/parts/316/instructions']}><AppBreadcrumb /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/define/products');
    expect(screen.getByRole('link', { name: '#316' })).toHaveAttribute('href', '/define/products/316');
    expect(screen.getByText('Part Sheet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'parts' })).not.toBeInTheDocument();
  });
  it('keeps model instruction crumbs unchanged', () => {
    render(<MemoryRouter initialEntries={['/define/models/19/instructions']}><AppBreadcrumb /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '#19' })).toHaveAttribute('href', '/define/models/19');
    expect(screen.getByText('Manufacturing Instructions')).toBeInTheDocument();
  });
});
