/**
 * Check which product(s) the browsing tests use and whether DAB returns
 * product photo / thumbnail data for them (same query shape as the app).
 * Run: npx tsx tests/scripts/check-product-photos-dab.ts
 */
import { testEnv } from "../utils/env";

const graphqlUrl = testEnv.restApiBaseUrl.replace(/\/api\/?$/, "/graphql");

// Same query as app GET_PRODUCT_BY_ID
const GET_PRODUCT_BY_ID = `
  query GetProductById($id: Int!) {
    products(filter: { ProductID: { eq: $id } }) {
      items {
        ProductID
        Name
        productProductPhotos {
          items {
            ProductPhotoID
            Primary
            productPhoto {
              ProductPhotoID
              ThumbNailPhoto
              ThumbnailPhotoFileName
            }
          }
        }
      }
    }
  }
`;

// Seed PNG upload job loads ProductPhoto with IDs 1000+. Base ProductPhoto.csv uses lower IDs.
const PRODUCT_PHOTO_ID_MIN = 1000;

async function getProductIdsWithPhotos(limit: number, useMinPhotoId = true): Promise<number[]> {
  const filterArg = useMinPhotoId
    ? `filter: { ProductPhotoID: { gte: ${PRODUCT_PHOTO_ID_MIN} } }, `
    : "";
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `
        query {
          productProductPhotos(${filterArg}first: 100) {
            items { ProductID }
          }
        }
      `,
    }),
  });
  if (!response.ok) throw new Error(`productProductPhotos failed: ${response.statusText}`);
  const json = (await response.json()) as {
    data?: { productProductPhotos?: { items?: { ProductID: number }[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  const items = json.data?.productProductPhotos?.items ?? [];
  return [...new Set(items.map((i) => i.ProductID))].slice(0, limit);
}

async function getProductPhotoData(productId: number) {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: GET_PRODUCT_BY_ID, variables: { id: productId } }),
  });
  if (!response.ok) throw new Error(`GetProductById failed: ${response.statusText}`);
  const json = (await response.json()) as {
    data?: {
      products?: {
        items?: Array<{
          ProductID: number;
          Name: string;
          productProductPhotos?: {
            items?: Array<{
              ProductPhotoID: number;
              Primary?: boolean;
              productPhoto?: {
                ProductPhotoID: number;
                ThumbNailPhoto: string | null;
                ThumbnailPhotoFileName?: string | null;
              };
            }>;
          };
        }>;
      };
    };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data?.products?.items?.[0];
}

async function main() {
  console.log("DAB URL:", graphqlUrl);
  console.log("");

  const idsUnfiltered = await getProductIdsWithPhotos(10, false);
  console.log("Product IDs (unfiltered, first 10 from productProductPhotos):", idsUnfiltered.join(", "));

  const idsWithPhotos = await getProductIdsWithPhotos(10, true);
  console.log("Product IDs (ProductPhotoID >= " + PRODUCT_PHOTO_ID_MIN + ", matches seed PNG photos):", idsWithPhotos.join(", "));
  console.log("");

  const ids = idsWithPhotos.length > 0 ? idsWithPhotos : idsUnfiltered;
  console.log("Product IDs to check (same query shape as app):", ids.join(", "));
  console.log("");

  // Direct query: are ProductPhoto rows in the seed range (1000+) present with ThumbNailPhoto?
  const samplePhotoId = PRODUCT_PHOTO_ID_MIN;
  const photoRes = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `
        query {
          productPhotos(filter: { ProductPhotoID: { eq: ${samplePhotoId} } }) {
            items { ProductPhotoID ThumbNailPhoto ThumbnailPhotoFileName }
          }
        }
      `,
    }),
  });
  const photoJson = (await photoRes.json()) as any;
  const photoItems = photoJson?.data?.productPhotos?.items ?? [];
  const photoHasThumb = photoItems[0]?.ThumbNailPhoto != null && String(photoItems[0].ThumbNailPhoto).length > 0;
  console.log("ProductPhoto ID " + samplePhotoId + " in DAB:", photoItems.length > 0 ? "found" : "NOT FOUND");
  console.log("  ThumbNailPhoto:", photoHasThumb ? "present" : "null/absent");
  console.log("");

  const results: { id: number; name: string; hasMapping: boolean; hasThumbnail: boolean; photoIds: number[] }[] = [];

  for (const productId of ids) {
    const product = await getProductPhotoData(productId);
    if (!product) {
      results.push({
        id: productId,
        name: "(not found)",
        hasMapping: false,
        hasThumbnail: false,
        photoIds: [],
      });
      continue;
    }
    const mappings = product.productProductPhotos?.items ?? [];
    const photoIds = mappings.map((m) => m.productPhoto?.ProductPhotoID).filter((x): x is number => x != null);
    const hasThumbnail = mappings.some(
      (m) => m.productPhoto?.ThumbNailPhoto != null && String(m.productPhoto.ThumbNailPhoto).length > 0
    );
    results.push({
      id: productId,
      name: product.Name ?? "",
      hasMapping: mappings.length > 0,
      hasThumbnail,
      photoIds,
    });
  }

  console.log("Per-product DAB result (app uses this same query):");
  console.log("─".repeat(80));
  for (const r of results) {
    const thumb = r.hasThumbnail ? "YES" : "NO";
    const mapping = r.hasMapping ? `${r.photoIds.length} photo(s)"` : "no mappings";
    console.log(`  ProductID ${r.id}  "${r.name}"  ThumbNailPhoto in DAB: ${thumb}  productProductPhotos: ${mapping}`);
  }
  console.log("");

  const missingThumb = results.filter((r) => r.hasMapping && !r.hasThumbnail);
  const noMapping = results.filter((r) => !r.hasMapping);
  if (missingThumb.length > 0) {
    console.log("Products WITH productProductPhotos but NO ThumbNailPhoto in DAB (app will show fallback):");
    missingThumb.forEach((r) => console.log(`  - ${r.id}  ${r.name}`));
  }
  if (noMapping.length > 0) {
    console.log("Products with NO productProductPhotos in DAB:");
    noMapping.forEach((r) => console.log(`  - ${r.id}  ${r.name}`));
  }
  if (missingThumb.length === 0 && noMapping.length === 0 && results.some((r) => r.hasThumbnail)) {
    console.log("All checked products have ThumbNailPhoto in DAB. If the app still shows fallback, the issue is likely frontend/API URL or caching.");
  }

  console.log("Summary:");
  if (photoItems.length === 0 || !photoHasThumb) {
    console.log("  Image data is NOT in the database: ProductPhoto rows for IDs " + PRODUCT_PHOTO_ID_MIN + "+ are missing or have no ThumbNailPhoto.");
    console.log("  Fix: ensure the seed job PNG upload (or ProductPhoto load) populates Production.ProductPhoto for the IDs used in product-product-photo mappings.");
  } else {
    console.log("  ProductPhoto " + samplePhotoId + " has ThumbNailPhoto in DAB. If app still shows fallback, check Product->productProductPhotos->productPhoto in GetProductById response.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
