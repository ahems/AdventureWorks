using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Logging;

namespace api_functions.Services;

/// <summary>
/// Handles all database write operations needed to generate a realistic AI-designed order:
/// create/find customer, create address, create sales order + details, decrement inventory.
/// </summary>
public class OrderGenerationService
{
    private readonly string _connectionString;
    private readonly ILogger<OrderGenerationService> _logger;

    public OrderGenerationService(string connectionString, ILogger<OrderGenerationService> logger)
    {
        _connectionString = connectionString;
        _logger = logger;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        return connection;
    }

    /// <summary>
    /// Look up a customer by CustomerID, returning basic name/email info.
    /// Returns null when the customer doesn't exist.
    /// </summary>
    public async Task<CustomerInfo?> GetCustomerAsync(int customerId)
    {
        using var connection = await GetConnectionAsync();
        var row = await connection.QueryFirstOrDefaultAsync(@"
            SELECT cust.CustomerID, p.FirstName, p.LastName,
                   ea.EmailAddress,
                   addr.AddressLine1, addr.City,
                   addr.StateProvinceID, addr.PostalCode
            FROM Sales.Customer cust
            INNER JOIN Person.Person p ON cust.PersonID = p.BusinessEntityID
            LEFT JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            LEFT JOIN Person.BusinessEntityAddress bea ON p.BusinessEntityID = bea.BusinessEntityID AND bea.AddressTypeID = 2
            LEFT JOIN Person.Address addr ON bea.AddressID = addr.AddressID
            WHERE cust.CustomerID = @CustomerId",
            new { CustomerId = customerId });

        if (row == null) return null;

        return new CustomerInfo
        {
            CustomerID = (int)row.CustomerID,
            FirstName = (string)row.FirstName,
            LastName = (string)row.LastName,
            Email = (string?)row.EmailAddress,
            AddressLine1 = (string?)row.AddressLine1,
            City = (string?)row.City,
            StateProvinceID = (int?)row.StateProvinceID,
            PostalCode = (string?)row.PostalCode
        };
    }

