# SEO Implementation Guide

This document outlines the SEO features implemented in the AdventureWorks application.

## ✅ Implemented Features

### 1. Dynamic XML Sitemap (`/sitemap.xml`)

- **Location**: Azure Functions at `/api/sitemap.xml`
- **Features**:
  - Auto-generated from database (290+ products)
  - Includes static pages (home, products, sale, FAQ, contact)
  - Category pages with SEO-friendly slugs
  - Product detail pages with last modified dates
  - Proper XML namespace and structure
  - Updates automatically as products change
- **Usage**: Search engines discover all pages via `https://yourdomain.com/sitemap.xml`

### 2. Robots.txt

- **Location**: `/public/robots.txt`
- **Features**:
  - Allows all major search engines (Google, Bing, Twitter, Facebook)
  - References sitemap.xml for crawler discovery
  - Includes crawl-delay directive
- **Deployment**: Automatically updated via template with correct sitemap URL

### 3. Meta Tags (index.html)

- ✅ Page title with branding
- ✅ Meta description (155 characters)
- ✅ Canonical URL to prevent duplicate content
- ✅ Viewport meta for mobile optimization
- ✅ Keywords meta tag
- ✅ Author information

### 4. Open Graph Tags

- ✅ `og:title` - Appears in social media previews
- ✅ `og:description` - Social media description
- ✅ `og:type` - Content type (website)
- ✅ `og:image` - Social media thumbnail
- ✅ `og:url` - Canonical URL

### 5. Twitter Card Tags

- ✅ `twitter:card` - Large image card format
- ✅ `twitter:site` - Twitter handle
- ✅ `twitter:title` - Twitter-specific title
- ✅ `twitter:description` - Twitter-specific description
- ✅ `twitter:image` - Twitter preview image

### 6. Structured Data (JSON-LD)

- ✅ **Store Schema** - Business information for rich snippets
- ✅ **Product Schema** - Via `generateProductStructuredData()` helper
- ✅ **Breadcrumb Schema** - Via `generateBreadcrumbStructuredData()` helper

### 7. Dynamic SEO Component

- **Location**: `/src/components/SEO.tsx`
- **Usage**:

  ```tsx
  import { SEO, generateProductStructuredData } from "@/components/SEO";

  // In your component
  <SEO
    title="Product Name | Adventure Works"
    description="Product description here"
    image="/images/product.jpg"
    type="product"
    structuredData={generateProductStructuredData({
      name: "Product Name",
      price: 99.99,
      sku: "ABC123",
      availability: "InStock",
    })}
  />;
  ```

### 8. Optimized Images

- **Location**: `/src/components/OptimizedImage.tsx`
- **Features**:
  - Lazy loading (`loading="lazy"`)
  - Async decoding (`decoding="async"`)
  - Blur-up effect during load
  - Proper aspect ratios
  - Mandatory alt text for accessibility
- **Usage**:

  ```tsx
  import { OptimizedImage } from "@/components/OptimizedImage";

  <OptimizedImage
    src="/images/product.jpg"
    alt="Mountain Bike HL Road Frame"
    aspectRatio="4/3"
  />;
  ```

## 🔧 Configuration Files

### Template-Based Config

- **Template**: `app/staticwebapp.config.template.json`
- **Generated**: `app/staticwebapp.config.json` (gitignored)
- **Process**: `scripts/predeploy.sh` generates config with environment-specific URLs
- **Benefit**: Works across all deployments (dev, staging, prod)

### Environment Variables

- `API_FUNCTIONS_URL` - Used to inject correct sitemap redirect URL
- Set automatically by `azd` during deployment

## 📊 SEO Checklist

### Per-Page Optimization

When creating new pages, ensure:

- [ ] Use `<SEO>` component with page-specific title/description
- [ ] Title follows format: "Page Name | Adventure Works"
- [ ] Description is 150-160 characters
- [ ] Use semantic HTML (`<header>`, `<main>`, `<article>`, `<section>`)
- [ ] Proper heading hierarchy (single `<h1>`, then `<h2>`, `<h3>`, etc.)
- [ ] All images use `<OptimizedImage>` with descriptive alt text
- [ ] Links have descriptive anchor text (avoid "click here")

### Product Pages

- [ ] Use `generateProductStructuredData()` for rich snippets
- [ ] Include breadcrumbs with `generateBreadcrumbStructuredData()`
- [ ] Product images have descriptive alt text (e.g., "Mountain Bike HL Road Frame - Black")
- [ ] Price, availability, and SKU are visible
- [ ] Reviews/ratings (if applicable) use Review schema

### Category Pages

- [ ] Unique meta description per category
- [ ] Breadcrumb navigation
- [ ] Proper heading structure
- [ ] Internal links to products and related categories

## 🚀 Performance Best Practices

### Core Web Vitals

1. **LCP (Largest Contentful Paint)**: Use `OptimizedImage` for hero images
2. **FID (First Input Delay)**: Minimize JavaScript execution
3. **CLS (Cumulative Layout Shift)**: Set explicit image dimensions/aspect ratios

### Additional Optimizations

- Minified CSS/JS in production build
- Static Web App edge caching
- Vite code splitting
- React lazy loading for routes

## 🔍 Testing & Validation

### Tools

- **Google Search Console**: Submit sitemap, monitor indexing
- **Bing Webmaster Tools**: Submit sitemap, monitor crawl stats
- **Rich Results Test**: https://search.google.com/test/rich-results
- **PageSpeed Insights**: https://pagespeed.web.dev/
- **Mobile-Friendly Test**: https://search.google.com/test/mobile-friendly

### Manual Checks

```bash
# Verify sitemap
curl https://yourdomain.com/sitemap.xml | head -50

# Verify robots.txt
curl https://yourdomain.com/robots.txt

# Check page metadata
curl -s https://yourdomain.com | grep -E '<title>|<meta.*description'
```

## 📈 Next Steps

1. **Submit to Search Engines**:
   - Google Search Console: https://search.google.com/search-console
   - Bing Webmaster Tools: https://www.bing.com/webmasters

2. **Monitor Performance**:
   - Set up Core Web Vitals monitoring
   - Track keyword rankings
   - Monitor click-through rates (CTR) from search results

3. **Content Optimization**:
   - Write unique descriptions for each product
   - Add customer reviews (schema markup)
   - Create blog content for long-tail keywords
   - Build internal linking structure

4. **Technical Improvements**:
   - Add AMP pages for mobile (optional)
   - Implement image CDN with WebP format
   - Add hreflang tags for international versions
   - Consider implementing Progressive Web App (PWA) features

## 📚 Resources

- [Google Search Central](https://developers.google.com/search)
- [Schema.org Documentation](https://schema.org/)
- [Web.dev SEO Guide](https://web.dev/learn/seo/)
- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci)

## Related docs

- Implementation details for SEO components and helpers: [SEO_COMPONENTS_IMPLEMENTATION.md](SEO_COMPONENTS_IMPLEMENTATION.md)
- Functions that serve SEO-related endpoints (sitemap, OpenAPI, Swagger UI): [../api-functions/README.md](../api-functions/README.md)
- Overall frontend and backend architecture: [../README.md](../README.md)
