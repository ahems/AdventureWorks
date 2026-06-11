-- =============================================================================
-- Stored Procedure: Sales.usp_GetTotalProfit
-- Description    : Approximates total profit across all non-cancelled orders.
--                  Revenue = SalesOrderDetail.LineTotal
--                            (UnitPrice * (1 - UnitPriceDiscount) * OrderQty)
--                  Cost    = Production.Product.StandardCost * OrderQty
--                  Profit  = Revenue - Cost
--                  Cancelled orders (SalesOrderHeader.Status = 6) are excluded.
-- =============================================================================

IF OBJECT_ID('Sales.usp_GetTotalProfit', 'P') IS NOT NULL
    DROP PROCEDURE Sales.usp_GetTotalProfit;
GO

CREATE PROCEDURE Sales.usp_GetTotalProfit
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        SUM(sod.LineTotal)                              AS TotalRevenue,
        SUM(p.StandardCost * sod.OrderQty)              AS TotalCost,
        SUM(sod.LineTotal - (p.StandardCost * sod.OrderQty)) AS TotalProfit
    FROM Sales.SalesOrderDetail       AS sod
    INNER JOIN Sales.SalesOrderHeader AS soh
        ON sod.SalesOrderID = soh.SalesOrderID
    INNER JOIN Production.Product     AS p
        ON sod.ProductID = p.ProductID
    WHERE soh.Status NOT IN (4, 6)  -- Exclude Rejected (4) and Cancelled (6) orders
      AND p.FinishedGoodsFlag = 1;  -- Finished goods only
END;
GO
