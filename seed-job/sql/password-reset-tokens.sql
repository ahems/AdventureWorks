-- Storefront password-reset tokens. Azure Functions stores only the SHA-256 hash of each
-- emailed token; Person.Password is not touched until a reset completes. Idempotent.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'Person.PasswordResetToken', N'U') IS NULL
BEGIN
    CREATE TABLE Person.PasswordResetToken
    (
        PasswordResetTokenID int IDENTITY(1, 1) NOT NULL
            CONSTRAINT PK_PasswordResetToken PRIMARY KEY,
        BusinessEntityID int NOT NULL
            CONSTRAINT FK_PasswordResetToken_Person
            REFERENCES Person.Person (BusinessEntityID) ON DELETE CASCADE,
        TokenHash binary(32) NOT NULL
            CONSTRAINT UQ_PasswordResetToken_TokenHash UNIQUE,
        CreatedUtc datetime2 NOT NULL
            CONSTRAINT DF_PasswordResetToken_CreatedUtc DEFAULT (SYSUTCDATETIME()),
        ExpiresUtc datetime2 NOT NULL,
        UsedUtc datetime2 NULL,
        CONSTRAINT CK_PasswordResetToken_Lifetime
            CHECK (ExpiresUtc > CreatedUtc AND ExpiresUtc <= DATEADD(hour, 1, CreatedUtc))
    );
    -- At most one unused token per person.
    CREATE UNIQUE INDEX UX_PasswordResetToken_Active
        ON Person.PasswordResetToken (BusinessEntityID)
        WHERE UsedUtc IS NULL;
END;

IF COL_LENGTH(N'Person.PasswordResetToken', N'TokenHash') <> 32
    OR COL_LENGTH(N'Person.PasswordResetToken', N'UsedUtc') IS NULL
    THROW 51110, 'Password reset token schema is incompatible; refusing to continue.', 1;

COMMIT TRANSACTION;
