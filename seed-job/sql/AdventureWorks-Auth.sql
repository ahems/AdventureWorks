-- =============================================================================
-- AdventureWorks-Auth.sql
-- Deterministic OAuth authorization seed for the api-mcp self-contained
-- authorization server. Creates the Auth.* catalog that maps:
--
--     AdventureWorks user  ->  application role  ->  OAuth scopes
--
-- Employees are mapped to a role by their CURRENT department
-- (HumanResources.EmployeeDepartmentHistory -> Auth.DepartmentRole), never by
-- user name. Consumers (Person.PersonType = 'IN' with a Sales.Customer row) map
-- to the 'consumer' role in code.
--
-- These tables are the runtime source of truth read by SqlUserDirectory. The
-- same values are mirrored as in-code fallbacks in ApplicationRoles.cs so the
-- service still works if the seed has not yet run.
--
-- Idempotent: tables are created only if missing; rows are fully rebuilt on each
-- run so the catalog always matches the deterministic design.
-- =============================================================================

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'Auth')
    EXEC('CREATE SCHEMA [Auth]');
GO

-- ---------------------------------------------------------------- catalog tables
IF OBJECT_ID('Auth.ApplicationRole', 'U') IS NULL
BEGIN
    CREATE TABLE Auth.ApplicationRole
    (
        RoleName    varchar(64)  NOT NULL CONSTRAINT PK_Auth_ApplicationRole PRIMARY KEY,
        Category    varchar(32)  NOT NULL,
        Description nvarchar(256) NULL
    );
END
GO

IF OBJECT_ID('Auth.RoleScope', 'U') IS NULL
BEGIN
    CREATE TABLE Auth.RoleScope
    (
        RoleName varchar(64) NOT NULL,
        Scope    varchar(64) NOT NULL,
        CONSTRAINT PK_Auth_RoleScope PRIMARY KEY (RoleName, Scope)
    );
END
GO

IF OBJECT_ID('Auth.DepartmentRole', 'U') IS NULL
BEGIN
    CREATE TABLE Auth.DepartmentRole
    (
        DepartmentId smallint    NOT NULL CONSTRAINT PK_Auth_DepartmentRole PRIMARY KEY,
        RoleName     varchar(64) NOT NULL
    );
END
GO

-- ------------------------------------------------------------- application roles
DELETE FROM Auth.ApplicationRole;
INSERT INTO Auth.ApplicationRole (RoleName, Category, Description) VALUES
    ('consumer',                'consumer',      N'External e-shop consumer: public catalog and their own orders'),
    ('sales-admin',             'employee',      N'Sales department employee'),
    ('marketing-admin',         'employee',      N'Marketing department employee (promotions, data generation)'),
    ('inventory-admin',         'employee',      N'Inventory / purchasing / shipping employee'),
    ('operations-admin',        'employee',      N'General internal administration (default employee role)'),
    ('executive-admin',         'employee',      N'Executive: broad administration including sensitive MCP admin'),
    ('manufacturing-engineer',  'manufacturing', N'Manufacturing engineer / production controller / warehouse operator');
GO

-- --------------------------------------------------------------- role -> scopes
-- Mirrors ApplicationRoles.DefaultRoleScopes. Ownership/record-level checks are
-- layered on top of scopes server-side (they are NOT encoded here).
DELETE FROM Auth.RoleScope;
INSERT INTO Auth.RoleScope (RoleName, Scope) VALUES
    -- consumer (catalog + own orders + own profile/addresses; self-access is ownership-gated)
    ('consumer', 'mcp.access'),
    ('consumer', 'products.read'),
    ('consumer', 'orders.read'),
    ('consumer', 'orders.write'),
    ('consumer', 'customers.read'),
    ('consumer', 'customers.write'),
    -- sales-admin
    ('sales-admin', 'mcp.access'),
    ('sales-admin', 'products.read'),
    ('sales-admin', 'sales.read'),
    ('sales-admin', 'customers.read'),
    ('sales-admin', 'customers.write'),
    ('sales-admin', 'orders.read'),
    ('sales-admin', 'admin.read'),
    -- marketing-admin
    ('marketing-admin', 'mcp.access'),
    ('marketing-admin', 'products.read'),
    ('marketing-admin', 'sales.read'),
    ('marketing-admin', 'customers.read'),
    ('marketing-admin', 'customers.write'),
    ('marketing-admin', 'admin.read'),
    ('marketing-admin', 'admin.write'),
    -- inventory-admin
    ('inventory-admin', 'mcp.access'),
    ('inventory-admin', 'products.read'),
    ('inventory-admin', 'inventory.read'),
    ('inventory-admin', 'manufacturing.read'),
    ('inventory-admin', 'admin.read'),
    -- operations-admin (default employee)
    ('operations-admin', 'mcp.access'),
    ('operations-admin', 'products.read'),
    ('operations-admin', 'sales.read'),
    ('operations-admin', 'customers.read'),
    ('operations-admin', 'customers.write'),
    ('operations-admin', 'orders.read'),
    ('operations-admin', 'inventory.read'),
    ('operations-admin', 'admin.read'),
    -- executive-admin (all scopes incl. mcp.admin)
    ('executive-admin', 'mcp.access'),
    ('executive-admin', 'products.read'),
    ('executive-admin', 'sales.read'),
    ('executive-admin', 'customers.read'),
    ('executive-admin', 'customers.write'),
    ('executive-admin', 'inventory.read'),
    ('executive-admin', 'manufacturing.read'),
    ('executive-admin', 'orders.read'),
    ('executive-admin', 'orders.write'),
    ('executive-admin', 'admin.read'),
    ('executive-admin', 'admin.write'),
    ('executive-admin', 'mcp.admin'),
    -- manufacturing-engineer (NO customers/sales/orders/admin — isolation demo)
    ('manufacturing-engineer', 'mcp.access'),
    ('manufacturing-engineer', 'products.read'),
    ('manufacturing-engineer', 'inventory.read'),
    ('manufacturing-engineer', 'manufacturing.read'),
    ('manufacturing-engineer', 'manufacturing.write');
GO

-- ---------------------------------------------------------- department -> role
-- Mirrors SqlUserDirectory.DepartmentRoleFallback. Department IDs come from the
-- seeded HumanResources.Department table. Employees in any department not listed
-- here resolve to 'operations-admin' (least-privileged employee default).
DELETE FROM Auth.DepartmentRole;
INSERT INTO Auth.DepartmentRole (DepartmentId, RoleName) VALUES
    (3,  'sales-admin'),             -- Sales
    (4,  'marketing-admin'),         -- Marketing
    (5,  'inventory-admin'),         -- Purchasing
    (15, 'inventory-admin'),         -- Shipping and Receiving
    (7,  'manufacturing-engineer'),  -- Production
    (8,  'manufacturing-engineer'),  -- Production Control
    (16, 'executive-admin');         -- Executive
GO

-- ------------------------------------------------------- optional FK integrity
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Auth_RoleScope_ApplicationRole')
    ALTER TABLE Auth.RoleScope WITH NOCHECK
        ADD CONSTRAINT FK_Auth_RoleScope_ApplicationRole
        FOREIGN KEY (RoleName) REFERENCES Auth.ApplicationRole (RoleName);
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Auth_DepartmentRole_ApplicationRole')
    ALTER TABLE Auth.DepartmentRole WITH NOCHECK
        ADD CONSTRAINT FK_Auth_DepartmentRole_ApplicationRole
        FOREIGN KEY (RoleName) REFERENCES Auth.ApplicationRole (RoleName);
GO
