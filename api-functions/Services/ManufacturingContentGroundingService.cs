using api_functions.Models;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Configuration;
using System.Xml;
using System.Xml.Linq;

namespace api_functions.Services;

public sealed class ManufacturingContentGroundingService(IConfiguration configuration)
{
    public async Task<string> GetDiagramStyleExampleAsync(CancellationToken cancellationToken)
    {
        await using var connection = new SqlConnection(configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured."));
        var source = await connection.QuerySingleAsync<string>(new CommandDefinition(
            "SELECT CONVERT(nvarchar(max),Diagram) FROM Production.Illustration WHERE IllustrationID=3",
            cancellationToken: cancellationToken));
        using var reader = XmlReader.Create(new StringReader(source), new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2_000_000
        });
        var root = XElement.Load(reader);
        var paths = root.Descendants().Where(e => e.Name.LocalName == "Path" && e.ToString().Length <= 2000).Take(4).ToArray();
        if (paths.Length == 0) throw new InvalidDataException("Original vector style examples are unavailable.");
        return new XElement(root.Name, root.Attributes(),
            new XElement(root.Name.Namespace + "Canvas", paths)).ToString();
    }

    public async Task<string> GetExampleInstructionsAsync(CancellationToken cancellationToken)
    {
        await using var connection = new SqlConnection(configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured."));
        await connection.OpenAsync(cancellationToken);
        var examples = await connection.QueryAsync<string>(new CommandDefinition("""
            SELECT CONVERT(nvarchar(max),Instructions) FROM Production.ProductModel
            WHERE ProductModelID IN (7,67) AND Instructions IS NOT NULL ORDER BY ProductModelID
            """, cancellationToken: cancellationToken));
        var text = string.Join("\n", examples);
        if (text.Length == 0 || text.Length > 25000)
            throw new ManufacturingEligibilityException("Original instruction examples are unavailable or exceed the context limit.");
        return text;
    }

    public static void ValidateInstructionEligibility(ManufacturingModel model, bool supplementExistingInstructions)
    {
        var existing = !string.IsNullOrWhiteSpace(model.Instructions);
        if (existing && !supplementExistingInstructions)
            throw new ManufacturingEligibilityException("The model already has instructions; originals will not be overwritten.");
        if (supplementExistingInstructions)
        {
            if (!existing)
                throw new ManufacturingEligibilityException("Supplemental diagrams require an existing instruction document.");
            using var reader = XmlReader.Create(new StringReader(model.Instructions!), new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2_000_000
            });
            if (XElement.Load(reader).Descendants().Any(e =>
                e.Name == XName.Get("diag", ManufacturingInstructionValidator.Namespace)))
                throw new ManufacturingEligibilityException("The original document already references diagrams; it will be preserved.");
        }
    }

