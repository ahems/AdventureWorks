-- Storefront "helpful" review votes: one row per (review, voter). Azure Functions inserts the
-- vote and adjusts Production.ProductReview.HelpfulVotes in the same transaction. Idempotent.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'Production.ProductReviewVote', N'U') IS NULL
BEGIN
    CREATE TABLE Production.ProductReviewVote
    (
        ProductReviewID int NOT NULL
            CONSTRAINT FK_ProductReviewVote_ProductReview
            REFERENCES Production.ProductReview (ProductReviewID) ON DELETE CASCADE,
        BusinessEntityID int NOT NULL
            CONSTRAINT FK_ProductReviewVote_Person
            REFERENCES Person.Person (BusinessEntityID) ON DELETE CASCADE,
        CreatedUtc datetime2 NOT NULL
            CONSTRAINT DF_ProductReviewVote_CreatedUtc DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_ProductReviewVote PRIMARY KEY (ProductReviewID, BusinessEntityID)
    );
END;

IF COL_LENGTH(N'Production.ProductReviewVote', N'ProductReviewID') IS NULL
    OR COL_LENGTH(N'Production.ProductReviewVote', N'BusinessEntityID') IS NULL
    OR COL_LENGTH(N'Production.ProductReviewVote', N'CreatedUtc') IS NULL
    THROW 51120, 'Product review vote schema is incompatible; refusing to continue.', 1;

COMMIT TRANSACTION;
