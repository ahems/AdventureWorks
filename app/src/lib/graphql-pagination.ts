// DAB list queries return one page at a time (default 100 rows). Fetchers that
// need a complete list must follow `hasNextPage` / `endCursor` instead of
// relying on a single large `first:` value.

export const DAB_PAGE_SIZE = 500;
const MAX_PAGES = 200;

export interface Connection<T> {
  items: T[];
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

export interface PageVariables {
  first: number;
  after: string | null;
}

export async function fetchAllPages<T, R>(
  fetchPage: (page: PageVariables) => Promise<R>,
  selectConnection: (response: R) => Connection<T> | null | undefined,
  pageSize: number = DAB_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const connection = selectConnection(await fetchPage({ first: pageSize, after }));
    all.push(...(connection?.items ?? []));

    const next = connection?.hasNextPage ? connection.endCursor : null;
    if (!next) return all;
    if (seen.has(next)) {
      throw new Error("GraphQL pagination returned a repeated cursor");
    }
    seen.add(next);
    after = next;
  }
  throw new Error(`GraphQL pagination exceeded ${MAX_PAGES} pages`);
}
