using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using api_functions.Models;
using CultureInfo = System.Globalization.CultureInfo;

namespace api_functions.Services;

public static class ManufacturingDiagramValidator
{
    private static readonly XNamespace Xaml = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private static readonly Regex Token = new(@"[MLCQZ]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)", RegexOptions.CultureInvariant);

    public static (string Xaml, string Svg) Convert(ManufacturingDiagramDraft draft, ManufacturingDiagramBrief brief)
    {
        if (string.IsNullOrWhiteSpace(draft.Xaml) || draft.Xaml.Length > 100000 || draft.Callouts == null ||
            draft.Callouts.Any(c => c == null) ||
            !draft.Callouts.Select(c => c.Number).Order().SequenceEqual(brief.Callouts.Select(c => c.Number).Order()))
            throw new InvalidDataException("Supply bounded XAML and exactly the approved callout numbers.");
        using var reader = XmlReader.Create(new StringReader(draft.Xaml), new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 100000
        });
        var root = XElement.Load(reader);
        if (root.Name != Xaml + "Viewbox" || root.Elements().Count() != 1 || root.Elements().Single().Name != Xaml + "Canvas" ||
            root.Elements().Single().Elements().Any(e => e.Name != Xaml + "Path"))
            throw new InvalidDataException("Generated diagrams require one Viewbox, one Canvas and Path elements only.");
        double Dimension(string name)
        {
            if (!double.TryParse((string?)root.Attribute(name), NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ||
                !double.IsFinite(value) || value is < 400 or > 1600)
                throw new InvalidDataException("Canvas dimensions must be finite and between 400 and 1600.");
            return value;
        }
        var width = Dimension("Width");
        var height = Dimension("Height");
        var paths = root.Descendants(Xaml + "Path").ToArray();
        if (paths.Length is < 5 or > 600)
            throw new InvalidDataException("A diagram requires 5-600 visible geometry paths.");
        foreach (var path in paths)
        {
            if (path.HasElements) throw new InvalidDataException("Generated diagrams must use solid fills, not brush properties.");
            var data = (string?)path.Attribute("Data") ?? "";
            if (Token.Replace(data, "").Any(c => !char.IsWhiteSpace(c) && c != ','))
                throw new InvalidDataException("Use only absolute M, L, C, Q, Z paths and decimal coordinates.");
            var tokens = Token.Matches(data).Select(m => m.Value).ToArray();
            if (tokens.Length < 6 || tokens[0] != "M")
                throw new InvalidDataException("Every path must begin with M and contain drawable geometry.");
            var index = 0;
            var points = new List<(double X, double Y)>();
            while (index < tokens.Length)
            {
                var command = tokens[index++];
                var coordinates = command switch { "M" or "L" => 2, "C" => 6, "Q" => 4, "Z" => 0, _ => -1 };
                if (coordinates < 0 || index + coordinates > tokens.Length)
                    throw new InvalidDataException("Repeat the command before each complete coordinate group.");
                for (var n = 0; n < coordinates; n += 2)
                {
                    if (!double.TryParse(tokens[index++], CultureInfo.InvariantCulture, out var x) ||
                        !double.TryParse(tokens[index++], CultureInfo.InvariantCulture, out var y) ||
                        !double.IsFinite(x) || !double.IsFinite(y) || x < 12 || y < 12 || x > width - 12 || y > height - 12)
                        throw new InvalidDataException("Every path/control point must remain inside the canvas with a 12-unit margin.");
                    points.Add((x, y));
                }
            }
            if (points.Distinct().Count() < 2)
                throw new InvalidDataException("Path geometry is empty or degenerate.");
            var fill = (string?)path.Attribute("Fill");
            var stroke = (string?)path.Attribute("Stroke");
            static bool Visible(string? paint) => paint != null && Regex.IsMatch(paint, "^#[0-9A-Fa-f]{8}$") &&
                int.Parse(paint.Substring(1, 2), NumberStyles.HexNumber) >= 128;
            if (!Visible(fill) && !Visible(stroke))
                throw new InvalidDataException("Every generated path needs a visible fill or stroke.");
            if (stroke != null && (!double.TryParse((string?)path.Attribute("StrokeThickness"), CultureInfo.InvariantCulture, out var thickness) ||
                !double.IsFinite(thickness) || thickness is < 0.5 or > 8))
                throw new InvalidDataException("Stroked paths require a thickness between 0.5 and 8.");
        }
        foreach (var position in draft.Callouts)
        {
            if (!double.IsFinite(position.X) || !double.IsFinite(position.Y) ||
                position.X < 25 || position.Y < 25 || position.X > width - 25 || position.Y > height - 25 ||
                draft.Callouts.Any(other => other.Number != position.Number &&
                    Math.Pow(other.X - position.X, 2) + Math.Pow(other.Y - position.Y, 2) < 1600))
                throw new InvalidDataException("Callouts must be inside the canvas and at least 40 units apart.");
            AddNumber(root.Elements().Single(), position);
        }
        var xaml = root.ToString();
        return (xaml, IllustrationSvgConverter.Convert(xaml));
    }

    private static void AddNumber(XElement canvas, ManufacturingDiagramPosition position)
    {
        string N(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);
        var x = position.X;
        var y = position.Y;
        canvas.Add(new XElement(Xaml + "Path", new XAttribute("Fill", "#FFFFFFFF"),
            new XAttribute("Stroke", "#FF19364D"), new XAttribute("StrokeThickness", 1.5),
            new XAttribute("Data", $"M {N(x - 18)},{N(y)} C {N(x - 18)},{N(y - 24)} {N(x + 18)},{N(y - 24)} {N(x + 18)},{N(y)} C {N(x + 18)},{N(y + 24)} {N(x - 18)},{N(y + 24)} {N(x - 18)},{N(y)} Z")));
        string[] digits = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
        var segments = new Dictionary<char, (int X1, int Y1, int X2, int Y2)>
        {
            ['a'] = (0, 0, 7, 0), ['b'] = (7, 0, 7, 8), ['c'] = (7, 8, 7, 16),
            ['d'] = (0, 16, 7, 16), ['e'] = (0, 8, 0, 16), ['f'] = (0, 0, 0, 8), ['g'] = (0, 8, 7, 8)
        };
        var text = position.Number.ToString(CultureInfo.InvariantCulture);
        for (var i = 0; i < text.Length; i++)
        {
            var left = x - (text.Length * 10 - 3) / 2.0 + i * 10;
            var geometry = string.Join(" ", digits[text[i] - '0'].Select(segment =>
            {
                var s = segments[segment];
                return $"M {N(left + s.X1)},{N(y - 8 + s.Y1)} L {N(left + s.X2)},{N(y - 8 + s.Y2)}";
            }));
            canvas.Add(new XElement(Xaml + "Path", new XAttribute("Data", geometry),
                new XAttribute("Stroke", "#FF19364D"), new XAttribute("StrokeThickness", 2)));
        }
    }
}