    public async Task<ManufacturingGrounding> GetAsync(int modelId, CancellationToken cancellationToken,
        bool supplementExistingInstructions = false)
    {
        await using var connection = new SqlConnection(configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured."));
        await connection.OpenAsync(cancellationToken);
        async Task<List<T>> Query<T>(string sql, object? parameters = null) =>
            (await connection.QueryAsync<T>(new CommandDefinition(sql, parameters,
                commandTimeout: 30, cancellationToken: cancellationToken))).ToList();

        var model = (await Query<ManufacturingModel>("""
            SELECT ProductModelID AS ProductModelId, Name, CONVERT(nvarchar(max),Instructions) AS Instructions,
                   CONVERT(nvarchar(max),CatalogDescription) AS CatalogDescription
            FROM Production.ProductModel WHERE ProductModelID=@modelId
            """, new { modelId })).SingleOrDefault()
            ?? throw new ManufacturingEligibilityException("The product model does not exist.");
        ValidateInstructionEligibility(model, supplementExistingInstructions);
        var variants = await Query<ManufacturingVariant>("""
            SELECT p.ProductID AS ProductId,p.Name,p.ProductNumber,p.Color,p.Size,p.Weight,
                   RTRIM(p.WeightUnitMeasureCode) AS WeightUnit,c.Name AS Category,s.Name AS Subcategory
            FROM Production.Product p
            LEFT JOIN Production.ProductSubcategory s ON s.ProductSubcategoryID=p.ProductSubcategoryID AND s.CultureID='en'
            LEFT JOIN Production.ProductCategory c ON c.ProductCategoryID=s.ProductCategoryID AND c.CultureID='en'
            WHERE p.ProductModelID=@modelId AND p.MakeFlag=1 ORDER BY p.ProductID
            """, new { modelId });
        if (variants.Count == 0) throw new ManufacturingEligibilityException("The model has no manufactured products.");
        if (variants.Count > 100)
            throw new ManufacturingEligibilityException($"Model {modelId} ({model.Name}) has {variants.Count} manufactured variants, exceeding the 100-variant grounding limit.");
        var descriptions = await Query<ManufacturingDescription>("""
            SELECT d.ProductDescriptionID AS DescriptionId,RTRIM(m.CultureID) AS CultureId,d.Description
            FROM Production.ProductModelProductDescriptionCulture m
            JOIN Production.ProductDescription d ON d.ProductDescriptionID=m.ProductDescriptionID
            WHERE m.ProductModelID=@modelId AND RTRIM(m.CultureID)='en'
            ORDER BY d.ProductDescriptionID
            """, new { modelId });
        if (descriptions.Count == 0 || descriptions.All(d => string.IsNullOrWhiteSpace(d.Description)))
            throw new ManufacturingEligibilityException("No current English description is available for grounding.");
        var asOf = DateTime.UtcNow;
        const string componentSql = """
            SELECT b.BillOfMaterialsID AS BillOfMaterialsId,b.ProductAssemblyID AS ParentProductId,
                   b.ComponentID AS ProductId,p.Name,p.ProductNumber,b.PerAssemblyQty AS Quantity,
                   RTRIM(b.UnitMeasureCode) AS Unit,p.MakeFlag AS Manufactured
            FROM Production.BillOfMaterials b JOIN Production.Product p ON p.ProductID=b.ComponentID
            WHERE b.ProductAssemblyID IN @parents AND b.StartDate<=@asOf AND (b.EndDate IS NULL OR b.EndDate>@asOf)
            ORDER BY b.ProductAssemblyID,b.BillOfMaterialsID
            """;
        var variantComponents = await Query<ManufacturingComponent>(componentSql,
            new { parents = variants.Select(v => v.ProductId).ToArray(), asOf });
        var representative = variants.Where(v => variantComponents.Any(c => c.ParentProductId == v.ProductId))
            .OrderBy(v => v.ProductId).FirstOrDefault()
            ?? throw new ManufacturingEligibilityException("No manufactured variant has an effective bill of materials.");
        var components = new List<ManufacturingComponent>();
        var expanded = new HashSet<int>();
        var frontier = new[] { representative.ProductId };
        for (var depth = 0; frontier.Length > 0; depth++)
        {
            if (depth >= 8) throw new ManufacturingEligibilityException("BOM exceeds the eight-level grounding limit.");
            expanded.UnionWith(frontier);
            var edges = await Query<ManufacturingComponent>(componentSql, new { parents = frontier, asOf });
            components.AddRange(edges);
            if (components.Count + variantComponents.Count > 1500)
                throw new ManufacturingEligibilityException("BOM exceeds the 1500-edge grounding limit; no data was truncated.");
            frontier = edges.Select(e => e.ProductId).Distinct().Where(id => !expanded.Contains(id)).ToArray();
        }
        ValidateBom(components, representative.ProductId);
        var centers = await Query<ManufacturingWorkCenter>("""
            SELECT CONVERT(int,LocationID) AS LocationId,Name,CostRate,Availability FROM Production.Location
            WHERE Availability>0 ORDER BY LocationID
            """);
        if (centers.Count == 0) throw new ManufacturingEligibilityException("No manufacturing work centers are available.");
        var routing = await Query<ManufacturingRouting>("""
            SELECT w.ProductID AS ProductId,r.WorkOrderID AS WorkOrderId,r.OperationSequence,CONVERT(int,r.LocationID) AS LocationId
            FROM Production.WorkOrderRouting r JOIN Production.WorkOrder w ON w.WorkOrderID=r.WorkOrderID
            WHERE w.WorkOrderID=(SELECT MAX(w2.WorkOrderID) FROM Production.WorkOrder w2
                WHERE w2.ProductID=@productId AND EXISTS
                    (SELECT 1 FROM Production.WorkOrderRouting r2 WHERE r2.WorkOrderID=w2.WorkOrderID))
            ORDER BY r.OperationSequence
            """, new { productId = representative.ProductId });
        var illustrationIds = await Query<int>("SELECT IllustrationID FROM Production.Illustration ORDER BY IllustrationID");
        ValidateIllustrationReservations(modelId, illustrationIds);
        var schema = (await Query<string>("SELECT CONVERT(nvarchar(max), XML_SCHEMA_NAMESPACE(N'Production',N'ManuInstructionsSchemaCollection'))")).Single();
        if (string.IsNullOrWhiteSpace(schema)) throw new ManufacturingEligibilityException("The manufacturing XML schema is unavailable.");
        return new(asOf, model, representative, variants, descriptions, components, variantComponents,
            centers, routing, illustrationIds, schema);
    }

    public async Task<ManufacturingProductGrounding> GetProductAsync(int productId, CancellationToken cancellationToken)
    {
        await using var connection = new SqlConnection(configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured."));
        await connection.OpenAsync(cancellationToken);
        async Task<List<T>> Query<T>(string sql, object? parameters = null) =>
            (await connection.QueryAsync<T>(new CommandDefinition(sql, parameters,
                commandTimeout: 30, cancellationToken: cancellationToken))).ToList();

        var product = (await Query<ManufacturingProductSubject>("""
            SELECT ProductID AS ProductId,Name,ProductNumber,Color,Size,Weight,RTRIM(WeightUnitMeasureCode) AS WeightUnit,
                   CONVERT(smallint,DaysToManufacture) AS DaysToManufacture,SellStartDate,SellEndDate,DiscontinuedDate
            FROM Production.Product WHERE ProductID=@productId AND MakeFlag=1 AND ProductModelID IS NULL
            """, new { productId })).SingleOrDefault()
            ?? throw new ManufacturingEligibilityException("Only manufactured parts without a product model are eligible for part sheets.");
        var node = ManufacturingInstructionValidator.ProductDocumentNode(productId);
        var generated = await Query<int>("""
            SELECT COUNT(*) FROM Production.Document WHERE DocumentNode=hierarchyid::Parse(@node)
               OR DocumentNode IN (SELECT DocumentNode FROM Production.ProductDocument WHERE ProductID=@productId
                   AND DocumentNode.IsDescendantOf(hierarchyid::Parse(@folder))=1)
            """, new { node, productId, folder = ManufacturingInstructionValidator.ProductDocumentFolder });
        if (generated.Single() > 0)
            throw new ManufacturingEligibilityException("The part already has a generated sheet; it will not be regenerated or overwritten.");
        var asOf = DateTime.UtcNow;
        const string componentSql = """
            SELECT b.BillOfMaterialsID AS BillOfMaterialsId,b.ProductAssemblyID AS ParentProductId,
                   b.ComponentID AS ProductId,p.Name,p.ProductNumber,b.PerAssemblyQty AS Quantity,
                   RTRIM(b.UnitMeasureCode) AS Unit,p.MakeFlag AS Manufactured
            FROM Production.BillOfMaterials b JOIN Production.Product p ON p.ProductID=b.ComponentID
            WHERE b.ProductAssemblyID IN @parents AND b.StartDate<=@asOf AND (b.EndDate IS NULL OR b.EndDate>@asOf)
            ORDER BY b.ProductAssemblyID,b.BillOfMaterialsID
            """;
        var components = new List<ManufacturingComponent>();
        var expanded = new HashSet<int>();
        var frontier = new[] { productId };
        for (var depth = 0; frontier.Length > 0; depth++)
        {
            if (depth >= 8) throw new ManufacturingEligibilityException("BOM exceeds the eight-level grounding limit.");
            expanded.UnionWith(frontier);
            var edges = await Query<ManufacturingComponent>(componentSql, new { parents = frontier, asOf });
            components.AddRange(edges);
            if (components.Count > 500)
                throw new ManufacturingEligibilityException("BOM exceeds the 500-edge part grounding limit; no data was truncated.");
            frontier = edges.Select(e => e.ProductId).Distinct().Where(id => !expanded.Contains(id)).ToArray();
        }
        if (!components.Any(c => c.ParentProductId == productId))
            throw new ManufacturingEligibilityException("The part has no effective bill of materials.");
        ValidateBom(components, productId);
        const string whereUsedFilter = """
            FROM Production.BillOfMaterials b JOIN Production.Product p ON p.ProductID=b.ProductAssemblyID
            LEFT JOIN Production.ProductModel m ON m.ProductModelID=p.ProductModelID
            WHERE b.ComponentID=@productId AND b.StartDate<=@asOf AND (b.EndDate IS NULL OR b.EndDate>@asOf)
            """;
        var whereUsedCount = (await Query<int>("SELECT COUNT(*) " + whereUsedFilter, new { productId, asOf })).Single();
        var whereUsed = await Query<ManufacturingWhereUsed>($"""
            SELECT TOP 40 b.ProductAssemblyID AS ParentProductId,p.Name,p.ProductNumber,p.ProductModelID AS ProductModelId,
                   m.Name AS ProductModelName,b.PerAssemblyQty AS Quantity,RTRIM(b.UnitMeasureCode) AS Unit
            {whereUsedFilter} ORDER BY b.ProductAssemblyID
            """, new { productId, asOf });
        var centers = await Query<ManufacturingWorkCenter>("""
            SELECT CONVERT(int,LocationID) AS LocationId,Name,CostRate,Availability FROM Production.Location
            WHERE Availability>0 ORDER BY LocationID
            """);
        if (centers.Count == 0) throw new ManufacturingEligibilityException("No manufacturing work centers are available.");
        var routing = await Query<ManufacturingRouting>("""
            SELECT w.ProductID AS ProductId,r.WorkOrderID AS WorkOrderId,r.OperationSequence,CONVERT(int,r.LocationID) AS LocationId
            FROM Production.WorkOrderRouting r JOIN Production.WorkOrder w ON w.WorkOrderID=r.WorkOrderID
            WHERE w.WorkOrderID=(SELECT MAX(w2.WorkOrderID) FROM Production.WorkOrder w2
                WHERE w2.ProductID=@productId AND EXISTS
                    (SELECT 1 FROM Production.WorkOrderRouting r2 WHERE r2.WorkOrderID=w2.WorkOrderID))
            ORDER BY r.OperationSequence
            """, new { productId });
        if (routing.Any(r => centers.All(c => c.LocationId != r.LocationId)))
            throw new ManufacturingEligibilityException("Historical routing references an unavailable work center.");
        var documents = await Query<ManufacturingProductDocumentReference>("""
            SELECT d.DocumentNode.ToString() AS DocumentNode,d.Title,d.FileName,d.FileExtension,d.Revision,d.DocumentSummary
            FROM Production.ProductDocument pd JOIN Production.Document d ON d.DocumentNode=pd.DocumentNode
            WHERE pd.ProductID=@productId ORDER BY d.DocumentNode
            """, new { productId });
        var illustrationIds = await Query<int>("SELECT IllustrationID FROM Production.Illustration ORDER BY IllustrationID");
        if (ManufacturingInstructionValidator.ProductReservations(productId).Any(r => illustrationIds.Contains(r.IllustrationId)))
            throw new ManufacturingEligibilityException("The part's reserved illustrations already exist; published diagrams will not be regenerated or overwritten.");
        var schema = (await Query<string>("SELECT CONVERT(nvarchar(max), XML_SCHEMA_NAMESPACE(N'Production',N'ManuInstructionsSchemaCollection'))")).Single();
        if (string.IsNullOrWhiteSpace(schema)) throw new ManufacturingEligibilityException("The manufacturing XML schema is unavailable.");
        return new(asOf, product, components, whereUsed, whereUsedCount, centers, routing,
            routing.Count > 0 ? "historical" : "demo-assumption", documents, illustrationIds, schema);
    }

    public async Task<IReadOnlyList<ManufacturingProductDocument>> GetProductDocumentsAsync(int productId, CancellationToken cancellationToken)
    {
        await using var connection = new SqlConnection(configuration["SQL_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("SQL_CONNECTION_STRING is not configured."));
        var rows = await connection.QueryAsync<ProductDocumentRow>(
            new CommandDefinition("""
            SELECT pd.ProductID AS ProductId,d.DocumentNode.ToString() AS DocumentNode,d.Title,d.FileName,d.FileExtension,
                   RTRIM(d.Revision) AS Revision,d.ChangeNumber,d.Status,d.DocumentSummary,d.ModifiedDate,
                   CONVERT(bit,d.DocumentNode.IsDescendantOf(hierarchyid::Parse(@folder))) AS Generated,
                   CASE WHEN d.DocumentNode.IsDescendantOf(hierarchyid::Parse(@folder))=1 AND d.FileExtension='.xml'
                        AND DATALENGTH(d.Document)<=2000000 THEN d.Document END AS Document
            FROM Production.ProductDocument pd JOIN Production.Document d ON d.DocumentNode=pd.DocumentNode
            WHERE pd.ProductID=@productId AND d.FolderFlag=0 ORDER BY d.DocumentNode
            """, new { productId, folder = ManufacturingInstructionValidator.ProductDocumentFolder },
            commandTimeout: 30, cancellationToken: cancellationToken));
        return rows.Select(r => new ManufacturingProductDocument(r.ProductId, r.DocumentNode, r.Title, r.FileName,
            r.FileExtension, r.Revision, r.ChangeNumber, r.Status, r.DocumentSummary, r.ModifiedDate, r.Generated,
            r.Document == null ? null : new System.Text.UTF8Encoding(false, true).GetString(r.Document))).ToList();
    }

    public static void ValidateIllustrationReservations(int modelId, IReadOnlyList<int> illustrationIds)
    {
        if (ManufacturingInstructionValidator.Reservations(modelId).Any(r => illustrationIds.Contains(r.IllustrationId)))
            throw new ManufacturingEligibilityException("The model's reserved illustrations already exist; published diagrams will not be regenerated or overwritten.");
    }

    public static void ValidateBom(IReadOnlyList<ManufacturingComponent> components, int rootId)
    {
        var children = components.GroupBy(c => c.ParentProductId).ToDictionary(g => g.Key, g => g.ToList());
        var visiting = new HashSet<int>();
        var visited = new HashSet<int>();
        void Visit(int id)
        {
            if (visiting.Contains(id)) throw new ManufacturingEligibilityException("The effective BOM contains a cycle.");
            if (!visited.Add(id)) return;
            visiting.Add(id);
            if (children.TryGetValue(id, out var edges)) foreach (var edge in edges)
            {
                if (edge.Quantity <= 0 || string.IsNullOrWhiteSpace(edge.Unit))
                    throw new ManufacturingEligibilityException("The BOM contains an invalid quantity or unit.");
                Visit(edge.ProductId);
            }
            visiting.Remove(id);
        }
        Visit(rootId);
    }
}

internal sealed class ProductDocumentRow
{
    public int ProductId { get; set; }
    public string DocumentNode { get; set; } = "";
    public string Title { get; set; } = "";
    public string FileName { get; set; } = "";
    public string FileExtension { get; set; } = "";
    public string Revision { get; set; } = "";
    public int ChangeNumber { get; set; }
    public byte Status { get; set; }
    public string? DocumentSummary { get; set; }
    public DateTime ModifiedDate { get; set; }
    public bool Generated { get; set; }
    public byte[]? Document { get; set; }
}

public sealed class ManufacturingEligibilityException(string message) : Exception(message);
