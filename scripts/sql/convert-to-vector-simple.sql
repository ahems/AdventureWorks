-- Simple migration to convert VARBINARY embedding columns to VECTOR type
-- This script properly migrates existing data

USE [AdventureWorks];
GO

PRINT 'Converting ProductDescription.DescriptionEmbedding to VECTOR(1536)...';
GO

-- Alter column type directly (Azure SQL supports this)
ALTER TABLE [Production].[ProductDescription]
ALTER COLUMN [DescriptionEmbedding] VECTOR(1536) NULL;
GO

PRINT 'ProductDescription.DescriptionEmbedding converted successfully';
GO

PRINT 'Converting ProductReview.CommentsEmbedding to VECTOR(1536)...';
GO

ALTER TABLE [Production].[ProductReview]
ALTER COLUMN [CommentsEmbedding] VECTOR(1536) NULL;
GO

PRINT 'ProductReview.CommentsEmbedding converted successfully';
GO

PRINT 'All embedding columns converted to VECTOR type!';
GO
