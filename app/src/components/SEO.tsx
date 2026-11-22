import { Helmet } from "react-helmet-async";
import { LANGUAGES } from "@/context/LanguageContext";

// Language is selected client-side (localStorage); `?lang=` lets crawlers and
// shared links request a specific locale, so hreflang alternates use it.
export function buildHreflangAlternates(
  pageUrl: string,
  languageCodes: string[] = LANGUAGES.map((l) => l.code)
): Array<{ hrefLang: string; href: string }> {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  base.hash = "";
  const withLang = (code: string | null) => {
    const u = new URL(base.toString());
    if (code) u.searchParams.set("lang", code);
    else u.searchParams.delete("lang");
    return u.toString();
  };
  return [
    ...languageCodes.map((code) => ({ hrefLang: code, href: withLang(code) })),
    { hrefLang: "x-default", href: withLang(null) },
  ];
}

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
  const alternates = buildHreflangAlternates(url);
  const canonical =
    alternates.find((a) => a.hrefLang === "x-default")?.href ?? url;
  return (
    <Helmet>
      {/* Basic Meta Tags */}
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
      {alternates.map((a) => (
        <link
          key={a.hrefLang}
          rel="alternate"
          hrefLang={a.hrefLang}
          href={a.href}
        />
      ))}

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
  /** ISO 4217 code of `price` (already converted to the active currency). */
  priceCurrency?: string;
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
      price: Number(product.price.toFixed(2)),
      // The app's legacy Turkish lira code TRL is not current ISO 4217.
      priceCurrency:
        product.priceCurrency === "TRL" ? "TRY" : product.priceCurrency || "USD",
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
