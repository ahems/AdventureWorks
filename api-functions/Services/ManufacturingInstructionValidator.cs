using System.Xml;
using System.Xml.Linq;
using System.Xml.Schema;
using api_functions.Models;

namespace api_functions.Services;

public static class ManufacturingInstructionValidator
{
    public const string Namespace = "http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions";
    public const string Disclaimer = "AI-generated fictional demo instructions. Not validated engineering or safety instructions.";

    public static IReadOnlyList<ManufacturingDiagramReservation> Reservations(int modelId) =>
        Enumerable.Range(1, 3).Select(slot =>
        {
            var id = checked(100000 + modelId * 10 + slot);
            return new ManufacturingDiagramReservation(slot, id, $"illustration-{id}.svg");
        }).ToArray();

    public const string ProductDocumentFolder = "/900000/";
    public const string UnroutedLocationLabel = "Demo assumption: this part has no historical routing, so this existing work centre was assigned for demonstration only.";
    public const string RoutedLocationLabel = "Routing evidence: historical work orders for this part used this work centre.";

    public static IReadOnlyList<ManufacturingDiagramReservation> ProductReservations(int productId) =>
        Enumerable.Range(1, 3).Select(slot =>
        {
            var id = checked(2000000 + productId * 10 + slot);
            return new ManufacturingDiagramReservation(slot, id, $"illustration-{id}.svg");
        }).ToArray();

    public static string ProductDocumentNode(int productId) => $"{ProductDocumentFolder}{productId}/";

    public static string ValidateAndBuild(ManufacturingInstructionDraft draft, ManufacturingGrounding context) =>
        Build(draft, context.Model.Name, context.Representative.ProductId, context.Components, context.Components,
            context.WorkCenters, context.ExistingIllustrationIds, context.InstructionSchema,
            Reservations(context.Model.ProductModelId), requireVariantNotes: true, routing: null, locationLabel: null);

    public static string ValidateAndBuildProduct(ManufacturingInstructionDraft draft, ManufacturingProductGrounding context)
    {
        var product = context.Product;
        var subject = new ManufacturingComponent(0, 0, product.ProductId, product.Name, product.ProductNumber, 1, "EA", true);
        var routed = context.RoutingBasis == "historical";
        if (!routed && context.RoutingBasis != "demo-assumption")
            throw new InvalidDataException("Unknown routing basis.");
        var routing = routed
            ? context.HistoricalRouting.OrderBy(r => r.OperationSequence).Select(r => r.LocationId).Distinct().ToArray()
            : null;
        return Build(draft, $"{product.Name} (Product Number {product.ProductNumber}) part sheet",
            product.ProductId, context.Components, [.. context.Components, subject], context.WorkCenters,
            context.ExistingIllustrationIds, context.InstructionSchema, ProductReservations(product.ProductId),
            requireVariantNotes: false, routing, routed ? RoutedLocationLabel : UnroutedLocationLabel);
    }