    /// <summary>
    /// Create a new customer (Person + EmailAddress + Address + Customer).
    /// Returns the new CustomerID.
    /// </summary>
    public async Task<int> CreateCustomerAsync(NewCustomerRequest req)
    {
        using var connection = await GetConnectionAsync();
        using var tx = connection.BeginTransaction();

        try
        {
            // 1. BusinessEntity
            var bizEntityId = await connection.ExecuteScalarAsync<int>(@"
                INSERT INTO Person.BusinessEntity (rowguid, ModifiedDate)
                OUTPUT INSERTED.BusinessEntityID
                VALUES (NEWID(), GETDATE())",
                transaction: tx);

            // 2. Person
            await connection.ExecuteAsync(@"
                INSERT INTO Person.Person
                    (BusinessEntityID, PersonType, NameStyle, FirstName, LastName, EmailPromotion, rowguid, ModifiedDate)
                VALUES
                    (@BizEntityId, 'IN', 0, @FirstName, @LastName, 0, NEWID(), GETDATE())",
                new { BizEntityId = bizEntityId, req.FirstName, req.LastName },
                transaction: tx);

            // 3. EmailAddress (EmailAddressID is IDENTITY — omit it and let SQL Server auto-generate)
            if (!string.IsNullOrEmpty(req.Email))
            {
                await connection.ExecuteAsync(@"
                    INSERT INTO Person.EmailAddress (BusinessEntityID, EmailAddress, rowguid, ModifiedDate)
                    VALUES (@BizEntityId, @Email, NEWID(), GETDATE())",
                    new { BizEntityId = bizEntityId, req.Email },
                    transaction: tx);
            }

            // 4. Address (look up StateProvinceID from state code + country)
            int stateProvinceId = req.StateProvinceID;
            if (stateProvinceId == 0 && !string.IsNullOrEmpty(req.StateCode))
            {
                stateProvinceId = await connection.ExecuteScalarAsync<int>(
                    "SELECT TOP 1 StateProvinceID FROM Person.StateProvince WHERE StateProvinceCode = @Code",
                    new { Code = req.StateCode },
                    transaction: tx);
            }
            if (stateProvinceId == 0) stateProvinceId = 9; // Default: British Columbia

            var addressId = await connection.ExecuteScalarAsync<int>(@"
                INSERT INTO Person.Address (AddressLine1, City, StateProvinceID, PostalCode, rowguid, ModifiedDate)
                OUTPUT INSERTED.AddressID
                VALUES (@AddressLine1, @City, @StateProvinceId, @PostalCode, NEWID(), GETDATE())",
                new { req.AddressLine1, req.City, StateProvinceId = stateProvinceId, req.PostalCode },
                transaction: tx);

            // 5. BusinessEntityAddress (type 2 = home)
            await connection.ExecuteAsync(@"
                INSERT INTO Person.BusinessEntityAddress (BusinessEntityID, AddressID, AddressTypeID, rowguid, ModifiedDate)
                VALUES (@BizEntityId, @AddressId, 2, NEWID(), GETDATE())",
                new { BizEntityId = bizEntityId, AddressId = addressId },
                transaction: tx);

            // 6. Password (minimal hash so the customer could log in later)
            await connection.ExecuteAsync(@"
                INSERT INTO Person.Password (BusinessEntityID, PasswordHash, PasswordSalt, rowguid, ModifiedDate)
                VALUES (@BizEntityId, 'L/Rlwxzp4w7RWmEgXX+/A7cXaePEPcp+KwQhl2fJL7w=', 'fs1ZGmY=', NEWID(), GETDATE())",
                new { BizEntityId = bizEntityId },
                transaction: tx);

            // 7. Customer
            var customerId = await connection.ExecuteScalarAsync<int>(@"
                INSERT INTO Sales.Customer (PersonID, TerritoryID, AccountNumber, rowguid, ModifiedDate)
                OUTPUT INSERTED.CustomerID
                SELECT @BizEntityId, 1,
                       'AW' + RIGHT('000000' + CAST(NEXT VALUE FOR Sales.SalesOrderNumber AS VARCHAR), 8),
                       NEWID(), GETDATE()",
                new { BizEntityId = bizEntityId },
                transaction: tx);

            tx.Commit();
            _logger.LogInformation("Created new customer CustomerID={CustomerId} for {FirstName} {LastName}",
                customerId, req.FirstName, req.LastName);

            return customerId;
        }
        catch
        {
            tx.Rollback();
            throw;
        }
    }

    /// <summary>
    /// Add a phone number for a person, looked up by their SalesCustomerID.
    /// Safe to call after CreateCustomerAsync. Does nothing if the phone is blank.
    /// </summary>
    public async Task AddPersonPhoneAsync(NewCustomerRequest req, string phoneNumber, int salesCustomerId)
    {
        if (string.IsNullOrWhiteSpace(phoneNumber)) return;

        using var connection = await GetConnectionAsync();

        // Resolve BusinessEntityID from Sales.Customer
        var bizEntityId = await connection.ExecuteScalarAsync<int?>(
            "SELECT PersonID FROM Sales.Customer WHERE CustomerID = @CustomerId",
            new { CustomerId = salesCustomerId });

        if (bizEntityId == null || bizEntityId == 0) return;

        // Default phone type = 1 (Cell)
        await connection.ExecuteAsync(@"
            IF NOT EXISTS (SELECT 1 FROM Person.PersonPhone WHERE BusinessEntityID = @BizEntityId AND PhoneNumber = @Phone)
            INSERT INTO Person.PersonPhone (BusinessEntityID, PhoneNumber, PhoneNumberTypeID, ModifiedDate)
            VALUES (@BizEntityId, @Phone, 1, GETDATE())",
            new { BizEntityId = bizEntityId, Phone = phoneNumber });

        _logger.LogInformation("Added phone for BusinessEntityID={BizEntityId}", bizEntityId);
    }

