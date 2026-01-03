-- Migration: Drop VARBINARY embedding columns and create VECTOR columns
-- Azure SQL Database native VECTOR type for optimal performance
-- Embeddings will be regenerated after this migration

USE [AdventureWorks];
GO

PRINT 'Starting migration to VECTOR columns...';
GO

-- Step 1: Drop the vProductSearch view (depends on DescriptionEmbedding)
IF OBJECT_ID('[Production].[vProductSearch]', 'V') IS NOT NULL
BEGIN
    DROP VIEW [Production].[vProductSearch];
    PRINT 'Dropped view Production.vProductSearch';
END
GO

-- Step 2: Drop the vReviewSearch view (depends on CommentsEmbedding)
IF OBJECT_ID('[Production].[vReviewSearch]', 'V') IS NOT NULL
BEGIN
    DROP VIEW [Production].[vReviewSearch];
    PRINT 'Dropped view Production.vReviewSearch';
END
GO

-- Step 3: Drop ProductDescription.DescriptionEmbedding (VARBINARY)
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
           WHERE TABLE_SCHEMA = 'Production' 
           AND TABLE_NAME = 'ProductDescription' 
           AND COLUMN_NAME = 'DescriptionEmbedding')
BEGIN
    ALTER TABLE [Production].[ProductDescription]
    DROP COLUMN [DescriptionEmbedding];
    PRINT 'Dropped ProductDescription.DescriptionEmbedding (VARBINARY)';
END
GO

-- Step 4: Create ProductDescription.DescriptionEmbedding (VECTOR)
ALTER TABLE [Production].[ProductDescription]
ADD [DescriptionEmbedding] VECTOR(1536) NULL;
PRINT 'Created ProductDescription.DescriptionEmbedding as VECTOR(1536)';
GO

-- Step 5: Drop ProductReview.CommentsEmbedding (VARBINARY)
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
           WHERE TABLE_SCHEMA = 'Production' 
           AND TABLE_NAME = 'ProductReview' 
           AND COLUMN_NAME = 'CommentsEmbedding')
BEGIN
    ALTER TABLE [Production].[ProductReview]
    DROP COLUMN [CommentsEmbedding];
    PRINT 'Dropped ProductReview.CommentsEmbedding (VARBINARY)';
END
GO

-- Step 6: Create ProductReview.CommentsEmbedding (VECTOR)
ALTER TABLE [Production].[ProductReview]
ADD [CommentsEmbedding] VECTOR(1536) NULL;
PRINT 'Created ProductReview.CommentsEmbedding as VECTOR(1536)';
GO

-- Step 7: Recreate vProductSearch view with VECTOR column
CREATE VIEW [Production].[vProductSearch]
AS
SELECT 
    p.[ProductID],
    p.[Name] AS [ProductName],
    p.[ProductNumber],
    p.[Color],
    p.[Size],
    p.[Weight],
    p.[ListPrice],
    p.[ProductModelID],
    pm.[Name] AS [ProductModelName],
    pmx.[CultureID],
    pmx.[ProductDescriptionID],
    pd.[Description],
    pd.[DescriptionEmbedding],
    p.[ModifiedDate]
FROM [Production].[Product] p
    LEFT JOIN [Production].[ProductModel] pm 
        ON p.[ProductModelID] = pm.[ProductModelID]
    LEFT JOIN [Production].[ProductModelProductDescriptionCulture] pmx 
        ON pm.[ProductModelID] = pmx.[ProductModelID]
    LEFT JOIN [Production].[ProductDescription] pd 
        ON pmx.[ProductDescriptionID] = pd.[ProductDescriptionID]
WHERE p.[FinishedGoodsFlag] = 1;
GO
PRINT 'Recreated view Production.vProductSearch with VECTOR column';
GO

-- Step 8: Recreate vReviewSearch view with VECTOR column
CREATE VIEW [Production].[vReviewSearch]
AS
SELECT 
    pr.[ProductReviewID],
    pr.[ProductID],
    pr.[ReviewerName],
    pr.[ReviewDate],
    pr.[Rating],
    pr.[Comments],
    pr.[CommentsEmbedding],
    pr.[HelpfulVotes],
    pr.[UserID],
    pr.[ModifiedDate],
    p.[Name] AS [ProductName],
    p.[ProductNumber]
FROM [Production].[ProductReview] pr
    INNER JOIN [Production].[Product] p 
        ON pr.[ProductID] = p.[ProductID];
GO
PRINT 'Recreated view Production.vReviewSearch with VECTOR column';
GO

PRINT 'Migration completed! VECTOR columns created successfully.';
PRINT 'Next step: Regenerate embeddings using the embedding generation scripts.';
GO
