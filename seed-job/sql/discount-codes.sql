-- Storefront checkout discount codes. Azure Functions validates and applies these
-- server-side (POST /api/orders/checkout and /api/orders/checkout/quote); the browser
-- never holds the code list. Idempotent: safe to run on every seed.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'Sales.DiscountCode', N'U') IS NULL
BEGIN
    CREATE TABLE Sales.DiscountCode
    (
        Code nvarchar(32) NOT NULL CONSTRAINT PK_DiscountCode PRIMARY KEY,
        Description nvarchar(255) NOT NULL,
        DiscountType varchar(20) NOT NULL,
        DiscountPct decimal(5, 4) NOT NULL CONSTRAINT DF_DiscountCode_DiscountPct DEFAULT (0),
        IsActive bit NOT NULL CONSTRAINT DF_DiscountCode_IsActive DEFAULT (1),
        StartDate datetime2 NOT NULL CONSTRAINT DF_DiscountCode_StartDate DEFAULT (SYSUTCDATETIME()),
        EndDate datetime2 NULL,
        ModifiedDate datetime2 NOT NULL CONSTRAINT DF_DiscountCode_ModifiedDate DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_DiscountCode_Code CHECK (Code = UPPER(Code) AND LEN(Code) > 0),
        CONSTRAINT CK_DiscountCode_Type CHECK (DiscountType IN ('percent', 'freeshipping')),
        CONSTRAINT CK_DiscountCode_Pct CHECK (
            (DiscountType = 'percent' AND DiscountPct > 0 AND DiscountPct < 1)
            OR (DiscountType = 'freeshipping' AND DiscountPct = 0)),
        CONSTRAINT CK_DiscountCode_Window CHECK (EndDate IS NULL OR EndDate > StartDate)
    );
END;

MERGE Sales.DiscountCode AS target
USING (VALUES
    (N'SAVE10', N'10% off your order', 'percent', CAST(0.10 AS decimal(5, 4))),
    (N'SAVE20', N'20% off your order', 'percent', CAST(0.20 AS decimal(5, 4))),
    (N'FREESHIP', N'Free shipping', 'freeshipping', CAST(0 AS decimal(5, 4))),
    (N'ADVENTURE25', N'25% off your order', 'percent', CAST(0.25 AS decimal(5, 4)))
) AS source (Code, Description, DiscountType, DiscountPct)
ON target.Code = source.Code
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Description, DiscountType, DiscountPct, IsActive, StartDate)
    VALUES (source.Code, source.Description, source.DiscountType, source.DiscountPct, 1, '2000-01-01');

COMMIT TRANSACTION;
