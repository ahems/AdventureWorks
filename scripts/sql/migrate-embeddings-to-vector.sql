-- Migration script to convert embedding columns from VARBINARY(MAX) to VECTOR type
-- Azure SQL Database now supports native VECTOR type for vector similarity search
-- This enables use of VECTOR_DISTANCE function with proper performance

USE [AdventureWorks];
GO

PRINT 'Starting migration of embedding columns to VECTOR type...';
GO

-- Step 1: Convert ProductDescription.DescriptionEmbedding to VECTOR type
-- text-embedding-3-small produces 1536-dimensional vectors (float32)
PRINT 'Converting ProductDescription.DescriptionEmbedding to VECTOR(1536)...';

-- First check if column exists and has data
IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
           WHERE TABLE_SCHEMA = 'Production' 
           AND TABLE_NAME = 'ProductDescription' 
           AND COLUMN_NAME = 'DescriptionEmbedding')
BEGIN
    -- Create temporary column
    ALTER TABLE [Production].[ProductDescription]
    ADD [DescriptionEmbeddingVector] VECTOR(1536) NULL;
    
    -- Copy data using CAST from VARBINARY to VECTOR
    UPDATE [Production].[ProductDescription]
    SET [DescriptionEmbeddingVector] = CAST([DescriptionEmbedding] AS VECTOR(1536))
    WHERE [DescriptionEmbedding] IS NOT NULL;
    
    -- Drop old column
    ALTER TABLE [Production].[ProductDescription]
    DROP COLUMN [DescriptionEmbedding];
    
    -- Rename new column to original name
    EXEC sp_rename 'Production.ProductDescription.DescriptionEmbeddingVector', 'DescriptionEmbedding', 'COLUMN';
    
    PRINT 'ProductDescription.DescriptionEmbedding converted to VECTOR(1536)';
END
ELSE
BEGIN
    PRINT 'ProductDescription.DescriptionEmbedding column not found - creating as VECTOR(1536)';
    ALTER TABLE [Production].[ProductDescription]
    ADD [DescriptionEmbedding] VECTOR(1536) NULL;
END
GO

-- Step 2: Convert ProductReview.CommentsEmbedding to VECTOR type
PRINT 'Converting ProductReview.CommentsEmbedding to VECTOR(1536)...';

IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
           WHERE TABLE_SCHEMA = 'Production' 
           AND TABLE_NAME = 'ProductReview' 
           AND COLUMN_NAME = 'CommentsEmbedding')
BEGIN
    -- Create temporary column
    ALTER TABLE [Production].[ProductReview]
    ADD [CommentsEmbeddingVector] VECTOR(1536) NULL;
    
    -- Copy data using CAST from VARBINARY to VECTOR
    UPDATE [Production].[ProductReview]
    SET [CommentsEmbeddingVector] = CAST([CommentsEmbedding] AS VECTOR(1536))
    WHERE [CommentsEmbedding] IS NOT NULL;
    
    -- Drop old column
    ALTER TABLE [Production].[ProductReview]
    DROP COLUMN [CommentsEmbedding];
    
    -- Rename new column to original name
    EXEC sp_rename 'Production.ProductReview.CommentsEmbeddingVector', 'CommentsEmbedding', 'COLUMN';
    
    PRINT 'ProductReview.CommentsEmbedding converted to VECTOR(1536)';
END
ELSE
BEGIN
    PRINT 'ProductReview.CommentsEmbedding column not found - creating as VECTOR(1536)';
    ALTER TABLE [Production].[ProductReview]
    ADD [CommentsEmbedding] VECTOR(1536) NULL;
END
GO

-- Step 3: Update the vProductSearch view to use VECTOR type
PRINT 'Updating vProductSearch view...';

IF OBJECT_ID('[Production].[vProductSearch]', 'V') IS NOT NULL
BEGIN
    DROP VIEW [Production].[vProductSearch];
    PRINT 'Dropped existing vProductSearch view';
END

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
LEFT JOIN [Production].[ProductModel] pm ON p.[ProductModelID] = pm.[ProductModelID]
LEFT JOIN [Production].[ProductModelProductDescriptionCulture] pmx ON pm.[ProductModelID] = pmx.[ProductModelID]
LEFT JOIN [Production].[ProductDescription] pd ON pmx.[ProductDescriptionID] = pd.[ProductDescriptionID]
WHERE p.[FinishedGoodsFlag] = 1;

PRINT 'vProductSearch view recreated with VECTOR type';
GO

PRINT 'Migration completed successfully!';
PRINT 'Embedding columns are now VECTOR(1536) type and can be used with VECTOR_DISTANCE function';
GO
