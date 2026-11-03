using System.Net;
using System.Text.Json;
using System.Xml;
using api_functions.Services;
using api_functions.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;

namespace api_functions.Functions;

public class ExportManufacturingIllustrations(ProductService products, ILogger<ExportManufacturingIllustrations> logger)
{
    [Function(nameof(ExportManufacturingIllustrations))]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", "post", Route = "manufacturing/illustrations/export")] HttpRequestData req)
    {
        try
        {
            // GET exports the database; POST converts supplied records without changing any data.
            var records = req.Method == "GET"
                ? await products.GetIllustrationsAsync()
                : await JsonSerializer.DeserializeAsync<List<IllustrationSource>>(req.Body, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (records == null || records.Count is < 1 or > 500 ||
                records.Any(r => r == null || r.IllustrationId <= 0 || string.IsNullOrWhiteSpace(r.Diagram)) ||
                records.Select(r => r.IllustrationId).Distinct().Count() != records.Count)
                throw new FormatException("Supply 1-500 illustrations with unique positive IDs and nonempty XAML diagrams.");
            var output = records.OrderBy(r => r.IllustrationId).Select(r => new
            {
                illustrationId = r.IllustrationId,
                fileName = $"illustration-{r.IllustrationId}.svg",
                svg = IllustrationSvgConverter.Convert(r.Diagram)
            }).ToArray();
            logger.LogInformation("Converted {Count} manufacturing illustrations to SVG", output.Length);
            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(new { illustrations = output });
            return response;
        }
        catch (Exception ex) when (ex is FormatException or XmlException or JsonException)
        {
            logger.LogWarning(ex, "Invalid manufacturing illustration export");
            var response = req.CreateResponse(HttpStatusCode.BadRequest);
            await response.WriteStringAsync($"Illustration conversion failed: {ex.Message}");
            return response;
        }
    }
}
