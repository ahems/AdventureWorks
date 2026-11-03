using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace api_functions.Services;

public static class IllustrationSvgConverter
{
    private static readonly XNamespace Xaml = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private static readonly XNamespace Svg = "http://www.w3.org/2000/svg";

    public static string Convert(string diagram)
    {
        using var reader = XmlReader.Create(new StringReader(diagram), new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 2_000_000
        });
        var source = XElement.Load(reader);
        if (source.Name != Xaml + "Viewbox")
            throw new FormatException("Expected a XAML Viewbox illustration.");
        var width = Number(source, "Width");
        var height = Number(source, "Height");
        if (width <= 0 || height <= 0)
            throw new FormatException("Illustration dimensions must be positive.");
        var root = new XElement(Svg + "svg",
            new XAttribute("width", width), new XAttribute("height", height),
            new XAttribute("viewBox", $"0 0 {Format(width)} {Format(height)}"),
            new XAttribute("fill", "none"));
        var defs = new XElement(Svg + "defs");
        root.Add(defs);
        var gradientId = 0;
        Draw(source, root);
        if (!defs.HasElements) defs.Remove();
        return root.ToString();

        void Draw(XElement element, XElement parent)
        {
            if (element.Name.Namespace != Xaml)
                throw new FormatException("Unsupported illustration namespace.");
            switch (element.Name.LocalName)
            {
                case "Viewbox":
                case "Canvas":
                    ValidateAttributes(element, "Width", "Height");
                    var group = element == source ? parent : new XElement(Svg + "g");
                    if (group != parent) parent.Add(group);
                    foreach (var child in element.Elements()) Draw(child, group);
                    break;
                case "Path":
                    ValidateAttributes(element, "Data", "Fill", "Stroke", "StrokeThickness", "StrokeMiterLimit", "StrokeDashArray");
                    var data = Required(element, "Data").Trim();
                    var rule = Regex.Match(data, @"^F([01])\s*");
                    var pathData = rule.Success ? data[rule.Length..] : data;
                    if (!Regex.IsMatch(pathData, @"^[MmLlHhVvCcSsQqTtAaZzEe0-9+\-.,\s]+$"))
                        throw new FormatException("Unsupported path geometry.");
                    var path = new XElement(Svg + "path",
                        new XAttribute("d", pathData),
                        new XAttribute("fill-rule", rule.Success && rule.Groups[1].Value == "1" ? "nonzero" : "evenodd"));
                    parent.Add(path);
                    foreach (var (input, output) in new[] { ("StrokeThickness", "stroke-width"), ("StrokeMiterLimit", "stroke-miterlimit") })
                        if (element.Attribute(input) != null) path.SetAttributeValue(output, Number(element, input));
                    foreach (var (input, output) in new[] { ("Fill", "fill"), ("Stroke", "stroke") })
                        if (element.Attribute(input) is { } paint) Paint(path, output, paint.Value);
                    if (element.Attribute("StrokeDashArray") is { } dash)
                    {
                        var thickness = element.Attribute("StrokeThickness") == null ? 1 : Number(element, "StrokeThickness");
                        path.SetAttributeValue("stroke-dasharray", string.Join(" ", Numbers(dash.Value).Select(n => Format(n * thickness))));
                    }
                    foreach (var child in element.Elements())
                    {
                        if (child.Name != Xaml + "Path.Fill" || child.Elements().Count() != 1)
                            throw new FormatException("Unsupported path property.");
                        ValidateAttributes(child);
                        path.SetAttributeValue("fill", Gradient(child.Elements().Single()));
                    }
                    break;
                default:
                    throw new FormatException($"Unsupported illustration element: {element.Name.LocalName}.");
            }
        }

