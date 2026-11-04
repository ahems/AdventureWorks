using System.Xml;
using System.Xml.Linq;
using api_functions.Models;
using api_functions.Services;
using Xunit;

namespace ApiFunctions.Tests;

public class ManufacturingDiagramTests
{
    private static ManufacturingDiagramBrief Brief() => new()
    {
        Slot = 1, Title = "Bearing arrangement", Purpose = "Inventory", Composition = "An inventory, not fitting order",
        Callouts = [new(1, 4)]
    };

    private static ManufacturingDiagramDraft Drawing() => new(
        """<Viewbox xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Width="1000" Height="700"><Canvas>""" +
        string.Concat(Enumerable.Range(0, 5).Select(i =>
            $"""<Path Data="M {100 + i * 50},100 L {120 + i * 50},120 L {120 + i * 50},140 Z" Fill="#FFE0E0E0" Stroke="#FF19364D" StrokeThickness="2"/>""")) +
        "</Canvas></Viewbox>", [new(1, 60, 60)]);

    private static ManufacturingContentResult Approved()
    {
        var context = ManufacturingInstructionValidatorTests.Context();
        var draft = ManufacturingInstructionValidatorTests.Draft();
        return new("draft-awaiting-instruction-review", ManufacturingDiagramService.Fingerprint(context),
            "manufacturing-content-agent", "response-1", context, draft,
            ManufacturingInstructionValidator.ValidateAndBuild(draft, context),
            ManufacturingInstructionValidator.Reservations(59).Take(1).ToArray());
    }

    [Fact]
    public void Converts_visible_geometry_and_renders_numbered_callouts_as_paths()
    {
        var (xaml, svg) = ManufacturingDiagramValidator.Convert(Drawing(), Brief());
        var paths = XElement.Parse(svg).Descendants().Where(e => e.Name.LocalName == "path").ToArray();
        Assert.Equal(7, paths.Length);
        Assert.DoesNotContain("TextBlock", xaml);
        Assert.DoesNotContain("<text", svg);
        Assert.Contains("viewBox=\"0 0 1000 700\"", svg);
    }

    [Theory]
    [InlineData("L 120,120", "L 120,120 130,140")]
    [InlineData("L 120,120", "L -1,120")]
    [InlineData("L 120,120", "L 2000,120")]
    [InlineData("L 120,120", "L NaN,120")]
    [InlineData("L 120,120", "l 20,20")]
    [InlineData("L 120,120", "A 10,10 0 0 0 20,20")]
    [InlineData("StrokeThickness=\"2\"", "StrokeThickness=\"0\"")]
    [InlineData("StrokeThickness=\"2\"", "StrokeThickness=\"900\"")]
    [InlineData("Width=\"1000\"", "Width=\"Infinity\"")]
    [InlineData("Fill=\"#FFE0E0E0\"", "Fill=\"red\"")]
    [InlineData("<Canvas>", "<Canvas><TextBlock>oops</TextBlock>")]
    [InlineData("<Canvas>", "<Canvas><Canvas/>")]
    public void Rejects_unsupported_or_out_of_bounds_geometry(string from, string to)
    {
        var drawing = Drawing() with { Xaml = Drawing().Xaml.Replace(from, to) };
        var exception = Record.Exception(() => ManufacturingDiagramValidator.Convert(drawing, Brief()));
        Assert.NotNull(exception);
        Assert.True(exception is InvalidDataException or FormatException);
    }

    [Fact]
    public void Rejects_external_entities()
    {
        var drawing = Drawing() with { Xaml = "<!DOCTYPE Viewbox [<!ENTITY x SYSTEM 'file:///etc/passwd'>]>" + Drawing().Xaml };
        Assert.Throws<XmlException>(() => ManufacturingDiagramValidator.Convert(drawing, Brief()));
    }

    [Fact]
    public void Rejects_empty_or_invisible_shapes()
    {
        var invisible = Drawing() with { Xaml = Drawing().Xaml.Replace("#FFE0E0E0", "#00000000").Replace("#FF19364D", "#00000000") };
        Assert.Throws<InvalidDataException>(() => ManufacturingDiagramValidator.Convert(invisible, Brief()));
        var empty = Drawing() with { Xaml = Drawing().Xaml.Replace("L 120,120 L 120,140", "L 100,100 L 100,100") };
        Assert.Throws<InvalidDataException>(() => ManufacturingDiagramValidator.Convert(empty, Brief()));
    }

    [Fact]
    public void Rejects_missing_duplicate_or_clipped_callouts()
    {
        foreach (var positions in new ManufacturingDiagramPosition[][] {
            [], [new(2, 60, 60)], [new(1, 60, 60), new(1, 80, 80)], [new(1, 5, 5)] })
            Assert.Throws<InvalidDataException>(() => ManufacturingDiagramValidator.Convert(Drawing() with { Callouts = positions }, Brief()));
    }

    [Fact]
    public void Approved_bundle_is_bound_to_source_instructions_and_reservations()
    {
        var approved = Approved();
        Assert.Equal(1, ManufacturingDiagramService.ValidateApprovedDraft(approved, 1).Slot);
        foreach (var changed in new[] {
            approved with { SourceFingerprint = "different" },
            approved with { InstructionsXml = approved.InstructionsXml + " " },
            approved with { DiagramReservations = [new(1, 100592, "illustration-100592.svg")] },
            approved with { Status = "not-approved" } })
            Assert.Throws<InvalidDataException>(() => ManufacturingDiagramService.ValidateApprovedDraft(changed, 1));
    }

    [Fact]
    public void Freshness_ignores_only_clock_and_new_work_orders_not_bom_changes()
    {
        var context = ManufacturingInstructionValidatorTests.Context();
        ManufacturingDiagramService.ValidateFreshGrounding(context,
            context with { AsOfUtc = DateTime.UtcNow, HistoricalRouting = [new(805, 500, 1, 50)] }, ManufacturingDiagramService.Fingerprint(context));
        Assert.Throws<ManufacturingEligibilityException>(() => ManufacturingDiagramService.ValidateFreshGrounding(
            context, context with { Components = [context.Components[0] with { Quantity = 99 }] }, ManufacturingDiagramService.Fingerprint(context)));
        Assert.Throws<ManufacturingEligibilityException>(() => ManufacturingDiagramService.ValidateFreshGrounding(
            context, context with { ExistingIllustrationIds = [100591] }, ManufacturingDiagramService.Fingerprint(context)));
    }

    [Fact]
    public void Freshness_preserves_original_fingerprint_across_client_decimal_normalization()
    {
        var original = ManufacturingInstructionValidatorTests.Context();
        original = original with { Components = [original.Components[0] with { Quantity = 8.00m }] };
        var normalized = original with { Components = [original.Components[0] with { Quantity = 8.0m }] };
        ManufacturingDiagramService.ValidateFreshGrounding(normalized, original, ManufacturingDiagramService.Fingerprint(original));
        Assert.Throws<ManufacturingEligibilityException>(() => ManufacturingDiagramService.ValidateFreshGrounding(
            normalized, original, new string('a', 64)));
    }

    [Fact]
    public void Rejects_edited_invalid_schema_as_invalid_input()
    {
        var approved = Approved();
        approved = approved with { Grounding = approved.Grounding with { InstructionSchema = "<broken" } };
        Assert.Throws<InvalidDataException>(() => ManufacturingDiagramService.ValidateApprovedDraft(approved, 1));
    }
}
