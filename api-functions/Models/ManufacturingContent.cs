namespace api_functions.Models;

public sealed record ManufacturingModel(int ProductModelId, string Name, string? Instructions, string? CatalogDescription);
public sealed record ManufacturingVariant(int ProductId, string Name, string ProductNumber, string? Color,
    string? Size, decimal? Weight, string? WeightUnit, string? Category, string? Subcategory);
public sealed record ManufacturingDescription(int DescriptionId, string CultureId, string Description);
public sealed record ManufacturingComponent(int BillOfMaterialsId, int ParentProductId, int ProductId,
    string Name, string ProductNumber, decimal Quantity, string Unit, bool Manufactured);
public sealed record ManufacturingWorkCenter(int LocationId, string Name, decimal CostRate, decimal Availability);
public sealed record ManufacturingRouting(int ProductId, int WorkOrderId, short OperationSequence, int LocationId);
public sealed record ManufacturingGrounding(
    DateTime AsOfUtc, ManufacturingModel Model, ManufacturingVariant Representative,
    IReadOnlyList<ManufacturingVariant> Variants, IReadOnlyList<ManufacturingDescription> Descriptions,
    IReadOnlyList<ManufacturingComponent> Components, IReadOnlyList<ManufacturingComponent> VariantComponents,
    IReadOnlyList<ManufacturingWorkCenter> WorkCenters, IReadOnlyList<ManufacturingRouting> HistoricalRouting,
    IReadOnlyList<int> ExistingIllustrationIds, string InstructionSchema);

public sealed class ManufacturingInstructionDraft
{
    public string Summary { get; set; } = "";
    public List<string> Assumptions { get; set; } = [];
    public List<string> VariantNotes { get; set; } = [];
    public List<ManufacturingDraftLocation> Locations { get; set; } = [];
    public List<ManufacturingDiagramBrief> Diagrams { get; set; } = [];
}

public sealed class ManufacturingDraftLocation
{
    public int LocationId { get; set; }
    public string Introduction { get; set; } = "";
    public decimal SetupHours { get; set; }
    public decimal LaborHours { get; set; }
    public decimal MachineHours { get; set; }
    public decimal LotSize { get; set; }
    public List<ManufacturingDraftStep> Steps { get; set; } = [];
}

public sealed class ManufacturingDraftStep
{
    public List<ManufacturingDraftPart> Parts { get; set; } = [];
}

public sealed class ManufacturingDraftPart
{
    public string Kind { get; set; } = "text";
    public string Text { get; set; } = "";
    public int? ProductId { get; set; }
    public int? DiagramSlot { get; set; }
}

public sealed class ManufacturingDiagramBrief
{
    public int Slot { get; set; }
    public string Title { get; set; } = "";
    public string Purpose { get; set; } = "";
    public string Composition { get; set; } = "";
    public List<ManufacturingDiagramCallout> Callouts { get; set; } = [];
}

public sealed record ManufacturingDiagramCallout(int Number, int ProductId);

public sealed record ManufacturingContentResult(
    string Status, string SourceFingerprint, string AgentId, string? ResponseId,
    ManufacturingGrounding Grounding, ManufacturingInstructionDraft Draft,
    string InstructionsXml, IReadOnlyList<ManufacturingDiagramReservation> DiagramReservations);

public sealed record ManufacturingDiagramReservation(int Slot, int IllustrationId, string FileName);

public sealed record ManufacturingDiagramRequest(ManufacturingContentResult ApprovedDraft, int Slot);
public sealed record ManufacturingDiagramPosition(int Number, double X, double Y);
public sealed record ManufacturingDiagramDraft(string Xaml, IReadOnlyList<ManufacturingDiagramPosition> Callouts);
public sealed record ManufacturingDiagramResult(
    string Status, int ProductModelId, int Slot, int IllustrationId, string FileName,
    string SourceFingerprint, string InstructionsSha256, string? ResponseId,
    string Xaml, string Svg, IReadOnlyList<ManufacturingDiagramPosition> Callouts);

public sealed record ManufacturingProductSubject(int ProductId, string Name, string ProductNumber, string? Color,
    string? Size, decimal? Weight, string? WeightUnit, short DaysToManufacture,
    DateTime SellStartDate, DateTime? SellEndDate, DateTime? DiscontinuedDate);
public sealed record ManufacturingWhereUsed(int ParentProductId, string Name, string ProductNumber,
    int? ProductModelId, string? ProductModelName, decimal Quantity, string Unit);
public sealed record ManufacturingProductDocumentReference(string DocumentNode, string Title, string FileName,
    string FileExtension, string Revision, string? DocumentSummary);
public sealed record ManufacturingProductGrounding(
    DateTime AsOfUtc, ManufacturingProductSubject Product, IReadOnlyList<ManufacturingComponent> Components,
    IReadOnlyList<ManufacturingWhereUsed> WhereUsed, int WhereUsedCount,
    IReadOnlyList<ManufacturingWorkCenter> WorkCenters, IReadOnlyList<ManufacturingRouting> HistoricalRouting,
    string RoutingBasis, IReadOnlyList<ManufacturingProductDocumentReference> ExistingDocuments,
    IReadOnlyList<int> ExistingIllustrationIds, string InstructionSchema);
public sealed record ManufacturingProductContentResult(
    string Status, string SourceFingerprint, string AgentId, string? ResponseId,
    ManufacturingProductGrounding Grounding, ManufacturingInstructionDraft Draft, string InstructionsXml,
    IReadOnlyList<ManufacturingDiagramReservation> DiagramReservations, string DocumentNode);
public sealed record ManufacturingProductDiagramRequest(ManufacturingProductContentResult ApprovedDraft, int Slot);
public sealed record ManufacturingProductDiagramResult(
    string Status, int ProductId, int Slot, int IllustrationId, string FileName,
    string SourceFingerprint, string InstructionsSha256, string? ResponseId,
    string Xaml, string Svg, IReadOnlyList<ManufacturingDiagramPosition> Callouts);
public sealed record ManufacturingProductDocument(
    int ProductId, string DocumentNode, string Title, string FileName, string FileExtension, string Revision,
    int ChangeNumber, byte Status, string? DocumentSummary, DateTime ModifiedDate, bool Generated, string? InstructionsXml);