        string Gradient(XElement brush)
        {
            var name = brush.Name.LocalName;
            if (brush.Name.Namespace != Xaml || name is not ("LinearGradientBrush" or "RadialGradientBrush"))
                throw new FormatException("Unsupported illustration brush.");
            var id = $"gradient-{++gradientId}";
            var mapping = (string?)brush.Attribute("MappingMode") ?? "RelativeToBoundingBox";
            if (mapping is not ("Absolute" or "RelativeToBoundingBox"))
                throw new FormatException("Unsupported gradient mapping.");
            var gradient = new XElement(Svg + (name == "LinearGradientBrush" ? "linearGradient" : "radialGradient"),
                new XAttribute("id", id),
                new XAttribute("gradientUnits", mapping == "Absolute" ? "userSpaceOnUse" : "objectBoundingBox"));
            defs.Add(gradient);
            if (name == "LinearGradientBrush")
            {
                ValidateAttributes(brush, "MappingMode", "StartPoint", "EndPoint");
                Point(brush, "StartPoint", gradient, "x1", "y1");
                Point(brush, "EndPoint", gradient, "x2", "y2");
            }
            else
            {
                ValidateAttributes(brush, "MappingMode", "Center", "GradientOrigin", "RadiusX", "RadiusY");
                Point(brush, "Center", gradient, "cx", "cy");
                Point(brush, "GradientOrigin", gradient, "fx", "fy");
                var radius = Number(brush, "RadiusX");
                if (radius <= 0 || radius != Number(brush, "RadiusY"))
                    throw new FormatException("Only circular radial gradients are supported.");
                gradient.SetAttributeValue("r", radius);
            }
            foreach (var child in brush.Elements())
            {
                ValidateAttributes(child);
                if (child.Name == Xaml + (name + ".GradientStops"))
                {
                    foreach (var stop in child.Elements())
                    {
                        if (stop.Name != Xaml + "GradientStop")
                            throw new FormatException("Unsupported gradient stop.");
                        ValidateAttributes(stop, "Offset", "Color");
                        var offset = Number(stop, "Offset");
                        if (offset < 0 || offset > 1) throw new FormatException("Gradient offset must be between zero and one.");
                        var output = new XElement(Svg + "stop", new XAttribute("offset", offset));
                        Paint(output, "stop-color", Required(stop, "Color"));
                        gradient.Add(output);
                    }
                }
                else if (child.Name == Xaml + (name + ".Transform"))
                {
                    if (child.Elements().Count() != 1)
                        throw new FormatException("Expected one gradient transform.");
                    var transform = child.Elements().Single();
                    if (transform == null || transform.Name != Xaml + "MatrixTransform")
                        throw new FormatException("Unsupported gradient transform.");
                    ValidateAttributes(transform, "Matrix");
                    var matrix = Numbers(Required(transform, "Matrix"));
                    if (matrix.Length != 6) throw new FormatException("Expected six matrix values.");
                    gradient.SetAttributeValue("gradientTransform", $"matrix({string.Join(" ", matrix.Select(Format))})");
                }
                else throw new FormatException("Unsupported gradient property.");
            }
            return $"url(#{id})";
        }
    }

    private static string Required(XElement element, string name) =>
        (string?)element.Attribute(name) ?? throw new FormatException($"Missing {name}.");

    private static double Number(XElement element, string name) => Parse(Required(element, name));

    private static double Parse(string value)
    {
        if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number))
            throw new FormatException("Invalid illustration numeric value.");
        return number;
    }

    private static string Format(double number) => number.ToString("R", CultureInfo.InvariantCulture);

    private static double[] Numbers(string value) =>
        Regex.Split(value.Trim(), @"[\s,]+").Select(Parse).ToArray();

    private static void Point(XElement source, string name, XElement target, string x, string y)
    {
        var values = Numbers(Required(source, name));
        if (values.Length != 2) throw new FormatException("Expected two point coordinates.");
        target.SetAttributeValue(x, values[0]);
        target.SetAttributeValue(y, values[1]);
    }

    private static void Paint(XElement target, string name, string color)
    {
        if (!Regex.IsMatch(color, "^#[0-9a-fA-F]{8}$"))
            throw new FormatException("Expected a XAML #AARRGGBB color.");
        target.SetAttributeValue(name, "#" + color[3..]);
        var alpha = int.Parse(color.Substring(1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        if (alpha != 255) target.SetAttributeValue(name == "stop-color" ? "stop-opacity" : name + "-opacity", alpha / 255.0);
    }

    private static void ValidateAttributes(XElement element, params string[] allowed)
    {
        if (element.Attributes().Any(a => !a.IsNamespaceDeclaration && !allowed.Contains(a.Name.ToString(), StringComparer.Ordinal)))
            throw new FormatException($"Unsupported attribute on {element.Name.LocalName}.");
    }
}
