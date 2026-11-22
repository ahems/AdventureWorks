using System.Text.RegularExpressions;
using System.Xml.Linq;
using api_functions.Functions;
using api_functions.Models;
using Xunit;

namespace ApiFunctions.Tests;

public sealed class SitemapFunctionTests
{
    private static readonly XNamespace Ns = "http://www.sitemaps.org/schemas/sitemap/0.9";

    [Theory]
    [InlineData("https://shop.example.test", "https://shop.example.test")]
    [InlineData("https://shop.example.test/", "https://shop.example.test")]
    [InlineData(" https://shop.example.test/some/path ", "https://shop.example.test")]
    public void Storefront_origin_wins_over_the_functions_host(string appUrl, string expected) =>
        Assert.Equal(expected, SitemapFunction.ResolveBaseUrl(appUrl, new Uri("https://av-func.azurewebsites.net/api/sitemap.xml")));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a url")]
    [InlineData("ftp://shop.example.test")]
    public void Missing_or_invalid_app_url_falls_back_to_request_origin(string? appUrl) =>
        Assert.Equal("http://localhost:7071",
            SitemapFunction.ResolveBaseUrl(appUrl, new Uri("http://localhost:7071/api/sitemap.xml")));

    [Fact]
    public async Task Categories_use_numeric_ids_once_and_every_path_is_a_storefront_route()
    {
        var products = new List<ProductData>
        {
            new() { ProductID = 771, ProductCategoryID = 1, ProductCategoryName = "Bikes", ModifiedDate = new DateTime(2025, 1, 2) },
            new() { ProductID = 772, ProductCategoryID = 1, ProductCategoryName = "Vélos", ModifiedDate = new DateTime(2025, 3, 4) },
            new() { ProductID = 712, ProductCategoryID = 4, ProductCategoryName = "Accessories & Parts", ModifiedDate = new DateTime(2024, 5, 6) },
            new() { ProductID = 999, ModifiedDate = new DateTime(2024, 1, 1) },
        };
        using var stream = new MemoryStream();
        await SitemapFunction.GenerateSitemapXmlAsync(stream, "https://shop.example.test", products);
        stream.Position = 0;
        var locs = XDocument.Load(stream).Descendants(Ns + "loc").Select(e => e.Value).ToList();

        Assert.All(locs, loc => Assert.StartsWith("https://shop.example.test/", loc));
        Assert.Equal(new[] { "https://shop.example.test/category/1", "https://shop.example.test/category/4" },
            locs.Where(l => l.Contains("/category/")).ToArray());
        Assert.DoesNotContain(locs, l => l.EndsWith("/products") || l.EndsWith("/contact"));

        var routes = StorefrontRoutes();
        foreach (var path in locs.Select(l => new Uri(l).AbsolutePath))
        {
            Assert.True(routes.Any(route => route.IsMatch(path)), $"Sitemap path {path} has no storefront route.");
        }
    }

    private static List<Regex> StorefrontRoutes()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "app/src/App.tsx")))
            directory = directory.Parent;
        var app = File.ReadAllText(Path.Combine(directory!.FullName, "app/src/App.tsx"));
        return Regex.Matches(app, "path=\"(?<p>/[^\"*]*)\"")
            .Select(m => new Regex("^" + Regex.Replace(m.Groups["p"].Value, ":[A-Za-z]+", "[0-9]+") + "$"))
            .ToList();
    }
}
