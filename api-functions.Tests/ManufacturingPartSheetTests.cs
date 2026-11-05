using System.Xml.Linq;
using api_functions.Models;
using api_functions.Services;
using Xunit;

namespace ApiFunctions.Tests;

public class ManufacturingPartSheetTests
{
    private static readonly XNamespace Ns = ManufacturingInstructionValidator.Namespace;

    internal static ManufacturingProductGrounding Context(string routingBasis = "demo-assumption",
        IReadOnlyList<ManufacturingRouting>? routing = null) => new(
        new DateTime(2026, 11, 5, 0, 0, 0, DateTimeKind.Utc),
        new(324, "Chain Stays", "CS-2812", null, null, null, null, 1, new DateTime(2008, 4, 30), null, null),
        [new(10, 324, 485, "Metal Sheet 5", "MS-6061", 1, "EA", false)],
        [new(749, "Road-150 Red, 62", "BK-R93R-62", 25, "Road-150", 1, "EA")], 1,
        [new(10, "Frame Forming", 22.5m, 96), new(20, "Frame Welding", 25, 108), new(50, "Subassembly", 12.25m, 120)],
        routing ?? [], routingBasis, [], [3, 4, 5], ManufacturingInstructionValidatorTests.SchemaForTests());

    internal static ManufacturingInstructionDraft Draft(params int[] locations) => new()
    {
        Summary = "Form chain stays from sheet stock.",
        Assumptions = ["Work centres are demo assumptions."],
        VariantNotes = [],
        Locations = (locations.Length == 0 ? [10] : locations).Select(id => new ManufacturingDraftLocation
        {
            LocationId = id, Introduction = "Form the stays.", LaborHours = 0.5m, LotSize = 10,
            Steps = [new() { Parts = [
                new() { Kind = "text", Text = "Cut " },
                new() { Kind = "material", ProductId = 485 },
                new() { Kind = "text", Text = ". See illustration " },
                new() { Kind = "diag", DiagramSlot = 1 },
                new() { Kind = "text", Text = "." }
            ] }]
        }).ToList(),
        Diagrams = [new() { Slot = 1, Title = "Forming", Purpose = "Show stock and finished stays",
            Composition = "Sheet on the left, formed stays on the right.", Callouts = [new(1, 485), new(2, 324)] }]
    };

    [Fact]
    public void Product_reservations_and_document_node_are_deterministic_and_disjoint_from_models()
    {
        var reservations = ManufacturingInstructionValidator.ProductReservations(999);
        Assert.Equal([2009991, 2009992, 2009993], reservations.Select(r => r.IllustrationId));
        Assert.Equal("illustration-2003241.svg", ManufacturingInstructionValidator.ProductReservations(324)[0].FileName);
        Assert.True(ManufacturingInstructionValidator.Reservations(128).Max(r => r.IllustrationId) < reservations.Min(r => r.IllustrationId) - 1000000);
        Assert.Equal("/900000/324/", ManufacturingInstructionValidator.ProductDocumentNode(324));
    }

    [Fact]
    public void Unrouted_parts_are_labelled_server_side_as_demo_assumptions()
    {
        var xml = XElement.Parse(ManufacturingInstructionValidator.ValidateAndBuildProduct(Draft(10), Context()));
        Assert.StartsWith(ManufacturingInstructionValidator.Disclaimer + " Chain Stays (Product Number CS-2812) part sheet.", xml.Nodes().OfType<XText>().First().Value);
        var location = xml.Element(Ns + "Location")!;
        Assert.Contains(ManufacturingInstructionValidator.UnroutedLocationLabel, location.Nodes().OfType<XText>().First().Value);
        Assert.Equal("2003241", xml.Descendants(Ns + "diag").Single().Value);
        Assert.Equal("Metal Sheet 5 (Product Number MS-6061)", xml.Descendants(Ns + "material").Single().Value);
    }

    [Fact]
    public void Routed_parts_must_follow_historical_routing_in_order()
    {
        var context = Context("historical", [new(324, 7, 1, 50), new(324, 7, 2, 20)]);
        var xml = ManufacturingInstructionValidator.ValidateAndBuildProduct(Draft(50, 20), context);
        Assert.Contains(ManufacturingInstructionValidator.RoutedLocationLabel, xml);
        Assert.DoesNotContain(ManufacturingInstructionValidator.UnroutedLocationLabel, xml);
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuildProduct(Draft(20, 50), context));
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuildProduct(Draft(50), context));
    }

    [Fact]
    public void Part_sheets_reject_unknown_work_centres_missing_materials_and_subject_as_material()
    {
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuildProduct(Draft(60), Context()));
        var draft = Draft();
        draft.Locations[0].Steps[0].Parts[1] = new() { Kind = "material", ProductId = 324 };
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuildProduct(draft, Context()));
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuildProduct(Draft(), Context("unknown")));
        var collision = Context() with { ExistingIllustrationIds = [2003241] };
        Assert.Throws<InvalidDataException>(() => ManufacturingInstructionValidator.ValidateAndBuildProduct(Draft(), collision));
    }

    [Fact]
    public void Approved_part_draft_round_trip_and_freshness_checks()
    {
        var context = Context();
        var draft = Draft();
        var xml = ManufacturingInstructionValidator.ValidateAndBuildProduct(draft, context);
        var fingerprint = ManufacturingContentAgentService.Fingerprint(context);
        var approved = new ManufacturingProductContentResult("draft-awaiting-instruction-review", fingerprint, "agent", null,
            context, draft, xml, ManufacturingInstructionValidator.ProductReservations(324).Take(1).ToArray(), "/900000/324/");
        Assert.Equal("Forming", ManufacturingDiagramService.ValidateApprovedProductDraft(approved, 1).Title);
        Assert.Throws<InvalidDataException>(() => ManufacturingDiagramService.ValidateApprovedProductDraft(approved, 2));
        Assert.Throws<InvalidDataException>(() => ManufacturingDiagramService.ValidateApprovedProductDraft(approved with { DocumentNode = "/900000/325/" }, 1));
        Assert.Throws<InvalidDataException>(() => ManufacturingDiagramService.ValidateApprovedProductDraft(approved with { InstructionsXml = xml + " " }, 1));

        var later = context with
        {
            AsOfUtc = context.AsOfUtc.AddHours(2), HistoricalRouting = [new(324, 99, 1, 10)], RoutingBasis = "historical"
        };
        ManufacturingDiagramService.ValidateFreshProductGrounding(context, later, fingerprint);
        Assert.Throws<ManufacturingEligibilityException>(() => ManufacturingDiagramService.ValidateFreshProductGrounding(
            context, later with { WhereUsedCount = 2 }, fingerprint));
    }
}
