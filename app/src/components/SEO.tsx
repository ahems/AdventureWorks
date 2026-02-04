import { Helmet } from "react-helmet-async";

interface SEOProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: "website" | "article" | "product";
  structuredData?: object | object[];
}

export function SEO({
  title = "Adventure Works | Outdoor Adventure & Sports Gear",
  description = "Premium bikes, components, clothing & accessories for outdoor enthusiasts. Shop mountain bikes, road bikes, cycling gear and more at Adventure Works.",
  image = "/thumbnail.png",
  url = typeof window !== "undefined"
    ? window.location.href
    : "https://adventureworks.com",
  type = "website",
  structuredData,
}: SEOProps) {
  return (
    <Helmet>
      {/* Basic Meta Tags */}
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />

      {/* Open Graph */}
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={type} />
      <meta property="og:image" content={image} />
      <meta property="og:url" content={url} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />

      {/* Structured Data */}
      {structuredData && (
        <>
          {Array.isArray(structuredData) ? (
            structuredData.filter(Boolean).map((data, index) => (
              <script key={index} type="application/ld+json">
                {JSON.stringify(data)}
              </script>
            ))
          ) : (
            <script type="application/ld+json">
              {JSON.stringify(structuredData)}
            </script>
          )}
        </>
      )}
    </Helmet>
  );
}

// Helper to generate product structured data
export function generateProductStructuredData(product: {
  name: string;
  description?: string;
  image?: string;
  price: number;
  sku: string;
  availability: "InStock" | "OutOfStock";
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description || "",
    image: product.image || "",
    sku: product.sku,
    offers: {
      "@type": "Offer",
      price: product.price,
      priceCurrency: "USD",
      availability: `https://schema.org/${product.availability}`,
    },
  };
}

// Helper to generate breadcrumb structured data
export function generateBreadcrumbStructuredData(
  items: Array<{ name: string; url: string }>
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}
