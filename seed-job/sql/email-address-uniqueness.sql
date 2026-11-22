-- Sign-in resolves a user by Person.EmailAddress, so an address may belong to only one person.
-- A UNIQUE constraint (SQL error 2627) rather than a unique index (2601) is used so DAB maps a
-- duplicate create/update to HTTP 409. The column's default collation is case-insensitive.
-- Idempotent; refuses to continue if duplicate addresses already exist.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF NOT EXISTS (
    SELECT 1 FROM sys.key_constraints
    WHERE name = N'UQ_EmailAddress_EmailAddress'
      AND parent_object_id = OBJECT_ID(N'Person.EmailAddress'))
BEGIN
    IF EXISTS (
        SELECT EmailAddress FROM Person.EmailAddress WITH (TABLOCKX, HOLDLOCK)
        WHERE EmailAddress IS NOT NULL
        GROUP BY EmailAddress HAVING COUNT(*) > 1)
        THROW 51130, 'Person.EmailAddress contains duplicate addresses; refusing to add the uniqueness constraint.', 1;

    ALTER TABLE Person.EmailAddress
        ADD CONSTRAINT UQ_EmailAddress_EmailAddress UNIQUE (EmailAddress);
END;

COMMIT TRANSACTION;
