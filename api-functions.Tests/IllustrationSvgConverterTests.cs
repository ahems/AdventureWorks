using System.Xml;
using System.Xml.Linq;
using api_functions.Services;
using Xunit;

namespace ApiFunctions.Tests;

public class IllustrationSvgConverterTests
{
    private static string Repo()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !Directory.Exists(Path.Combine(directory.FullName, "seed-job", "sql")))
            directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("Could not locate seed data.");
    }

    [Fact]
    public void All_five_originals_preserve_paths_dimensions_and_gradients()
    {
        XNamespace xaml = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
        XNamespace svg = "http://www.w3.org/2000/svg";
        var records = File.ReadAllText(Path.Combine(Repo(), "seed-job/sql/Illustration.csv"))
            .Split("&|").Where(r => !string.IsNullOrWhiteSpace(r)).ToArray();
        Assert.Equal(5, records.Length);
        foreach (var record in records)
        {
            var diagram = record.Trim().Split("+|")[1];
            var source = XElement.Parse(diagram);
            var output = XElement.Parse(IllustrationSvgConverter.Convert(diagram));
            Assert.Equal(svg + "svg", output.Name);
            Assert.Equal(double.Parse(source.Attribute("Width")!.Value, System.Globalization.CultureInfo.InvariantCulture),
                double.Parse(output.Attribute("width")!.Value, System.Globalization.CultureInfo.InvariantCulture));
            Assert.Equal(double.Parse(source.Attribute("Height")!.Value, System.Globalization.CultureInfo.InvariantCulture),
                double.Parse(output.Attribute("height")!.Value, System.Globalization.CultureInfo.InvariantCulture));
            Assert.Equal(source.Descendants(xaml + "Path").Select(p => p.Attribute("Data")!.Value.Trim()[3..]),
                output.Descendants(svg + "path").Select(p => p.Attribute("d")!.Value));
            Assert.Equal(source.Descendants(xaml + "GradientStop").Count(), output.Descendants(svg + "stop").Count());
            Assert.Equal(source.Descendants(xaml + "LinearGradientBrush").Count(), output.Descendants(svg + "linearGradient").Count());
            Assert.Equal(source.Descendants(xaml + "RadialGradientBrush").Count(), output.Descendants(svg + "radialGradient").Count());
        }
    }

    [Fact]
    public void Converts_alpha_fill_rules_and_thickness_relative_dashes()
    {
        var svg = XElement.Parse(IllustrationSvgConverter.Convert("""
            <Viewbox xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Width="10" Height="10">
              <Canvas><Path Data="F0 M 0,0 L 10,10" Stroke="#800000ff" StrokeThickness="2" StrokeDashArray="1,2" /></Canvas>
            </Viewbox>
            """));
        var path = svg.Descendants().Single(e => e.Name.LocalName == "path");
        Assert.Equal("evenodd", (string?)path.Attribute("fill-rule"));
        Assert.Equal("#0000ff", (string?)path.Attribute("stroke"));
        Assert.Equal("2 4", (string?)path.Attribute("stroke-dasharray"));
        Assert.NotNull(path.Attribute("stroke-opacity"));
    }

    [Theory]
    [InlineData("<svg/>")]
    [InlineData("<Viewbox xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" Width=\"-1\" Height=\"10\"/>")]
    [InlineData("<Viewbox xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" Width=\"10\" Height=\"10\"><Image Source=\"https://example.com\"/></Viewbox>")]
    public void Rejects_unsupported_content(string xml) => Assert.Throws<FormatException>(() => IllustrationSvgConverter.Convert(xml));

    [Fact]
    public void Rejects_external_entities() => Assert.Throws<XmlException>(() => IllustrationSvgConverter.Convert(
        "<!DOCTYPE Viewbox [<!ENTITY ext SYSTEM 'file:///etc/passwd'>]><Viewbox>&ext;</Viewbox>"));
}
