SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.RealtimeNotificationOutbox', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.RealtimeNotificationOutbox (
        NotificationID bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
        Entity nvarchar(256) NOT NULL,
        ChangeType varchar(6) NOT NULL,
        CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_RealtimeNotificationOutbox_ChangeType CHECK (ChangeType IN ('Insert', 'Update', 'Delete'))
    );
    CREATE INDEX IX_RealtimeNotificationOutbox_CreatedAt ON dbo.RealtimeNotificationOutbox(CreatedAt);
END;

DECLARE @tables TABLE (name nvarchar(256));
INSERT INTO @tables VALUES
    ('Sales.ShoppingCartItem'), ('Sales.SalesOrderDetail'),
    ('Production.WorkOrder'), ('Production.WorkOrderRouting'), ('Production.ProductInventory'),
    ('Production.Location'), ('Production.BillOfMaterials'), ('Production.Product'),
    ('Production.ProductCostHistory'), ('Production.ProductListPriceHistory'), ('Production.ProductModel'),
    ('Production.TransactionHistory'), ('Production.TransactionHistoryArchive'),
    ('Purchasing.Vendor'), ('Purchasing.ProductVendor'),
    ('Purchasing.PurchaseOrderHeader'), ('Purchasing.PurchaseOrderDetail'),
    ('Production.ProductReview'), ('Production.ProductReviewReply'),
    ('Sales.SpecialOffer'), ('Sales.SpecialOfferProduct'), ('Sales.CurrencyRate');

DECLARE @table nvarchar(256), @qualified nvarchar(518), @trigger nvarchar(518), @sql nvarchar(max);
DECLARE notification_tables CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM @tables;
OPEN notification_tables;
FETCH NEXT FROM notification_tables INTO @table;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID(@table, 'U') IS NULL
        THROW 51024, 'A realtime notification source table is missing.', 1;
    SET @qualified = QUOTENAME(PARSENAME(@table, 2)) + N'.' + QUOTENAME(PARSENAME(@table, 1));
    SET @trigger = QUOTENAME(PARSENAME(@table, 2)) + N'.' + QUOTENAME(N'RealtimeNotify_' + PARSENAME(@table, 1));
    SET @sql = N'CREATE OR ALTER TRIGGER ' + @trigger + N' ON ' + @qualified + N'
AFTER INSERT, UPDATE, DELETE AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted)
        INSERT dbo.RealtimeNotificationOutbox(Entity, ChangeType)
        VALUES (N''' + @table + N''', CASE WHEN EXISTS (SELECT 1 FROM deleted) THEN ''Update'' ELSE ''Insert'' END);
    ELSE IF EXISTS (SELECT 1 FROM deleted)
        INSERT dbo.RealtimeNotificationOutbox(Entity, ChangeType) VALUES (N''' + @table + N''', ''Delete'');
END;';
    EXEC sp_executesql @sql;
    FETCH NEXT FROM notification_tables INTO @table;
END;
CLOSE notification_tables;
DEALLOCATE notification_tables;

COMMIT TRANSACTION;
