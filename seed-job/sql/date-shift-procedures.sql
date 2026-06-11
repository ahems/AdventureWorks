-- =============================================================================
-- AdventureWorks Date-Shift Stored Procedures
-- =============================================================================
-- PURPOSE
--   The AdventureWorks dataset was generated with dates from ~2001–2014.
--   These two procedures allow the data to be "brought forward" so that the
--   most recent activity appears to have happened yesterday in real time.
--
-- PROCEDURE SUMMARY
--   1. dbo.uspFindDateHighWatermark
--        Scans every date/datetime column across all AdventureWorks schemas
--        and returns the most recent value that is at least one year in the
--        past (to exclude auto-generated GETDATE() timestamps from the import).
--        Run this once manually to discover the high watermark and verify the
--        result before calling the second procedure.
--
--   2. dbo.uspShiftDatesForward  (@OriginalHighWatermark DATETIME)
--        Takes the result of procedure 1 as a hard-coded input.
--        Calculates the offset in seconds needed to map that date to yesterday
--        (midnight), then applies the same offset to every date/datetime column
--        across all AdventureWorks schema tables.
--        Idempotent: skips silently if the data appears already shifted.
--
--        After the uniform shift, three targeted re-anchor blocks fix open
--        records whose due/ship dates fell in the past, giving manufacturing
--        and supply-chain tools realistic near-future data:
--          A. Pending PurchaseOrders (Status=1): ShipDate and
--             PurchaseOrderDetail.DueDate re-set to GETDATE() + vendor
--             AverageLeadTime + deterministic spread (7-20 days ahead).
--          B. In-process WorkOrders (EndDate IS NULL): DueDate spread across the
--             next 1-14 days; StartDate = DueDate - original duration (capped
--             at -30 days) so active manufacturing jobs show near-future
--             completion.
--          C. In-process SalesOrders (Status=1): DueDate set to
--             OrderDate + 7 days, ShipDate cleared to NULL so open seed-era
--             orders appear pending rather than overdue.
--
-- USAGE PATTERN
--   Step 1  EXEC dbo.uspFindDateHighWatermark
--           Note the HighWatermarkDate value from the final result set.
--
--   Step 2  EXEC dbo.uspShiftDatesForward @OriginalHighWatermark = '<value>'
--           where <value> is the HighWatermarkDate from step 1.
-- =============================================================================

-- =============================================================================
-- PROCEDURE 1: dbo.uspFindDateHighWatermark
-- =============================================================================
-- Iterates over every date/datetime column in every base table belonging to the
-- AdventureWorks schemas (Person, HumanResources, Production, Purchasing, Sales,
-- dbo).  For each column it finds the maximum value that is at least TWO years
-- before the current date.  The two-year guard does two things:
--   1. Excludes GETDATE()-stamped metadata columns (ModifiedDate, etc.) written
--      during a seed job run that occurred in the past year or two.
--   2. Metadata columns (ModifiedDate, VersionDate, ErrorTime, DateCreated) are
--      excluded from the scan entirely — they are import artifacts, not business
--      event dates.  They are still shifted by procedure 2.
-- The watermark is therefore driven purely by business event dates such as
-- OrderDate, TransactionDate, HireDate, SellStartDate, QuotaDate, etc.
--
-- Returns
--   Result set 1 : one row per column, sorted most-recent first — a full audit
--                  trail showing how the high watermark was derived.
--   Result set 2 : a single row with HighWatermarkDate, CutOffDate, RunAt.
--   PRINT output : human-readable summary with the value to pass into proc 2.
-- =============================================================================
IF OBJECT_ID(N'[dbo].[uspFindDateHighWatermark]', 'P') IS NOT NULL
    DROP PROCEDURE [dbo].[uspFindDateHighWatermark];