    /// <summary>
    /// Get or create a billing/shipping address for an existing customer.
    /// Returns the AddressID.
    /// </summary>
    public async Task<int> GetOrCreateAddressForCustomerAsync(int customerId)
    {
        using var connection = await GetConnectionAsync();

        // Try to find an existing address
        var existingAddressId = await connection.ExecuteScalarAsync<int?>(@"
            SELECT TOP 1 bea.AddressID
            FROM Person.BusinessEntityAddress bea
            INNER JOIN Sales.Customer c ON c.PersonID = bea.BusinessEntityID
            WHERE c.CustomerID = @CustomerId",
            new { CustomerId = customerId });

        if (existingAddressId.HasValue)
            return existingAddressId.Value;

        // Create a minimal address linked to the customer's person record
        var personId = await connection.ExecuteScalarAsync<int>(
            "SELECT PersonID FROM Sales.Customer WHERE CustomerID = @CustomerId",
            new { CustomerId = customerId });

        var addressId = await connection.ExecuteScalarAsync<int>(@"
            INSERT INTO Person.Address (AddressLine1, City, StateProvinceID, PostalCode, rowguid, ModifiedDate)
            OUTPUT INSERTED.AddressID
            VALUES ('1 Main St', 'Seattle', 79, '98101', NEWID(), GETDATE())");

        await connection.ExecuteAsync(@"
            INSERT INTO Person.BusinessEntityAddress (BusinessEntityID, AddressID, AddressTypeID, rowguid, ModifiedDate)
            VALUES (@PersonId, @AddressId, 2, NEWID(), GETDATE())",
            new { PersonId = personId, AddressId = addressId });

        return addressId;
    }

    /// <summary>
    /// Check stock for a product. Returns quantity in Finished Goods locations.
    /// </summary>
    public async Task<int> GetProductStockAsync(int productId)
    {
        using var connection = await GetConnectionAsync();
        var qty = await connection.ExecuteScalarAsync<int?>(@"
            SELECT ISNULL(SUM(pi.Quantity), 0)
            FROM Production.ProductInventory pi
            INNER JOIN Production.Location l ON pi.LocationID = l.LocationID
            WHERE pi.ProductID = @ProductId
              AND l.Name LIKE 'Finished Goods%'",
            new { ProductId = productId });
        return qty ?? 0;
    }

    /// <summary>
    /// Get the list price for a product.
    /// </summary>
    public async Task<decimal> GetProductPriceAsync(int productId)
    {
        using var connection = await GetConnectionAsync();
        return await connection.ExecuteScalarAsync<decimal>(
            "SELECT ISNULL(ListPrice, 0) FROM Production.Product WHERE ProductID = @ProductId",
            new { ProductId = productId });
    }

    /// <summary>
    /// Look up the best active SpecialOfferID for a product. Returns 1 (No Discount) if none.
    /// </summary>
    public async Task<int> GetBestSpecialOfferAsync(int productId)
    {
        using var connection = await GetConnectionAsync();
        var offerId = await connection.ExecuteScalarAsync<int?>(@"
            SELECT TOP 1 sop.SpecialOfferID
            FROM Sales.SpecialOfferProduct sop
            INNER JOIN Sales.SpecialOffer so ON sop.SpecialOfferID = so.SpecialOfferID
            WHERE sop.ProductID = @ProductId
              AND so.StartDate <= GETDATE()
              AND so.EndDate >= GETDATE()
              AND so.DiscountPct > 0
            ORDER BY so.DiscountPct DESC",
            new { ProductId = productId });
        return offerId ?? 1; // 1 = No Discount
    }

    /// <summary>
    /// Create a complete sales order with details and decrement inventory.
    /// Returns the new SalesOrderID.
    /// </summary>
    public async Task<int> CreateOrderAsync(CreateOrderRequest req)
    {
        using var connection = await GetConnectionAsync();
        using var tx = connection.BeginTransaction();

        try
        {
            var addressId = await GetOrCreateAddressForCustomerAsync(req.CustomerId);

            // Determine ship method (use cheapest available, ID 1)
            var shipMethodId = await connection.ExecuteScalarAsync<int>(
                "SELECT TOP 1 ShipMethodID FROM Purchasing.ShipMethod ORDER BY ShipBase",
                transaction: tx);

            var orderDate = DateTime.UtcNow;
            var dueDate = orderDate.AddDays(7);

            // Insert SalesOrderHeader (Status 1 = Pending / In Process)
            // TotalDue is a computed column (SubTotal + TaxAmt + Freight) — do not include it
            var salesOrderId = await connection.ExecuteScalarAsync<int>(@"
                INSERT INTO Sales.SalesOrderHeader
                    (RevisionNumber, OrderDate, DueDate, Status, OnlineOrderFlag,
                     CustomerID, ShipToAddressID, BillToAddressID,
                     ShipMethodID, SubTotal, TaxAmt, Freight,
                     rowguid, ModifiedDate)
                OUTPUT INSERTED.SalesOrderID
                VALUES
                    (1, @OrderDate, @DueDate, 1, 1,
                     @CustomerId, @AddressId, @AddressId,
                     @ShipMethodId, 0, 0, 0,
                     NEWID(), GETDATE())",
                new
                {
                    OrderDate = orderDate,
                    DueDate = dueDate,
                    req.CustomerId,
                    AddressId = addressId,
                    ShipMethodId = shipMethodId
                },
                transaction: tx);

            decimal subTotal = 0;
            short detailLineNum = 1;

            foreach (var item in req.Items)
            {
                var unitPrice = item.UnitPrice > 0 ? item.UnitPrice
                    : await connection.ExecuteScalarAsync<decimal>(
                        "SELECT ListPrice FROM Production.Product WHERE ProductID = @pid",
                        new { pid = item.ProductId },
                        transaction: tx);

                var specialOfferId = item.SpecialOfferID > 0 ? item.SpecialOfferID
                    : await connection.ExecuteScalarAsync<int?>(@"
                        SELECT TOP 1 sop.SpecialOfferID
                        FROM Sales.SpecialOfferProduct sop
                        INNER JOIN Sales.SpecialOffer so ON sop.SpecialOfferID = so.SpecialOfferID
                        WHERE sop.ProductID = @pid
                          AND so.StartDate <= GETDATE() AND so.EndDate >= GETDATE()
                          AND so.DiscountPct > 0
                        ORDER BY so.DiscountPct DESC",
                        new { pid = item.ProductId },
                        transaction: tx) ?? 1;

                var discountPct = await connection.ExecuteScalarAsync<decimal>(
                    "SELECT DiscountPct FROM Sales.SpecialOffer WHERE SpecialOfferID = @id",
                    new { id = specialOfferId },
                    transaction: tx);

                var lineTotal = unitPrice * item.Quantity * (1 - discountPct);
                subTotal += lineTotal;

                await connection.ExecuteAsync(@"
                    INSERT INTO Sales.SalesOrderDetail
                        (SalesOrderID, CarrierTrackingNumber, OrderQty, ProductID,
                         SpecialOfferID, UnitPrice, UnitPriceDiscount, ModifiedDate)
                    VALUES
                        (@SalesOrderId, NULL, @Qty, @ProductId,
                         @SpecialOfferId, @UnitPrice, @DiscountPct, GETDATE())",
                    new
                    {
                        SalesOrderId = salesOrderId,
                        Qty = item.Quantity,
                        item.ProductId,
                        SpecialOfferId = specialOfferId,
                        UnitPrice = unitPrice,
                        DiscountPct = discountPct
                    },
                    transaction: tx);

                // Decrement inventory in the first Finished Goods location that has stock
                await connection.ExecuteAsync(@"
                    UPDATE TOP (1) pi
                    SET pi.Quantity = pi.Quantity - @Qty,
                        pi.ModifiedDate = GETDATE()
                    FROM Production.ProductInventory pi
                    INNER JOIN Production.Location l ON pi.LocationID = l.LocationID
                    WHERE pi.ProductID = @ProductId
                      AND l.Name LIKE 'Finished Goods%'
                      AND pi.Quantity >= @Qty",
                    new { Qty = item.Quantity, item.ProductId },
                    transaction: tx);

                detailLineNum++;
            }

            // Calculate tax (8.75%) and freight (flat $5)
            var taxAmt = subTotal * 0.0875m;
            var freight = 5.00m;
            var totalDue = subTotal + taxAmt + freight;

            // TotalDue is computed — only set the constituent columns
            await connection.ExecuteAsync(@"
                UPDATE Sales.SalesOrderHeader
                SET SubTotal = @SubTotal, TaxAmt = @TaxAmt, Freight = @Freight
                WHERE SalesOrderID = @SalesOrderId",
                new { SubTotal = subTotal, TaxAmt = taxAmt, Freight = freight, SalesOrderId = salesOrderId },
                transaction: tx);

            tx.Commit();
            _logger.LogInformation("Created SalesOrderID={SalesOrderId} for CustomerID={CustomerId} with {ItemCount} items, total=${Total:N2}",
                salesOrderId, req.CustomerId, req.Items.Count, totalDue);

            return salesOrderId;
        }
        catch
        {
            tx.Rollback();
            throw;
        }
    }

    /// <summary>
    /// Look up store info (CustomerID + first AddressID) by Store.BusinessEntityID.
    /// Returns null if no Sales.Customer record exists for this store.
    /// </summary>
    public async Task<StoreInfo?> GetStoreInfoAsync(int storeBusinessEntityId)
    {
        using var connection = await GetConnectionAsync();

        var row = await connection.QueryFirstOrDefaultAsync(@"
            SELECT
                s.BusinessEntityID AS StoreID,
                s.Name AS StoreName,
                c.CustomerID,
                c.TerritoryID,
                bea.AddressID
            FROM Sales.Store s
            INNER JOIN Sales.Customer c ON c.StoreID = s.BusinessEntityID
            LEFT JOIN Person.BusinessEntityAddress bea ON bea.BusinessEntityID = s.BusinessEntityID
            WHERE s.BusinessEntityID = @StoreId",
            new { StoreId = storeBusinessEntityId });

        if (row == null) return null;

        return new StoreInfo
        {
            StoreID = (int)row.StoreID,
            StoreName = (string)row.StoreName,
            CustomerID = (int)row.CustomerID,
            TerritoryID = (int?)row.TerritoryID,
            AddressID = row.AddressID == null ? null : (int?)row.AddressID
        };
    }

    /// <summary>
    /// Get or create an address for a store (via BusinessEntityAddress).
    /// Returns the AddressID to use for BillToAddressID / ShipToAddressID.
    /// </summary>
    public async Task<int> GetOrCreateAddressForStoreAsync(int storeBusinessEntityId)
    {
        using var connection = await GetConnectionAsync();

        var existingAddressId = await connection.ExecuteScalarAsync<int?>(@"
            SELECT TOP 1 bea.AddressID
            FROM Person.BusinessEntityAddress bea
            WHERE bea.BusinessEntityID = @StoreId
            ORDER BY bea.AddressTypeID",
            new { StoreId = storeBusinessEntityId });

        if (existingAddressId.HasValue)
            return existingAddressId.Value;

        // Create a default address for the store
        var addressId = await connection.ExecuteScalarAsync<int>(@"
            INSERT INTO Person.Address (AddressLine1, City, StateProvinceID, PostalCode, rowguid, ModifiedDate)
            OUTPUT INSERTED.AddressID
            VALUES ('1 Commerce Way', 'Seattle', 79, '98101', NEWID(), GETDATE())");

        await connection.ExecuteAsync(@"
            INSERT INTO Person.BusinessEntityAddress (BusinessEntityID, AddressID, AddressTypeID, rowguid, ModifiedDate)
            VALUES (@StoreId, @AddressId, 3, NEWID(), GETDATE())",
            new { StoreId = storeBusinessEntityId, AddressId = addressId });

        return addressId;
    }

    /// <summary>
    /// Create a B2B store order with line items. Returns the new SalesOrderID.
    /// </summary>
    public async Task<int> CreateStoreOrderAsync(CreateStoreOrderRequest req)
    {
        using var connection = await GetConnectionAsync();
        using var tx = connection.BeginTransaction();

        try
        {
            // Resolve CustomerID for the store
            var storeInfo = await GetStoreInfoAsync(req.StoreBusinessEntityId)
                ?? throw new InvalidOperationException($"No Customer record found for Store {req.StoreBusinessEntityId}");

            var addressId = req.AddressID ?? await GetOrCreateAddressForStoreAsync(req.StoreBusinessEntityId);

            // Use the provided ship method, or default to the cheapest option
            var shipMethodId = req.ShipMethodId > 0 ? req.ShipMethodId
                : await connection.ExecuteScalarAsync<int>(
                    "SELECT TOP 1 ShipMethodID FROM Purchasing.ShipMethod ORDER BY ShipBase",
                    transaction: tx);

            var orderDate = DateTime.UtcNow;
            var dueDate = req.DueDate?.ToUniversalTime() ?? orderDate.AddDays(14); // B2B default: 14-day terms

            // Insert SalesOrderHeader — OnlineOrderFlag=0 for manually placed orders
            var salesOrderId = await connection.ExecuteScalarAsync<int>(@"
                INSERT INTO Sales.SalesOrderHeader
                    (RevisionNumber, OrderDate, DueDate, Status, OnlineOrderFlag,
                     PurchaseOrderNumber, AccountNumber,
                     CustomerID, ShipToAddressID, BillToAddressID,
                     ShipMethodID, SubTotal, TaxAmt, Freight, Comment,
                     rowguid, ModifiedDate)
                OUTPUT INSERTED.SalesOrderID
                VALUES
                    (1, @OrderDate, @DueDate, 1, 0,
                     @PurchaseOrderNumber, @AccountNumber,
                     @CustomerId, @AddressId, @AddressId,
                     @ShipMethodId, 0, 0, 0, @Comment,
                     NEWID(), GETDATE())",
                new
                {
                    OrderDate = orderDate,
                    DueDate = dueDate,
                    PurchaseOrderNumber = req.PurchaseOrderNumber ?? (object)DBNull.Value,
                    AccountNumber = $"AW-STORE-{req.StoreBusinessEntityId:D6}",
                    CustomerId = storeInfo.CustomerID,
                    AddressId = addressId,
                    ShipMethodId = shipMethodId,
                    Comment = req.Comment ?? (object)DBNull.Value
                },
                transaction: tx);

            // Insert order line items
            var subTotal = 0m;
            foreach (var item in req.Items)
            {
                var unitPrice = item.UnitPrice > 0 ? item.UnitPrice
                    : await connection.ExecuteScalarAsync<decimal>(
                        "SELECT ISNULL(ListPrice, 0) FROM Production.Product WHERE ProductID = @ProductId",
                        new { item.ProductId }, transaction: tx);

                var discountedPrice = unitPrice * (1 - item.DiscountPct);
                var lineTotal = Math.Round(discountedPrice * item.Quantity, 2);
                subTotal += lineTotal;

                var specialOfferId = await connection.ExecuteScalarAsync<int?>(@"
                    SELECT TOP 1 sop.SpecialOfferID
                    FROM Sales.SpecialOfferProduct sop
                    INNER JOIN Sales.SpecialOffer so ON sop.SpecialOfferID = so.SpecialOfferID
                    WHERE sop.ProductID = @ProductId
                      AND so.StartDate <= GETDATE()
                      AND so.EndDate >= GETDATE()
                      AND so.DiscountPct > 0
                    ORDER BY so.DiscountPct DESC",
                    new { item.ProductId }, transaction: tx) ?? 1;

                await connection.ExecuteAsync(@"
                    INSERT INTO Sales.SalesOrderDetail
                        (SalesOrderID, OrderQty, ProductID, SpecialOfferID,
                         UnitPrice, UnitPriceDiscount, rowguid, ModifiedDate)
                    VALUES
                        (@SalesOrderId, @Qty, @ProductId, @SpecialOfferId,
                         @UnitPrice, @Discount, NEWID(), GETDATE())",
                    new
                    {
                        SalesOrderId = salesOrderId,
                        Qty = item.Quantity,
                        item.ProductId,
                        SpecialOfferId = specialOfferId,
                        UnitPrice = unitPrice,
                        Discount = item.DiscountPct
                    },
                    transaction: tx);

                // Decrement available stock — never go below zero
                await connection.ExecuteAsync(@"
                    UPDATE Production.ProductInventory
                    SET    Quantity     = CASE WHEN Quantity >= @Qty THEN Quantity - @Qty ELSE 0 END,
                           ModifiedDate = GETDATE()
                    WHERE  ProductID = @ProductId",
                    new { item.ProductId, Qty = (int)item.Quantity },
                    transaction: tx);
            }

            // Calculate tax (8.75%) and freight based on ship method
            var taxAmt = subTotal * 0.0875m;
            var freight = req.Items.Count switch { 0 => 0m, <= 5 => 15m, <= 20 => 25m, _ => 50m };

            await connection.ExecuteAsync(@"
                UPDATE Sales.SalesOrderHeader
                SET SubTotal = @SubTotal, TaxAmt = @TaxAmt, Freight = @Freight
                WHERE SalesOrderID = @SalesOrderId",
                new { SubTotal = subTotal, TaxAmt = taxAmt, Freight = freight, SalesOrderId = salesOrderId },
                transaction: tx);

            tx.Commit();
            _logger.LogInformation(
                "Created B2B store order SalesOrderID={SalesOrderId} for StoreID={StoreId} (CustomerID={CustomerId}), {ItemCount} items, total=${Total:N2}",
                salesOrderId, req.StoreBusinessEntityId, storeInfo.CustomerID, req.Items.Count, subTotal + taxAmt + freight);

            return salesOrderId;
        }
        catch
        {
            tx.Rollback();
            throw;
        }
    }

    /// <summary>
    /// Returns top-spending customers who have placed at least one order, sorted by total spend descending.
    /// </summary>
    public async Task<List<TopSpenderInfo>> GetTopSpendersAsync(int limit = 100)
    {
        using var connection = await GetConnectionAsync();
        var rows = await connection.QueryAsync<TopSpenderInfo>(@"
            SELECT TOP (@Limit)
                c.CustomerID,
                p.FirstName,
                p.LastName,
                ea.EmailAddress AS Email,
                CAST(SUM(soh.TotalDue) AS decimal(18,2)) AS TotalSpend,
                COUNT(soh.SalesOrderID) AS OrderCount
            FROM Sales.Customer c
            INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
            LEFT  JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            INNER JOIN Sales.SalesOrderHeader soh ON c.CustomerID = soh.CustomerID
            GROUP BY c.CustomerID, p.FirstName, p.LastName, ea.EmailAddress
            ORDER BY TotalSpend DESC",
            new { Limit = limit });

        return rows.ToList();
    }

    /// <summary>
    /// Returns a list of CustomerIDs that have placed at least one order.
    /// Used for random selection during bulk order generation.
    /// </summary>
    public async Task<List<int>> GetCustomerIdsWithOrdersAsync(int limit = 1000)
    {
        using var connection = await GetConnectionAsync();
        var ids = await connection.QueryAsync<int>(@"
            SELECT TOP (@Limit) c.CustomerID
            FROM Sales.Customer c
            INNER JOIN Sales.SalesOrderHeader soh ON c.CustomerID = soh.CustomerID
            INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
            GROUP BY c.CustomerID
            ORDER BY COUNT(soh.SalesOrderID) DESC",
            new { Limit = limit });

        return ids.ToList();
    }

    /// <summary>
    /// Returns a rich customer profile including order history for the AI persona builder.
    /// </summary>
    public async Task<CustomerProfile?> GetCustomerProfileAsync(int customerId)
    {
        using var connection = await GetConnectionAsync();

        var row = await connection.QueryFirstOrDefaultAsync(@"
            SELECT
                c.CustomerID,
                p.FirstName,
                p.LastName,
                ea.EmailAddress AS Email,
                COUNT(soh.SalesOrderID) AS OrderCount,
                COALESCE(CAST(SUM(soh.TotalDue) AS decimal(18,2)), 0) AS TotalSpend
            FROM Sales.Customer c
            INNER JOIN Person.Person p ON c.PersonID = p.BusinessEntityID
            LEFT  JOIN Person.EmailAddress ea ON p.BusinessEntityID = ea.BusinessEntityID
            LEFT  JOIN Sales.SalesOrderHeader soh ON c.CustomerID = soh.CustomerID
            WHERE c.CustomerID = @CustomerId
            GROUP BY c.CustomerID, p.FirstName, p.LastName, ea.EmailAddress",
            new { CustomerId = customerId });

        if (row == null) return null;

        // Fetch the most recent product names ordered by this customer
        var recentProducts = (await connection.QueryAsync<string>(@"
            SELECT TOP 15 pm.Name
            FROM Sales.SalesOrderHeader soh
            INNER JOIN Sales.SalesOrderDetail sod ON soh.SalesOrderID = sod.SalesOrderID
            INNER JOIN Production.Product pr ON sod.ProductID = pr.ProductID
            INNER JOIN Production.ProductModel pm ON pr.ProductModelID = pm.ProductModelID
            WHERE soh.CustomerID = @CustomerId
            ORDER BY soh.OrderDate DESC",
            new { CustomerId = customerId })).Distinct().ToList();

        return new CustomerProfile
        {
            CustomerID = (int)row.CustomerID,
            FirstName = (string)row.FirstName,
            LastName = (string)row.LastName,
            Email = (string?)row.Email,
            OrderCount = (int)row.OrderCount,
            TotalSpend = (decimal)row.TotalSpend,
            RecentProducts = recentProducts
        };
    }
}

public class CustomerInfo
{
    public int CustomerID { get; set; }
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string? Email { get; set; }
    public string? AddressLine1 { get; set; }
    public string? City { get; set; }
    public int? StateProvinceID { get; set; }
    public string? PostalCode { get; set; }
}

public class NewCustomerRequest
{
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string? Email { get; set; }
    public string AddressLine1 { get; set; } = "1 Main St";
    public string City { get; set; } = "Seattle";
    public string? StateCode { get; set; }
    public int StateProvinceID { get; set; } = 0;
    public string PostalCode { get; set; } = "98101";
}

public class CreateOrderRequest
{
    public int CustomerId { get; set; }
    public List<OrderLineItem> Items { get; set; } = new();
}

public class OrderLineItem
{
    public int ProductId { get; set; }
    public short Quantity { get; set; } = 1;
    public decimal UnitPrice { get; set; } = 0; // 0 = use list price
    public int SpecialOfferID { get; set; } = 0; // 0 = auto-detect best offer
}

public class TopSpenderInfo
{
    public int CustomerID { get; set; }
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string? Email { get; set; }
    public decimal TotalSpend { get; set; }
    public int OrderCount { get; set; }
}

public class CustomerProfile
{
    public int CustomerID { get; set; }
    public string FirstName { get; set; } = string.Empty;
    public string LastName { get; set; } = string.Empty;
    public string? Email { get; set; }
    public int OrderCount { get; set; }
    public decimal TotalSpend { get; set; }
    public List<string> RecentProducts { get; set; } = new();
}

public class StoreInfo
{
    public int StoreID { get; set; }
    public string StoreName { get; set; } = string.Empty;
    public int CustomerID { get; set; }
    public int? TerritoryID { get; set; }
    public int? AddressID { get; set; }
}

public class CreateStoreOrderRequest
{
    public int StoreBusinessEntityId { get; set; }
    public List<StoreOrderLineItem> Items { get; set; } = new();
    public int ShipMethodId { get; set; } = 0; // 0 = cheapest available
    public string? PurchaseOrderNumber { get; set; }
    public DateTime? DueDate { get; set; }
    public string? Comment { get; set; }
    public int? AddressID { get; set; }
}

public class StoreOrderLineItem
{
    public int ProductId { get; set; }
    public short Quantity { get; set; } = 1;
    public decimal UnitPrice { get; set; } = 0; // 0 = use list price
    public decimal DiscountPct { get; set; } = 0; // 0 = no discount
}
