export interface PagedResult<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string;
}

/**
 * Iterates all cursor-paginated DAB pages and accumulates items.
 * The supplied queryFn should accept a cursor (null = first page) and
 * return items plus pagination metadata.
 */
export async function fetchAllPages<T>(
  queryFn: (after: string | null) => Promise<PagedResult<T>>,
): Promise<T[]> {
  const allItems: T[] = [];
  let after: string | null = null;
  while (true) {
    const result = await queryFn(after);
    allItems.push(...result.items);
    if (!result.hasNextPage) break;
    after = result.endCursor;
  }
  return allItems;
}