GO
CREATE PROCEDURE [dbo].[uspFindDateHighWatermark]
AS
BEGIN
    SET NOCOUNT ON;

    -- The filter: we only consider dates at least two years in the past.
    -- Two years (rather than one) ensures we skip any GETDATE()-stamped
    -- ModifiedDate values written during a seed job run in the past year.
    DECLARE @CutOffDate DATETIME = DATEADD(YEAR, -2, GETDATE());

    -- Temp table to accumulate one row per (schema, table, column).
    CREATE TABLE #DateResults (
        SchemaName    NVARCHAR(128) NOT NULL,
        TableName     NVARCHAR(128) NOT NULL,
        ColumnName    NVARCHAR(128) NOT NULL,
        DataType      NVARCHAR(64)  NOT NULL,
        MaxDate       DATETIME      NULL,   -- max qualifying value for this column
        TotalRows     INT           NOT NULL,
        QualifiedRows INT           NOT NULL -- rows where value <= @CutOffDate
    );

    DECLARE @SchemaName  NVARCHAR(128);
    DECLARE @TableName   NVARCHAR(128);
    DECLARE @ColumnName  NVARCHAR(128);
    DECLARE @DataType    NVARCHAR(64);
    DECLARE @SQL         NVARCHAR(MAX);

    -- Cursor over all date/datetime columns in AdventureWorks schemas.
    -- FAST_FORWARD: forward-only, read-only cursor — low overhead.
    DECLARE col_cursor CURSOR FAST_FORWARD FOR
        SELECT
            c.TABLE_SCHEMA,
            c.TABLE_NAME,
            c.COLUMN_NAME,
            c.DATA_TYPE
        FROM   INFORMATION_SCHEMA.COLUMNS  AS c
        INNER JOIN INFORMATION_SCHEMA.TABLES AS t
               ON  c.TABLE_SCHEMA = t.TABLE_SCHEMA
               AND c.TABLE_NAME   = t.TABLE_NAME
        WHERE  t.TABLE_TYPE = 'BASE TABLE'
          AND  c.DATA_TYPE   IN ('datetime', 'datetime2', 'date', 'smalldatetime')
          AND  c.TABLE_SCHEMA IN ('Person', 'HumanResources', 'Production',
                                  'Purchasing', 'Sales', 'dbo')
          -- Skip computed columns (they cannot be queried as plain columns)
          AND  COLUMNPROPERTY(
                   OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME),
                   c.COLUMN_NAME, 'IsComputed') = 0
          -- Exclude metadata/audit columns stamped with GETDATE() on import.
          AND  c.COLUMN_NAME NOT IN ('ModifiedDate', 'VersionDate', 'ErrorTime',
                                     'DateCreated')
          -- Exclude tables whose dates are actively maintained by the manufacturing
          -- simulation or AI pipeline.  Their values span from simulation start
          -- through to today, so MAX(col) <= any cutoff returns a false watermark
          -- right at the cutoff boundary.  These tables are still shifted by
          -- proc 2 (for their original seed rows only — see @ShiftThreshold there).
          AND NOT (c.TABLE_SCHEMA = 'Production'
                   AND c.TABLE_NAME IN ('WorkOrder', 'WorkOrderRouting',
                                        'ProductCostHistory'))
          AND NOT (c.TABLE_SCHEMA = 'Purchasing'
                   AND c.TABLE_NAME IN ('PurchaseOrderHeader', 'PurchaseOrderDetail',
                                        'SimOrderTracking', 'SimOrderState'))
          -- LastReceiptDate is updated by the simulation on otherwise-static rows.
          AND NOT (c.TABLE_SCHEMA = 'Purchasing' AND c.TABLE_NAME = 'ProductVendor'
                   AND c.COLUMN_NAME = 'LastReceiptDate')
          -- ReviewDate for AI-generated reviews is recent by design (Dec 2025).
          -- Original 5 AW reviews are shifted via the threshold in proc 2.
          AND NOT (c.TABLE_SCHEMA = 'Production' AND c.TABLE_NAME = 'ProductReview'
                   AND c.COLUMN_NAME = 'ReviewDate')
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME;

    OPEN col_cursor;
    FETCH NEXT FROM col_cursor INTO @SchemaName, @TableName, @ColumnName, @DataType;

    WHILE @@FETCH_STATUS = 0
    BEGIN
        -- Build a parameterised query for this column.
        -- CAST to DATETIME so all results land in a single DATETIME column
        -- regardless of whether the source type is date, datetime, or datetime2.
        -- Remove the WHERE filter from the aggregate query so that:
        --   TotalRows     = all non-null rows in the column
        --   QualifiedRows = rows whose date is on or before the cutoff
        --   MaxDate       = maximum value among qualifying rows only
        -- Without this, both COUNT(*) and SUM() only see filtered rows
        -- (making TotalRows == QualifiedRows always), and SUM() over an
        -- empty set returns NULL which violates the NOT NULL constraint.
        SET @SQL = N'
            INSERT INTO #DateResults
                (SchemaName, TableName, ColumnName, DataType, MaxDate, TotalRows, QualifiedRows)
            SELECT
                @s, @t, @c, @dt,
                MAX(CASE
                        WHEN CAST([' + @ColumnName + N'] AS DATETIME) <= @cutoff
                        THEN CAST([' + @ColumnName + N'] AS DATETIME)
                    END),
                COUNT(*),
                ISNULL(SUM(CASE
                        WHEN CAST([' + @ColumnName + N'] AS DATETIME) <= @cutoff
                        THEN 1 ELSE 0
                    END), 0)
            FROM [' + @SchemaName + N'].[' + @TableName + N']
            WHERE [' + @ColumnName + N'] IS NOT NULL;';

        EXEC sp_executesql @SQL,
            N'@s       NVARCHAR(128),
              @t       NVARCHAR(128),
              @c       NVARCHAR(128),
              @dt      NVARCHAR(64),
              @cutoff  DATETIME',
            @s       = @SchemaName,
            @t       = @TableName,
            @c       = @ColumnName,
            @dt      = @DataType,
            @cutoff  = @CutOffDate;

        FETCH NEXT FROM col_cursor INTO @SchemaName, @TableName, @ColumnName, @DataType;
    END;

    CLOSE col_cursor;
    DEALLOCATE col_cursor;

    -- -------------------------------------------------------------------------
    -- Result set 1: full audit trail, most-recent column value first.
    -- -------------------------------------------------------------------------
    SELECT
        SchemaName,
        TableName,
        ColumnName,
        DataType,
        MaxDate,
        TotalRows,
        QualifiedRows,
        DATEDIFF(DAY, MaxDate, GETDATE()) AS DaysFromToday
    FROM  #DateResults
    WHERE MaxDate IS NOT NULL
    ORDER BY MaxDate DESC;

    -- -------------------------------------------------------------------------
    -- Derive overall high watermark and print a human-readable summary.
    -- -------------------------------------------------------------------------
    DECLARE @HighWatermark DATETIME;
    SELECT @HighWatermark = MAX(MaxDate) FROM #DateResults;

    PRINT '======================================================';
    PRINT 'HIGH WATERMARK : ' + ISNULL(CONVERT(VARCHAR(30), @HighWatermark, 121), 'NULL (no qualifying dates found)');
    PRINT 'Cut-off used   : dates on or before ' + CONVERT(VARCHAR(30), @CutOffDate, 121);
    PRINT 'Run at         : ' + CONVERT(VARCHAR(30), GETDATE(), 121);
    PRINT '------------------------------------------------------';
    PRINT 'The top row in the result set above is the column that';
    PRINT 'contains the most recent qualifying date.  That date is';
    PRINT 'the HIGH WATERMARK — pass it to dbo.uspShiftDatesForward';
    PRINT 'to bring every AdventureWorks date forward so the most';
    PRINT 'recent activity appears to have happened yesterday.';
    PRINT '';
    PRINT 'Example call:';
    PRINT '  EXEC dbo.uspShiftDatesForward';
    PRINT '       @OriginalHighWatermark = '''
          + ISNULL(CONVERT(VARCHAR(30), @HighWatermark, 121), '<NULL>') + ''';';
    PRINT '======================================================';

    -- -------------------------------------------------------------------------
    -- Result set 2: single row summarising the outcome.
    -- -------------------------------------------------------------------------
    SELECT
        @HighWatermark AS HighWatermarkDate,
        @CutOffDate    AS CutOffDate,
        GETDATE()      AS RunAt;

    DROP TABLE #DateResults;
END;
GO

-- =============================================================================
-- PROCEDURE 2: dbo.uspShiftDatesForward
-- =============================================================================
-- Takes the high watermark discovered by dbo.uspFindDateHighWatermark and shifts
-- every date/datetime column in every AdventureWorks table forward by the same
-- uniform offset, so that @OriginalHighWatermark maps to yesterday at midnight.
--
-- OFFSET CALCULATION
--   target   = midnight at the start of yesterday
--   offset   = DATEDIFF(SECOND, @OriginalHighWatermark, target)
--   Applied  = DATEADD(SECOND, offset, existing_value)
--   All dates move forward by the same number of seconds, so relative ordering
--   and durations are perfectly preserved.
--   INT range check: 20 years * 365.25 * 86400 ≈ 631 million seconds < 2.1 billion
--   (INT max), so there is no risk of integer overflow for any realistic offset.
--
-- IDEMPOTENCY
--   Before running, the procedure checks whether the maximum OrderDate in
--   Sales.SalesOrderHeader is already within 7 days of today.  If it is, the
--   data has already been shifted and the procedure exits without changes.
--
-- CHECK CONSTRAINTS
--   The cursor updates one column at a time, so a transient state exists where
--   e.g. OrderDate has been shifted to ~2026 while ShipDate is still at ~2014,
--   triggering cross-column constraints.  All affected constraints are disabled
--   before the loop and re-enabled (without row re-validation) afterwards:
--     CK_Employee_BirthDate / CK_Employee_HireDate      (dynamic GETDATE() bounds)
--     CK_EmployeeDepartmentHistory_EndDate              (EndDate >= StartDate)
--     CK_BillOfMaterials_EndDate                        (EndDate > StartDate)
--     CK_ProductCostHistory_EndDate                     (EndDate >= StartDate)
--     CK_ProductListPriceHistory_EndDate                (EndDate >= StartDate)
--     CK_PurchaseOrderHeader_ShipDate                   (ShipDate >= OrderDate)
--     CK_SalesOrderHeader_DueDate / _ShipDate           (both >= OrderDate)
--     CK_SalesTerritoryHistory_EndDate                  (EndDate >= StartDate)
--
-- TRANSACTION
--   All updates run inside a single transaction.  On any error the transaction
--   is rolled back and the original error is re-thrown.
--
-- USAGE
--   EXEC dbo.uspShiftDatesForward @OriginalHighWatermark = '2014-05-29 00:00:00';
-- =============================================================================
IF OBJECT_ID(N'[dbo].[uspShiftDatesForward]', 'P') IS NOT NULL
    DROP PROCEDURE [dbo].[uspShiftDatesForward];
GO
CREATE PROCEDURE [dbo].[uspShiftDatesForward]
    @OriginalHighWatermark DATETIME
AS
BEGIN
    SET NOCOUNT ON;

    -- -------------------------------------------------------------------------
    -- Idempotency guard
    -- If the most recent order date is already within 7 days of today then the
    -- shift has already been applied — exit cleanly without touching any data.
    -- -------------------------------------------------------------------------
    DECLARE @CurrentMaxOrderDate DATETIME;
    SELECT @CurrentMaxOrderDate = MAX(OrderDate)
    FROM   [Sales].[SalesOrderHeader];

    IF @CurrentMaxOrderDate >= DATEADD(DAY, -7, GETDATE())
    BEGIN
        PRINT 'SKIPPED (idempotency guard): data appears already shifted.';
        PRINT '  Max Sales.SalesOrderHeader.OrderDate = '
              + ISNULL(CONVERT(VARCHAR(30), @CurrentMaxOrderDate, 121), 'NULL');
        PRINT '  Re-run dbo.uspFindDateHighWatermark to confirm current state.';
        RETURN;
    END;

    -- -------------------------------------------------------------------------
    -- Calculate the offset in seconds.
    -- Target: midnight at the start of yesterday.
    -- -------------------------------------------------------------------------
    DECLARE @Yesterday     DATETIME = CAST(CAST(DATEADD(DAY, -1, GETDATE()) AS DATE) AS DATETIME);
    DECLARE @OffsetSeconds INT      = DATEDIFF(SECOND, @OriginalHighWatermark, @Yesterday);

    -- Only shift dates that belong to the original seed data era.  The
    -- manufacturing simulation and AI pipeline write dates from 2024 onwards;
    -- those must not be shifted.  Adding 2 years to the watermark gives a
    -- generous buffer above the original AW data range (2001–~2014) while
    -- remaining well below any simulation-generated value (2024+).
    DECLARE @ShiftThreshold DATETIME = DATEADD(YEAR, 2, @OriginalHighWatermark);

    PRINT '======================================================';
    PRINT 'dbo.uspShiftDatesForward';
    PRINT '  Original high watermark  : ' + CONVERT(VARCHAR(30), @OriginalHighWatermark, 121);
    PRINT '  Target (yesterday 00:00) : ' + CONVERT(VARCHAR(30), @Yesterday, 121);
    PRINT '  Offset (seconds)         : ' + CAST(@OffsetSeconds AS VARCHAR(20));
    PRINT '  Offset (approx days)     : ' + CAST(@OffsetSeconds / 86400 AS VARCHAR(20));
    PRINT '  Shift threshold          : ' + CONVERT(VARCHAR(30), @ShiftThreshold, 121)
          + '  (dates after this are simulation/AI data — not touched)';
    PRINT '======================================================';

    IF @OffsetSeconds <= 0
    BEGIN
        PRINT 'WARNING: Offset is zero or negative.';
        PRINT '  @OriginalHighWatermark (' + CONVERT(VARCHAR(30), @OriginalHighWatermark, 121)
              + ') is already on or after yesterday.';
        PRINT '  Nothing to do.';
        RETURN;
    END;

    -- -------------------------------------------------------------------------
    -- Disable all CHECK constraints whose expressions reference multiple date
    -- columns on the same table.  Because the cursor updates one column at a
    -- time, an intermediate state exists where e.g. OrderDate has been shifted
    -- to ~2026 but ShipDate is still at ~2014, causing ShipDate >= OrderDate to
    -- fail.  Disabling before the loop and re-enabling (WITHOUT re-validation)
    -- afterwards avoids this while keeping the constraints active for future DML.
    --
    -- Also includes the two Employee constraints that use GETDATE() dynamically:
    -- after shifting ~11 years forward some birthdate/hire-date values would
    -- breach those dynamic bounds.
    -- -------------------------------------------------------------------------
    ALTER TABLE [HumanResources].[Employee]
        NOCHECK CONSTRAINT [CK_Employee_BirthDate];
    ALTER TABLE [HumanResources].[Employee]
        NOCHECK CONSTRAINT [CK_Employee_HireDate];
    ALTER TABLE [HumanResources].[EmployeeDepartmentHistory]
        NOCHECK CONSTRAINT [CK_EmployeeDepartmentHistory_EndDate];
    ALTER TABLE [Production].[BillOfMaterials]
        NOCHECK CONSTRAINT [CK_BillOfMaterials_EndDate];
    ALTER TABLE [Production].[ProductCostHistory]
        NOCHECK CONSTRAINT [CK_ProductCostHistory_EndDate];
    ALTER TABLE [Production].[ProductListPriceHistory]
        NOCHECK CONSTRAINT [CK_ProductListPriceHistory_EndDate];
    ALTER TABLE [Purchasing].[PurchaseOrderHeader]
        NOCHECK CONSTRAINT [CK_PurchaseOrderHeader_ShipDate];
    ALTER TABLE [Sales].[SalesOrderHeader]
        NOCHECK CONSTRAINT [CK_SalesOrderHeader_DueDate];
    ALTER TABLE [Sales].[SalesOrderHeader]
        NOCHECK CONSTRAINT [CK_SalesOrderHeader_ShipDate];
    ALTER TABLE [Sales].[SalesTerritoryHistory]
        NOCHECK CONSTRAINT [CK_SalesTerritoryHistory_EndDate];

    -- -------------------------------------------------------------------------
    -- Dynamic cursor: update every date/datetime column in every AW table.
    -- -------------------------------------------------------------------------
    DECLARE @SchemaName    NVARCHAR(128);
    DECLARE @TableName     NVARCHAR(128);
    DECLARE @ColumnName    NVARCHAR(128);
    DECLARE @SQL           NVARCHAR(MAX);
    DECLARE @RowsAffected  INT;
    DECLARE @TotalUpdated  BIGINT = 0;

    -- Enumerate the same set of columns as dbo.uspFindDateHighWatermark, with
    -- two exclusions:
    --   dbo.ErrorLog      : operational log; timestamps are not meaningful to shift.
    --   Computed columns  : cannot be updated directly.
    DECLARE upd_cursor CURSOR FAST_FORWARD FOR
        SELECT
            c.TABLE_SCHEMA,
            c.TABLE_NAME,
            c.COLUMN_NAME
        FROM   INFORMATION_SCHEMA.COLUMNS  AS c
        INNER JOIN INFORMATION_SCHEMA.TABLES AS t
               ON  c.TABLE_SCHEMA = t.TABLE_SCHEMA
               AND c.TABLE_NAME   = t.TABLE_NAME
        WHERE  t.TABLE_TYPE = 'BASE TABLE'
          AND  c.DATA_TYPE   IN ('datetime', 'datetime2', 'date', 'smalldatetime')
          AND  c.TABLE_SCHEMA IN ('Person', 'HumanResources', 'Production',
                                  'Purchasing', 'Sales', 'dbo')
          -- Exclude operational log — not meaningful to shift
          AND  NOT (c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = 'ErrorLog')
          -- Exclude pure simulation tables (all rows are current by design;
          -- shifting them would push their dates into the future)
          AND  NOT (c.TABLE_SCHEMA = 'Purchasing'
                    AND c.TABLE_NAME IN ('SimOrderTracking', 'SimOrderState'))
          -- Exclude SpecialOffer StartDate/EndDate — handled separately after the loop
          -- so that every offer is anchored to yesterday (StartDate = yesterday,
          -- EndDate = yesterday + original duration) rather than shifted uniformly.
          AND  NOT (c.TABLE_SCHEMA = 'Sales' AND c.TABLE_NAME = 'SpecialOffer'
                    AND c.COLUMN_NAME IN ('StartDate', 'EndDate'))
          -- Exclude computed columns
          AND  COLUMNPROPERTY(
                   OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME),
                   c.COLUMN_NAME, 'IsComputed') = 0
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME;

    -- -------------------------------------------------------------------------
    -- Capture original SpecialOffer durations BEFORE any column is updated.
    -- StartDate and EndDate are excluded from the generic cursor above, so this
    -- snapshot is guaranteed to see the original (pre-shift) values.
    -- -------------------------------------------------------------------------
    SELECT
        SpecialOfferID,
        DATEDIFF(DAY, StartDate, EndDate) AS DurationDays
    INTO #SpecialOfferDurations
    FROM [Sales].[SpecialOffer]
    WHERE StartDate IS NOT NULL
      AND EndDate   IS NOT NULL
      AND CAST(StartDate AS DATETIME) <= @ShiftThreshold;

    BEGIN TRANSACTION;
    BEGIN TRY

        OPEN upd_cursor;
        FETCH NEXT FROM upd_cursor INTO @SchemaName, @TableName, @ColumnName;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            -- CAST the column to DATETIME before passing to DATEADD so that
            -- DATE-typed columns (BirthDate, HireDate, etc.) work correctly —
            -- SQL Server does not support the SECOND datepart on DATE columns
            -- directly, but does support it on DATETIME.  The result is assigned
            -- back to the column; SQL Server performs an implicit narrowing cast
            -- to DATE when the column type requires it (time part is truncated).
            -- The @thresh guard ensures only original seed-era rows are moved;
            -- any row written by the simulation or AI pipeline (dates >> watermark)
            -- is left exactly where it is.
            SET @SQL = N'
                UPDATE [' + @SchemaName + N'].[' + @TableName + N']
                SET    [' + @ColumnName + N'] =
                           DATEADD(SECOND, @offs,
                                   CAST([' + @ColumnName + N'] AS DATETIME))
                WHERE  [' + @ColumnName + N'] IS NOT NULL
                  AND  CAST([' + @ColumnName + N'] AS DATETIME) <= @thresh;
                SELECT @rows = @@ROWCOUNT;';

            EXEC sp_executesql @SQL,
                N'@offs INT, @thresh DATETIME, @rows INT OUTPUT',
                @offs  = @OffsetSeconds,
                @thresh = @ShiftThreshold,
                @rows  = @RowsAffected OUTPUT;

            SET @TotalUpdated += ISNULL(@RowsAffected, 0);

            PRINT '  Updated [' + @SchemaName + '].[' + @TableName + '].[' + @ColumnName + '] — '
                  + CAST(ISNULL(@RowsAffected, 0) AS VARCHAR) + ' row(s)';

            FETCH NEXT FROM upd_cursor INTO @SchemaName, @TableName, @ColumnName;
        END;

        CLOSE upd_cursor;
        DEALLOCATE upd_cursor;

        -- -----------------------------------------------------------------
        -- SpecialOffer: anchor every seed-era offer so that
        --   StartDate = yesterday  (the offer started "yesterday")
        --   EndDate   = yesterday + original duration in days
        -- This makes all offers appear active regardless of their original
        -- date range.  Offers added by simulation/AI (StartDate > threshold)
        -- are absent from #SpecialOfferDurations and so are not touched.
        -- -----------------------------------------------------------------
        UPDATE so
        SET
            so.StartDate = @Yesterday,
            so.EndDate   = DATEADD(DAY, d.DurationDays, @Yesterday)
        FROM [Sales].[SpecialOffer] AS so
        JOIN #SpecialOfferDurations AS d ON so.SpecialOfferID = d.SpecialOfferID;

        SET @RowsAffected = @@ROWCOUNT;
        SET @TotalUpdated += @RowsAffected;
        PRINT '  Updated [Sales].[SpecialOffer].[StartDate+EndDate] (anchored to yesterday) — '
              + CAST(@RowsAffected AS VARCHAR) + ' row(s)';

        DROP TABLE #SpecialOfferDurations;

        -- -----------------------------------------------------------------
        -- Block A: Re-anchor pending PurchaseOrders so they appear as
        -- upcoming deliveries rather than overdue.
        --
        -- Targets PurchaseOrderHeader rows where Status=1 (Pending) and
        -- the ShipDate is NULL or already in the past after the uniform
        -- shift.  Only seed-era rows (OrderDate <= @ShiftThreshold) are
        -- touched; supply-chain-simulation POs have OrderDate >> threshold
        -- and are naturally excluded.
        --
        -- The new ShipDate is GETDATE() + vendor AverageLeadTime +
        -- (PurchaseOrderID % 14), giving a deterministic 7-20 day spread
        -- so deliveries do not all arrive on the same day.  When no
        -- ProductVendor record can be found the lead-time defaults to 7.
        -- PurchaseOrderDetail.DueDate (per-line) is aligned to the same
        -- value so the supply-chain bootstrap stays consistent.
        -- -----------------------------------------------------------------
        SELECT  poh.PurchaseOrderID,
                DATEADD(DAY,
                    (poh.PurchaseOrderID % 14)
                    + ISNULL(
                        (SELECT TOP 1 pv.AverageLeadTime
                         FROM   [Purchasing].[PurchaseOrderDetail] pod2
                         INNER JOIN [Purchasing].[ProductVendor] pv
                                ON  pv.BusinessEntityID = poh.VendorID
                                AND pv.ProductID        = pod2.ProductID
                         WHERE  pod2.PurchaseOrderID = poh.PurchaseOrderID
                         ORDER BY pv.AverageLeadTime DESC),
                        7),
                    GETDATE()) AS NewShipDate
        INTO #PendingPoAnchor
        FROM   [Purchasing].[PurchaseOrderHeader] poh
        WHERE  poh.Status = 1
          AND  (poh.ShipDate IS NULL OR poh.ShipDate < GETDATE())
          AND  CAST(poh.OrderDate AS DATETIME) <= @ShiftThreshold;

        UPDATE poh
        SET    poh.ShipDate = a.NewShipDate
        FROM   [Purchasing].[PurchaseOrderHeader] poh
        JOIN   #PendingPoAnchor a ON poh.PurchaseOrderID = a.PurchaseOrderID;

        SET @RowsAffected = @@ROWCOUNT;
        SET @TotalUpdated += @RowsAffected;
        PRINT '  Re-anchored [Purchasing].[PurchaseOrderHeader].ShipDate (pending -> near future) — '
              + CAST(@RowsAffected AS VARCHAR) + ' PO header(s)';

        UPDATE pod
        SET    pod.DueDate = a.NewShipDate
        FROM   [Purchasing].[PurchaseOrderDetail] pod
        JOIN   #PendingPoAnchor a ON pod.PurchaseOrderID = a.PurchaseOrderID;

        SET @RowsAffected = @@ROWCOUNT;
        SET @TotalUpdated += @RowsAffected;
        PRINT '  Re-anchored [Purchasing].[PurchaseOrderDetail].DueDate (pending -> near future) — '
              + CAST(@RowsAffected AS VARCHAR) + ' line(s)';

        DROP TABLE #PendingPoAnchor;

        -- -----------------------------------------------------------------
        -- Block B: Re-anchor in-process WorkOrders so manufacturing jobs
        -- appear actively in progress with near-future completion dates.
        --
        -- Targets WorkOrder rows where EndDate IS NULL (In Process) and DueDate
        -- is in the past after the uniform shift.  Only seed-era rows
        -- (DueDate <= @ShiftThreshold) are touched.
        --
        -- The new DueDate is spread across the next 1-14 days using
        -- WorkOrderID % 14 (deterministic).  StartDate is recalculated as
        -- new DueDate - original duration, capped at no earlier than
        -- 30 days ago so no job appears to have started more than a month
        -- back.  EndDate remains NULL (in-process) and is not updated.
        -- -----------------------------------------------------------------
        SELECT  wo.WorkOrderID,
                DATEDIFF(DAY, wo.StartDate, wo.DueDate) AS DurationDays
        INTO #WoAnchor
        FROM   [Production].[WorkOrder] wo
        WHERE  wo.EndDate IS NULL
          AND  wo.DueDate < GETDATE()
          AND  CAST(wo.DueDate AS DATETIME) <= @ShiftThreshold;

        UPDATE wo
        SET    wo.DueDate   = DATEADD(DAY,
                                  (wo.WorkOrderID % 14) + 1,
                                  CAST(GETDATE() AS DATE)),
               wo.StartDate = CASE
                                  WHEN DATEADD(DAY, -(a.DurationDays),
                                           DATEADD(DAY, (wo.WorkOrderID % 14) + 1,
                                               CAST(GETDATE() AS DATE)))
                                       < DATEADD(DAY, -30, CAST(GETDATE() AS DATE))
                                  THEN DATEADD(DAY, -30, CAST(GETDATE() AS DATE))
                                  ELSE DATEADD(DAY, -(a.DurationDays),
                                           DATEADD(DAY, (wo.WorkOrderID % 14) + 1,
                                               CAST(GETDATE() AS DATE)))
                              END
        FROM   [Production].[WorkOrder] wo
        JOIN   #WoAnchor a ON wo.WorkOrderID = a.WorkOrderID;

        SET @RowsAffected = @@ROWCOUNT;
        SET @TotalUpdated += @RowsAffected;
        PRINT '  Re-anchored [Production].[WorkOrder] in-process DueDate/StartDate (-> near future) — '
              + CAST(@RowsAffected AS VARCHAR) + ' row(s)';

        DROP TABLE #WoAnchor;

        -- -----------------------------------------------------------------
        -- Block C: Re-anchor in-process SalesOrders so open seed-era orders
        -- appear pending rather than overdue.
        --
        -- Targets SalesOrderHeader rows where Status=1 (In Process) and
        -- DueDate is in the past after the uniform shift.  Only seed-era
        -- rows (OrderDate <= @ShiftThreshold) are touched.
        --
        -- DueDate is set to OrderDate + 7 days (a standard processing
        -- window).  ShipDate is cleared to NULL to correctly reflect that
        -- the order has not yet shipped.  AI-generated orders with
        -- OrderDate >> @ShiftThreshold are naturally excluded.
        -- -----------------------------------------------------------------
        UPDATE soh
        SET    soh.DueDate  = DATEADD(DAY, 7, CAST(soh.OrderDate AS DATE)),
               soh.ShipDate = NULL
        FROM   [Sales].[SalesOrderHeader] soh
        WHERE  soh.Status = 1
          AND  soh.DueDate < GETDATE()
          AND  CAST(soh.OrderDate AS DATETIME) <= @ShiftThreshold;

        SET @RowsAffected = @@ROWCOUNT;
        SET @TotalUpdated += @RowsAffected;
        PRINT '  Re-anchored [Sales].[SalesOrderHeader] in-process DueDate (OrderDate + 7 days) — '
              + CAST(@RowsAffected AS VARCHAR) + ' row(s)';

        COMMIT TRANSACTION;

        PRINT '======================================================';
        PRINT 'Date shift complete.';
        PRINT '  Total column-rows updated : ' + CAST(@TotalUpdated AS VARCHAR(20));
        PRINT '  New effective "today"     : ' + CONVERT(VARCHAR(30), GETDATE(), 121);
        PRINT '  Max OrderDate should now  ~ ' + CONVERT(VARCHAR(30), @Yesterday, 121);
        PRINT '======================================================';

    END TRY
    BEGIN CATCH

        -- Tidy up the cursor if still open
        IF CURSOR_STATUS('LOCAL', 'upd_cursor') >= 0
        BEGIN
            CLOSE     upd_cursor;
            DEALLOCATE upd_cursor;
        END;

        ROLLBACK TRANSACTION;

        -- Clean up temp tables if the blocks had not yet dropped them
        IF OBJECT_ID('tempdb..#SpecialOfferDurations') IS NOT NULL
            DROP TABLE #SpecialOfferDurations;
        IF OBJECT_ID('tempdb..#PendingPoAnchor') IS NOT NULL
            DROP TABLE #PendingPoAnchor;
        IF OBJECT_ID('tempdb..#WoAnchor') IS NOT NULL
            DROP TABLE #WoAnchor;

        -- Re-enable constraints even on failure so they are not left disabled
        ALTER TABLE [HumanResources].[Employee]             CHECK CONSTRAINT [CK_Employee_BirthDate];
        ALTER TABLE [HumanResources].[Employee]             CHECK CONSTRAINT [CK_Employee_HireDate];
        ALTER TABLE [HumanResources].[EmployeeDepartmentHistory] CHECK CONSTRAINT [CK_EmployeeDepartmentHistory_EndDate];
        ALTER TABLE [Production].[BillOfMaterials]           CHECK CONSTRAINT [CK_BillOfMaterials_EndDate];
        ALTER TABLE [Production].[ProductCostHistory]        CHECK CONSTRAINT [CK_ProductCostHistory_EndDate];
        ALTER TABLE [Production].[ProductListPriceHistory]   CHECK CONSTRAINT [CK_ProductListPriceHistory_EndDate];
        ALTER TABLE [Purchasing].[PurchaseOrderHeader]       CHECK CONSTRAINT [CK_PurchaseOrderHeader_ShipDate];
        ALTER TABLE [Sales].[SalesOrderHeader]               CHECK CONSTRAINT [CK_SalesOrderHeader_DueDate];
        ALTER TABLE [Sales].[SalesOrderHeader]               CHECK CONSTRAINT [CK_SalesOrderHeader_ShipDate];
        ALTER TABLE [Sales].[SalesTerritoryHistory]          CHECK CONSTRAINT [CK_SalesTerritoryHistory_EndDate];

        -- Re-throw the original error with full context
        THROW;

    END CATCH;

    -- -------------------------------------------------------------------------
    -- Re-enable all constraints (without re-validating existing rows).
    -- CHECK CONSTRAINT (not WITH CHECK CHECK CONSTRAINT) is used intentionally:
    -- constraints fire on future INSERT/UPDATE but existing rows are not
    -- re-validated, avoiding failures from dynamic GETDATE() bounds and the
    -- transient cross-column ordering that existed mid-shift.
    -- -------------------------------------------------------------------------
    ALTER TABLE [HumanResources].[Employee]             CHECK CONSTRAINT [CK_Employee_BirthDate];
    ALTER TABLE [HumanResources].[Employee]             CHECK CONSTRAINT [CK_Employee_HireDate];
    ALTER TABLE [HumanResources].[EmployeeDepartmentHistory] CHECK CONSTRAINT [CK_EmployeeDepartmentHistory_EndDate];
    ALTER TABLE [Production].[BillOfMaterials]           CHECK CONSTRAINT [CK_BillOfMaterials_EndDate];
    ALTER TABLE [Production].[ProductCostHistory]        CHECK CONSTRAINT [CK_ProductCostHistory_EndDate];
    ALTER TABLE [Production].[ProductListPriceHistory]   CHECK CONSTRAINT [CK_ProductListPriceHistory_EndDate];
    ALTER TABLE [Purchasing].[PurchaseOrderHeader]       CHECK CONSTRAINT [CK_PurchaseOrderHeader_ShipDate];
    ALTER TABLE [Sales].[SalesOrderHeader]               CHECK CONSTRAINT [CK_SalesOrderHeader_DueDate];
    ALTER TABLE [Sales].[SalesOrderHeader]               CHECK CONSTRAINT [CK_SalesOrderHeader_ShipDate];
    ALTER TABLE [Sales].[SalesTerritoryHistory]          CHECK CONSTRAINT [CK_SalesTerritoryHistory_EndDate];

END;
GO