    private static string Build(ManufacturingInstructionDraft draft, string title, int rootProductId,
        IReadOnlyList<ManufacturingComponent> components, IReadOnlyList<ManufacturingComponent> calloutComponents,
        IReadOnlyList<ManufacturingWorkCenter> workCenters, IReadOnlyList<int> existingIllustrationIds,
        string instructionSchema, IReadOnlyList<ManufacturingDiagramReservation> reservationList,
        bool requireVariantNotes, IReadOnlyList<int>? routing, string? locationLabel)
    {
        static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidDataException(message);
        }
        static bool Text(string? text)
        {
            if (string.IsNullOrWhiteSpace(text) || text.Length > 8000) return false;
            try { XmlConvert.VerifyXmlChars(text); return true; }
            catch (XmlException) { return false; }
        }
        Require(Text(draft.Summary), "A nonempty bounded summary is required.");
        Require(draft.Assumptions is { Count: > 0 and <= 20 } && draft.Assumptions.All(Text), "Explicit demo assumptions are required.");
        Require(draft.VariantNotes != null && (requireVariantNotes ? draft.VariantNotes.Count > 0 : true) &&
                draft.VariantNotes.Count <= 20 && draft.VariantNotes.All(Text), "Explicit variant notes are required.");
        Require(draft.Locations is { Count: > 0 and <= 10 }, "Supply 1-10 work centers.");
        Require(draft.Diagrams is { Count: > 0 and <= 3 }, "Supply 1-3 diagram briefs.");
        Require(draft.Locations.All(l => l != null && l.Steps != null && l.Steps.All(s => s != null &&
            s.Parts != null && s.Parts.All(p => p != null))), "Instruction sections, steps, and parts cannot be null.");
        Require(draft.Diagrams.All(d => d != null && d.Callouts != null && d.Callouts.All(c => c != null)),
            "Diagram briefs and callouts cannot be null.");
        Require(draft.Locations.Select(l => l.LocationId).Distinct().Count() == draft.Locations.Count, "Work centers must be unique.");
        Require(draft.Diagrams.Select(d => d.Slot).Distinct().Count() == draft.Diagrams.Count, "Diagram slots must be unique.");
        var products = components.GroupBy(c => c.ProductId).ToDictionary(g => g.Key, g => g.First());
        var calloutProducts = calloutComponents.Select(c => c.ProductId).ToHashSet();
        var materialsUsed = new HashSet<int>();
        var diagramsUsed = new HashSet<int>();
        var reservations = reservationList.ToDictionary(r => r.Slot);
        foreach (var diagram in draft.Diagrams)
        {
            Require(diagram.Slot is >= 1 and <= 3 && Text(diagram.Title) && Text(diagram.Purpose) && Text(diagram.Composition),
                "Each diagram requires a slot (1-3), title, purpose, and composition.");
            Require(!existingIllustrationIds.Contains(reservations[diagram.Slot].IllustrationId), "Reserved illustration ID collides with existing data.");
            Require(diagram.Callouts is { Count: > 0 and <= 20 }, "Each diagram requires 1-20 component callouts.");
            Require(diagram.Callouts.Select(c => c.Number).Distinct().Count() == diagram.Callouts.Count, "Callout numbers must be unique.");
            Require(diagram.Callouts.All(c => c.Number > 0 && calloutProducts.Contains(c.ProductId)), "Diagram callouts must identify actual BOM components.");
        }
        XNamespace ns = Namespace;
        if (routing != null)
            Require(draft.Locations.Select(l => l.LocationId).SequenceEqual(routing),
                $"Work centers must follow the historical routing exactly: {string.Join(", ", routing)}.");
        var root = new XElement(ns + "root", Disclaimer + " " + title + ". " + draft.Summary);
        foreach (var location in draft.Locations)
        {
            var center = workCenters.SingleOrDefault(c => c.LocationId == location.LocationId);
            Require(center != null, $"Unknown manufacturing work center {location.LocationId}.");
            Require(Text(location.Introduction), "Every work center needs an introduction.");
            Require(location.SetupHours is >= 0 and <= 100 && location.LaborHours is > 0 and <= 100 &&
                    location.MachineHours is >= 0 and <= 100 && location.LotSize is > 0 and <= 10000,
                "Work-center estimates must be bounded and nonnegative; labor and lot size must be positive.");
            Require(location.Steps is { Count: > 0 and <= 30 }, "Each work center requires 1-30 steps.");
            var element = new XElement(ns + "Location", new XAttribute("LocationID", location.LocationId),
                new XAttribute("SetupHours", location.SetupHours), new XAttribute("LaborHours", location.LaborHours),
                new XAttribute("MachineHours", location.MachineHours), new XAttribute("LotSize", location.LotSize),
                $"Work Center {center!.LocationId} - {center.Name}. {(locationLabel == null ? "" : locationLabel + " ")}Estimates are fictional demo assumptions. {location.Introduction}");
            foreach (var step in location.Steps)
            {
                Require(step.Parts is { Count: > 0 and <= 40 }, "Steps require 1-40 ordered parts.");
                var output = new XElement(ns + "step");
                foreach (var part in step.Parts)
                {
                    switch (part.Kind)
                    {
                        case "text":
                            Require(Text(part.Text) && part.ProductId == null && part.DiagramSlot == null, "Invalid text part.");
                            output.Add(new XText(part.Text));
                            break;
                        case "material":
                            Require(part.ProductId.HasValue && products.ContainsKey(part.ProductId.Value) && part.DiagramSlot == null,
                                $"Unknown material product ID {part.ProductId}.");
                            var material = products[part.ProductId!.Value];
                            materialsUsed.Add(material.ProductId);
                            output.Add(new XElement(ns + "material", $"{material.Name} (Product Number {material.ProductNumber})"));
                            break;
                        case "tool":
                            Require(Text(part.Text) && part.ProductId == null && part.DiagramSlot == null, "Invalid assumed tool.");
                            output.Add(new XElement(ns + "tool", part.Text));
                            break;
                        case "diag":
                            Require(part.DiagramSlot.HasValue && draft.Diagrams.Any(d => d.Slot == part.DiagramSlot) && part.ProductId == null,
                                "A step references an undefined diagram slot.");
                            diagramsUsed.Add(part.DiagramSlot!.Value);
                            output.Add(new XElement(ns + "diag", reservations[part.DiagramSlot.Value].IllustrationId));
                            break;
                        default: throw new InvalidDataException($"Unsupported step part {part.Kind}; invented specifications/blueprints are not accepted.");
                    }
                }
                Require(!string.IsNullOrWhiteSpace(output.Value), "An instruction step is empty.");
                element.Add(output);
            }
            root.Add(element);
        }
        Require(draft.Diagrams.All(d => diagramsUsed.Contains(d.Slot)), "Every diagram brief must be referenced by an instruction step.");
        var directParts = components.Where(c => c.ParentProductId == rootProductId).Select(c => c.ProductId);
        Require(directParts.All(materialsUsed.Contains), "Instructions must account for every direct BOM component of the representative product.");
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2_000_000 };
        var schemas = new XmlSchemaSet { XmlResolver = null };
        using (var schemaReader = XmlReader.Create(new StringReader(instructionSchema), settings))
            schemas.Add(null, schemaReader);
        var document = new XDocument(root);
        document.Validate(schemas, (_, args) => throw new InvalidDataException($"Manufacturing XML schema validation failed: {args.Message}"));
        return root.ToString();
    }
}
