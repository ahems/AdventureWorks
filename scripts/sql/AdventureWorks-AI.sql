-- AdventureWorks AI Enhancements
-- This script applies schema modifications to support AI-enhanced product data

-- Increase ProductDescription.Description column size to accommodate AI-generated content
-- Original: nvarchar(400) - Too small for enhanced descriptions (AI generates ~500+ characters)
-- Updated: nvarchar(2000) - Allows for detailed AI-generated product descriptions

-- Step 1: Drop the dependent indexed view
IF EXISTS (SELECT 1 FROM sys.views WHERE object_id = OBJECT_ID(N'[Production].[vProductAndDescription]'))
BEGIN
    DROP VIEW [Production].[vProductAndDescription];
    PRINT 'Dropped view Production.vProductAndDescription';
END;

GO

-- Step 2: Alter the Description column
ALTER TABLE [Production].[ProductDescription]
ALTER COLUMN [Description] [nvarchar](2000) NOT NULL;

PRINT 'ProductDescription.Description column updated to nvarchar(2000)';

GO

-- Step 3: Recreate the indexed view
CREATE VIEW [Production].[vProductAndDescription] 
WITH SCHEMABINDING 
AS 
-- View (indexed or standard) to display products and product descriptions by language.
SELECT 
    p.[ProductID] 
    ,p.[Name] 
    ,pm.[Name] AS [ProductModel] 
    ,pmx.[CultureID] 
    ,pd.[Description] 
FROM [Production].[Product] p 
    INNER JOIN [Production].[ProductModel] pm 
    ON p.[ProductModelID] = pm.[ProductModelID] 
    INNER JOIN [Production].[ProductModelProductDescriptionCulture] pmx 
    ON pm.[ProductModelID] = pmx.[ProductModelID] 
    INNER JOIN [Production].[ProductDescription] pd 
    ON pmx.[ProductDescriptionID] = pd.[ProductDescriptionID];

GO

-- Step 4: Recreate the clustered index on the view
CREATE UNIQUE CLUSTERED INDEX [IX_vProductAndDescription] ON [Production].[vProductAndDescription]([CultureID], [ProductID]);

GO

PRINT 'Successfully recreated view Production.vProductAndDescription with clustered index';
