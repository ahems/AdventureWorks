-- =============================================
-- Clear Product Description Embeddings
-- =============================================
-- Purpose: Reset embeddings to allow regeneration with 
--          enhanced variant information
-- 
-- Run this script before triggering the GenerateProductEmbeddings
-- function to regenerate embeddings with product variant data.
-- =============================================

-- Show current embedding statistics
SELECT 
    'Current Statistics' AS Info,
    COUNT(*) as TotalDescriptions,
    SUM(CASE WHEN DescriptionEmbedding IS NOT NULL THEN 1 ELSE 0 END) as WithEmbeddings,
    SUM(CASE WHEN DescriptionEmbedding IS NULL THEN 1 ELSE 0 END) as WithoutEmbeddings
FROM Production.ProductDescription;

-- Clear all product description embeddings
UPDATE Production.ProductDescription
SET DescriptionEmbedding = NULL,
    ModifiedDate = GETDATE()
WHERE DescriptionEmbedding IS NOT NULL;

-- Show updated statistics
SELECT 
    'After Clearing' AS Info,
    COUNT(*) as TotalDescriptions,
    SUM(CASE WHEN DescriptionEmbedding IS NOT NULL THEN 1 ELSE 0 END) as WithEmbeddings,
    SUM(CASE WHEN DescriptionEmbedding IS NULL THEN 1 ELSE 0 END) as WithoutEmbeddings
FROM Production.ProductDescription;

PRINT 'Embeddings cleared successfully!';
PRINT 'Next step: Trigger the GenerateProductEmbeddings Azure Function';
PRINT 'Command: curl -X POST "https://<your-function-url>/api/GenerateProductEmbeddings_HttpStart"';
