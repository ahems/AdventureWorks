-- Create external user if missing
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '{{IDENTITY_NAME}}')
BEGIN
    PRINT 'Creating external user [{{IDENTITY_NAME}}]';
    CREATE USER [{{IDENTITY_NAME}}] FROM EXTERNAL PROVIDER;
END
ELSE
BEGIN
    PRINT 'User [{{IDENTITY_NAME}}] already exists – skipping create.';
END

-- Set default schema to dbo (required for Azure AD principals to create objects)
-- This resolves the "does not have an associated database user account" error
-- when creating schemas and other database objects
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = '{{IDENTITY_NAME}}' AND (default_schema_name IS NULL OR default_schema_name <> 'dbo'))
BEGIN
    PRINT 'Setting default schema to dbo for [{{IDENTITY_NAME}}]';
    ALTER USER [{{IDENTITY_NAME}}] WITH DEFAULT_SCHEMA = dbo;
END
ELSE
BEGIN
    PRINT 'Default schema already set to dbo for [{{IDENTITY_NAME}}] – skipping.';
END

-- Grant db_owner role for Azure AD principals to bypass ownership restrictions
-- Azure AD principals (especially those seen as group members) have special
-- restrictions on creating database objects and assigning ownership.
-- db_owner role is required for the seed job to create schemas and tables.
IF NOT EXISTS (SELECT 1 FROM sys.database_role_members drm
    JOIN sys.database_principals r ON drm.role_principal_id = r.principal_id
    JOIN sys.database_principals u ON drm.member_principal_id = u.principal_id
    WHERE r.name = 'db_owner' AND u.name = '{{IDENTITY_NAME}}')
BEGIN
    PRINT 'Adding user [{{IDENTITY_NAME}}] to role db_owner';
    ALTER ROLE [db_owner] ADD MEMBER [{{IDENTITY_NAME}}];
END
ELSE PRINT 'User already in role db_owner – skipping.';

-- Note: db_owner includes db_datareader, db_datawriter, and db_ddladmin permissions
-- plus the ability to create and own database objects without AAD restrictions.
