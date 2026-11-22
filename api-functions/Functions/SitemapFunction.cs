using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;
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
    private readonly string? _storefrontUrl;

    // Only routes declared in app/src/App.tsx that are public and indexable.
    public static readonly IReadOnlyList<(string Loc, string Priority, string ChangeFreq)> StaticPages =
    [
        ("/", "1.0", "daily"),
        ("/sale", "0.9", "daily"),
        ("/help-me-choose", "0.6", "monthly"),
        ("/faq", "0.5", "monthly"),
        ("/returns", "0.4", "monthly"),
    ];

    public SitemapFunction(ILogger<SitemapFunction> logger, ProductService productService, IConfiguration configuration)
    {
        _logger = logger;
        _productService = productService;
        _storefrontUrl = configuration["APP_URL"];
    }

    /// <summary>
    /// Sitemap URLs must point at the storefront, not the Functions host. APP_URL (the storefront
    /// origin) is preferred; the request origin is only a local-development fallback.
    /// </summary>
    public static string ResolveBaseUrl(string? storefrontUrl, Uri requestUrl)
    {
        if (Uri.TryCreate(storefrontUrl?.Trim(), UriKind.Absolute, out var configured) &&
            (configured.Scheme == Uri.UriSchemeHttps || configured.Scheme == Uri.UriSchemeHttp))
        {
            return configured.GetLeftPart(UriPartial.Authority);
        }

        return requestUrl.GetLeftPart(UriPartial.Authority);
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
            if (string.IsNullOrWhiteSpace(_storefrontUrl))
            {
                _logger.LogWarning("APP_URL is not configured; sitemap URLs fall back to the request origin.");
            }
            var baseUrl = ResolveBaseUrl(_storefrontUrl, req.Url);

            // Get all products from database
            var products = await _productService.GetFinishedGoodsProductsAsync();

            // Create response with XML content type
            var response = req.CreateResponse(HttpStatusCode.OK);
            response.Headers.Add("Content-Type", "application/xml; charset=utf-8");

            // Write XML directly to response stream to avoid memory limits
            await GenerateSitemapXmlAsync(response.Body, baseUrl, products);

            _logger.LogInformation("Sitemap generated successfully with {ProductCount} products", products.Count);
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

    public static async Task GenerateSitemapXmlAsync(Stream outputStream, string baseUrl, List<ProductData> products)
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

    private static async Task AddStaticPagesAsync(XmlWriter xmlWriter, string baseUrl)
    {
        foreach (var page in StaticPages)
        {
            await xmlWriter.WriteStartElementAsync(null, "url", null);
            await xmlWriter.WriteElementStringAsync(null, "loc", null, $"{baseUrl}{page.Loc}");
            await xmlWriter.WriteElementStringAsync(null, "changefreq", null, page.ChangeFreq);
            await xmlWriter.WriteElementStringAsync(null, "priority", null, page.Priority);
            await xmlWriter.WriteEndElementAsync();
        }
    }

    private static async Task AddCategoryPagesAsync(XmlWriter xmlWriter, string baseUrl, List<ProductData> products)
    {
        // CategoryPage parses /category/:categoryId as the numeric ProductCategoryID.
        var categories = products
            .Where(p => p.ProductCategoryID.HasValue)
            .GroupBy(p => p.ProductCategoryID!.Value)
            .Select(g => new
            {
                ProductCategoryID = g.Key,
                LastModified = g.Max(p => p.ModifiedDate)
            })
            .OrderBy(c => c.ProductCategoryID);

        foreach (var category in categories)
        {
            await xmlWriter.WriteStartElementAsync(null, "url", null);

            await xmlWriter.WriteElementStringAsync(null, "loc", null, $"{baseUrl}/category/{category.ProductCategoryID}");
            await xmlWriter.WriteElementStringAsync(null, "lastmod", null, category.LastModified.ToString("yyyy-MM-dd"));
            await xmlWriter.WriteElementStringAsync(null, "changefreq", null, "weekly");
            await xmlWriter.WriteElementStringAsync(null, "priority", null, "0.8");

            await xmlWriter.WriteEndElementAsync();
        }
    }

    private static async Task AddProductPagesAsync(XmlWriter xmlWriter, string baseUrl, List<ProductData> products)
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
}
