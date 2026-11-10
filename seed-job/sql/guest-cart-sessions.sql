SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'Sales.GuestCartSession', N'U') IS NULL
BEGIN
    CREATE TABLE Sales.GuestCartSession
    (
        CartID varchar(50) NOT NULL CONSTRAINT PK_GuestCartSession PRIMARY KEY,
        TokenHash binary(32) NOT NULL CONSTRAINT UQ_GuestCartSession_TokenHash UNIQUE,
        CreatedUtc datetime2 NOT NULL,
        ExpiresUtc datetime2 NOT NULL,
        RetiredUtc datetime2 NULL,
        MergedBusinessEntityID int NULL,
        CONSTRAINT CK_GuestCartSession_Lifetime
            CHECK (ExpiresUtc > CreatedUtc AND ExpiresUtc <= DATEADD(day, 1, CreatedUtc)),
        CONSTRAINT CK_GuestCartSession_CartID CHECK (CartID LIKE 'guest-%')
    );
    CREATE INDEX IX_GuestCartSession_Expiry ON Sales.GuestCartSession(ExpiresUtc);
END;

IF COL_LENGTH(N'Sales.GuestCartSession', N'TokenHash') <> 32
    OR COL_LENGTH(N'Sales.GuestCartSession', N'MergedBusinessEntityID') IS NULL
    THROW 51100, 'Guest cart session schema is incompatible; refusing to continue.', 1;

COMMIT TRANSACTION;
