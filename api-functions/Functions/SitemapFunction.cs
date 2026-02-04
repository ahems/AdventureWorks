using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using api_functions.Services;
using api_functions.Models;
using System.Net;
using System.Text;
using System.Xml;

namespace api_functions.Functions;

public class SitemapFunction
{
    private readonly ILogger<SitemapFunction> _logger;
    private readonly ProductService _productService;

    public SitemapFunction(ILogger<SitemapFunction> logger, ProductService productService)
    {
        _logger = logger;
        _productService = productService;
    }

    /// <summary>
    /// Generate XML sitemap for SEO
    /// Includes all products with their last modified dates
    /// </summary>
    /// <param name="req">HTTP request</param>
    /// <returns>XML sitemap with all products and static pages</returns>
    /// <response code="200">Successfully generated XML sitemap</response>
    /// <response code="500">Internal server error</response>
    [Function("GetSitemap")]
    public async Task<HttpResponseData> GetSitemap(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "sitemap.xml")] HttpRequestData req)
    {
        _logger.LogInformation("GetSitemap function processing request");

        try
        {
            // Get base URL from request - force HTTPS in production
            var scheme = req.Url.Scheme == "http" && req.Url.Port == 80 ? "http" : "https";
            var baseUrl = $"{scheme}://{req.Url.Host}";
            if (!req.Url.IsDefaultPort && req.Url.Port != 80 && req.Url.Port != 443)
            {
                baseUrl += $":{req.Url.Port}";
            }

            // Get all products from database
            var products = await _productService.GetFinishedGoodsProductsAsync();

            // Create response with XML content type
            var response = req.CreateResponse(HttpStatusCode.OK);
            response.Headers.Add("Content-Type", "application/xml; charset=utf-8");

            // Write XML directly to response stream to avoid memory limits
            await GenerateSitemapXmlAsync(response.Body, baseUrl, products);

            _logger.LogInformation($"Sitemap generated successfully with {products.Count} products");
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating sitemap");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while generating the sitemap" });
            return errorResponse;
        }
    }

    private async Task GenerateSitemapXmlAsync(Stream outputStream, string baseUrl, List<ProductData> products)
    {
        var settings = new XmlWriterSettings
        {
            Encoding = Encoding.UTF8,
            Indent = true,
            OmitXmlDeclaration = false,
            Async = true
        };

        await using var xmlWriter = XmlWriter.Create(outputStream, settings);

        // Start XML document
        await xmlWriter.WriteStartDocumentAsync();

        // Start urlset element with namespace
        await xmlWriter.WriteStartElementAsync(null, "urlset", "http://www.sitemaps.org/schemas/sitemap/0.9");

        // Add static pages
        await AddStaticPagesAsync(xmlWriter, baseUrl);

        // Add category pages
        await AddCategoryPagesAsync(xmlWriter, baseUrl, products);

        // Add product pages
        await AddProductPagesAsync(xmlWriter, baseUrl, products);

        // Close urlset
        await xmlWriter.WriteEndElementAsync();
        await xmlWriter.WriteEndDocumentAsync();
        await xmlWriter.FlushAsync();
    }

    private async Task AddStaticPagesAsync(XmlWriter xmlWriter, string baseUrl)
    {
        var staticPages = new[]
        {
            new { Loc = "/", Priority = "1.0", ChangeFreq = "daily" },
            new { Loc = "/products", Priority = "0.9", ChangeFreq = "daily" },
            new { Loc = "/sale", Priority = "0.9", ChangeFreq = "daily" },
            new { Loc = "/faq", Priority = "0.5", ChangeFreq = "monthly" },
            new { Loc = "/contact", Priority = "0.5", ChangeFreq = "monthly" }
        };

        foreach (var page in staticPages)
        {
            await xmlWriter.WriteStartElementAsync(null, "url", null);
            await xmlWriter.WriteElementStringAsync(null, "loc", null, $"{baseUrl}{page.Loc}");
            await xmlWriter.WriteElementStringAsync(null, "changefreq", null, page.ChangeFreq);
            await xmlWriter.WriteElementStringAsync(null, "priority", null, page.Priority);
            await xmlWriter.WriteEndElementAsync();
        }
    }

    private async Task AddCategoryPagesAsync(XmlWriter xmlWriter, string baseUrl, List<ProductData> products)
    {
        // Get unique categories with their latest modified date
        var categories = products
            .Where(p => p.ProductCategoryID.HasValue && !string.IsNullOrEmpty(p.ProductCategoryName))
            .GroupBy(p => new { p.ProductCategoryID, p.ProductCategoryName })
            .Select(g => new
            {
                g.Key.ProductCategoryID,
                g.Key.ProductCategoryName,
                LastModified = g.Max(p => p.ModifiedDate)
            })
            .OrderBy(c => c.ProductCategoryName);

        foreach (var category in categories)
        {
            await xmlWriter.WriteStartElementAsync(null, "url", null);

            // Create SEO-friendly URL slug
            var categorySlug = CreateUrlSlug(category.ProductCategoryName!);
            await xmlWriter.WriteElementStringAsync(null, "loc", null, $"{baseUrl}/category/{categorySlug}");
            await xmlWriter.WriteElementStringAsync(null, "lastmod", null, category.LastModified.ToString("yyyy-MM-dd"));
            await xmlWriter.WriteElementStringAsync(null, "changefreq", null, "weekly");
            await xmlWriter.WriteElementStringAsync(null, "priority", null, "0.8");

            await xmlWriter.WriteEndElementAsync();
        }
    }

    private async Task AddProductPagesAsync(XmlWriter xmlWriter, string baseUrl, List<ProductData> products)
    {
        foreach (var product in products.OrderBy(p => p.ProductID))
        {
            await xmlWriter.WriteStartElementAsync(null, "url", null);

            // Product detail page URL
            await xmlWriter.WriteElementStringAsync(null, "loc", null, $"{baseUrl}/product/{product.ProductID}");

            // Use product's modified date for lastmod
            await xmlWriter.WriteElementStringAsync(null, "lastmod", null, product.ModifiedDate.ToString("yyyy-MM-dd"));
            await xmlWriter.WriteElementStringAsync(null, "changefreq", null, "weekly");
            await xmlWriter.WriteElementStringAsync(null, "priority", null, "0.7");

            await xmlWriter.WriteEndElementAsync();
        }
    }

    private string CreateUrlSlug(string text)
    {
        // Convert to lowercase and replace spaces with hyphens
        return text.ToLowerInvariant()
            .Replace(" ", "-")
            .Replace("&", "and")
            .Replace(",", "")
            .Replace("'", "");
    }
}
