using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using api_functions.Models;
using api_functions.Services;
using Xunit;

namespace ApiFunctions.Tests;

public class ManufacturingInstructionValidatorTests
{
    internal static string SchemaForTests() => Schema();

    private static string Schema()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "seed-job/sql/AdventureWorks.sql")))
            directory = directory.Parent;
        var sql = File.ReadAllText(Path.Combine(directory!.FullName, "seed-job/sql/AdventureWorks.sql"));
        var start = sql.IndexOf("<xsd:schema targetNamespace=\"http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions\"", StringComparison.Ordinal);
        var end = sql.IndexOf("</xsd:schema>", start, StringComparison.Ordinal) + "</xsd:schema>".Length;
        return sql[start..end].Replace("''", "'");
    }

    internal static ManufacturingGrounding Context() => new(
        new DateTime(2026, 11, 4, 0, 0, 0, DateTimeKind.Utc),
        new(59, "LL Headset", null, null),
        new(805, "LL Headset", "HS-0296", null, null, null, null, "Components", "Headsets"),
        [new(805, "LL Headset", "HS-0296", null, null, null, null, "Components", "Headsets")],
        [new(2001, "en", "Grounded description")],
        [new(1, 805, 4, "Headset Ball Bearings", "BE-2908", 8, "EA", false)],
        [new(1, 805, 4, "Headset Ball Bearings", "BE-2908", 8, "EA", false)],
        [new(50, "Subassembly", 12, 120)], [], [3, 4, 5, 6, 7], Schema());

    internal static ManufacturingInstructionDraft Draft() => new()
    {
        Summary = "Assemble the headset.",
        Assumptions = ["Fictional jig and time estimates."],
        VariantNotes = ["One manufactured variant."],
        Locations = [new()
        {
            LocationId = 50, Introduction = "Fit the supplied parts.", LaborHours = 1, LotSize = 1,
            Steps = [new() { Parts = [
                new() { Kind = "text", Text = "Fit " },
                new() { Kind = "material", ProductId = 4 },
                new() { Kind = "text", Text = ". See illustration " },
                new() { Kind = "diag", DiagramSlot = 1 },
                new() { Kind = "text", Text = "." }
            ] }]
        }],
        Diagrams = [new() { Slot = 1, Title = "Headset fit", Purpose = "Show bearing placement",
            Composition = "An exploded bearing view.", Callouts = [new(1, 4)] }]
    };

    [Fact]
    public void Reserved_illustrations_are_checked_before_inference()
    {
        ManufacturingContentGroundingService.ValidateIllustrationReservations(59, [3, 4, 5]);
        Assert.Throws<ManufacturingEligibilityException>(() =>
            ManufacturingContentGroundingService.ValidateIllustrationReservations(59, [3, 100591]));
    }

    [Fact]
    public void Supplemental_generation_requires_an_original_document_without_figures()
    {
        var model = Context().Model;
        ManufacturingContentGroundingService.ValidateInstructionEligibility(model, false);
        Assert.Throws<ManufacturingEligibilityException>(() =>
            ManufacturingContentGroundingService.ValidateInstructionEligibility(model, true));
        model = model with { Instructions = $"<root xmlns=\"{ManufacturingInstructionValidator.Namespace}\">Original operations.</root>" };
        Assert.Throws<ManufacturingEligibilityException>(() =>
            ManufacturingContentGroundingService.ValidateInstructionEligibility(model, false));
        ManufacturingContentGroundingService.ValidateInstructionEligibility(model, true);
        model = model with { Instructions = ValidateAndBuildForTest() };
        Assert.Throws<ManufacturingEligibilityException>(() =>
            ManufacturingContentGroundingService.ValidateInstructionEligibility(model, true));

        static string ValidateAndBuildForTest() => ManufacturingInstructionValidator.ValidateAndBuild(Draft(), Context());
    }

    [Fact]
    public void Builds_typed_xml_with_canonical_parts_and_stable_references()
    {
        var xml = ManufacturingInstructionValidator.ValidateAndBuild(Draft(), Context());
        var root = XElement.Parse(xml);
        XNamespace ns = ManufacturingInstructionValidator.Namespace;
        Assert.Equal(ns + "root", root.Name);
        Assert.Contains(ManufacturingInstructionValidator.Disclaimer, root.Value);
        Assert.Equal("Headset Ball Bearings (Product Number BE-2908)", root.Descendants(ns + "material").Single().Value);
        Assert.Equal("100591", root.Descendants(ns + "diag").Single().Value);
    }

    [Theory]
    [InlineData("center")]
    [InlineData("part")]
    [InlineData("diagram")]
    [InlineData("callout")]
    [InlineData("negative")]
    [InlineData("missing-component")]
    [InlineData("specification")]
    [InlineData("assumptions")]
    public void Rejects_ungrounded_or_incomplete_drafts(string invalid)
    {
        var draft = Draft();
        switch (invalid)
        {
            case "center": draft.Locations[0].LocationId = 999; break;
            case "part": draft.Locations[0].Steps[0].Parts[1].ProductId = 999; break;
            case "diagram": draft.Locations[0].Steps[0].Parts[3].DiagramSlot = 2; break;
            case "callout": draft.Diagrams[0].Callouts = [new(1, 999)]; break;
            case "negative": draft.Locations[0].MachineHours = -1; break;
            case "missing-component": draft.Locations[0].Steps[0].Parts.RemoveAt(1); break;
            case "specification": draft.Locations[0].Steps[0].Parts[0].Kind = "specs"; break;
            case "assumptions": draft.Assumptions = []; break;
        }
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuild(draft, Context()));
    }

    [Fact]
    public void Rejects_existing_illustration_id_collisions()
    {
        var context = Context() with { ExistingIllustrationIds = [100591] };
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuild(Draft(), context));
    }

    [Fact]
    public void Escapes_generated_text_without_interpreting_it_as_markup()
    {
        var draft = Draft();
        draft.Locations[0].Steps[0].Parts[0].Text = "Check <script>alert('demo')</script> & fit ";
        var xml = ManufacturingInstructionValidator.ValidateAndBuild(draft, Context());
        Assert.Contains("&lt;script&gt;", xml);
        Assert.DoesNotContain(XElement.Parse(xml).Descendants(), e => e.Name.LocalName == "script");
    }

    [Fact]
    public void Detects_bom_cycles_but_allows_shared_subassemblies()
    {
        ManufacturingComponent[] edges = [new(1, 805, 4, "Bearing", "BE-1", 1, "EA", true), new(2, 4, 805, "Headset", "HS-1", 1, "EA", true)];
        Assert.Throws<ManufacturingEligibilityException>(() => ManufacturingContentGroundingService.ValidateBom(edges, 805));
        ManufacturingContentGroundingService.ValidateBom([edges[0]], 805);
    }

    [Fact]
    public void Rejects_unrecognized_fields_or_null_required_values()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ManufacturingInstructionDraft>(
            """{"summary":"test","unexpected":"field"}""", ManufacturingContentAgentService.JsonOptions));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ManufacturingInstructionDraft>(
            """{"summary":null}""", ManufacturingContentAgentService.JsonOptions));
    }

    [Theory]
    [InlineData("locations")]
    [InlineData("diagrams")]
    public void Rejects_null_array_members_as_invalid_drafts(string property)
    {
        var json = JsonSerializer.SerializeToNode(Draft(), ManufacturingContentAgentService.JsonOptions)!;
        json[property] = new JsonArray((JsonNode?)null);
        var draft = json.Deserialize<ManufacturingInstructionDraft>(ManufacturingContentAgentService.JsonOptions)!;
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuild(draft, Context()));
    }

    [Fact]
    public void Rejects_invalid_xml_characters_before_serialization()
    {
        var draft = Draft();
        draft.Summary = "Invalid \u0001 text";
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuild(draft, Context()));
    }

    [Theory]
    [InlineData(0, "EA")]
    [InlineData(-1, "EA")]
    [InlineData(1, "")]
    public void Rejects_invalid_bom_quantities_or_units(int quantity, string unit)
    {
        Assert.Throws<ManufacturingEligibilityException>(() => ManufacturingContentGroundingService.ValidateBom(
            [new(1, 805, 4, "Bearing", "BE-1", quantity, unit, false)], 805));
    }
}
