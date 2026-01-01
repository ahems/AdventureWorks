using System.Data;
using Azure.Identity;
using Dapper;
using Microsoft.Data.SqlClient;
using api_functions.Models;

namespace api_functions.Services;

public class ReviewService
{
    private readonly string _connectionString;

    public ReviewService(string connectionString)
    {
        _connectionString = connectionString;
    }

    private async Task<IDbConnection> GetConnectionAsync()
    {
        var connection = new SqlConnection(_connectionString);
        var credential = new DefaultAzureCredential();
        var token = await credential.GetTokenAsync(new Azure.Core.TokenRequestContext(new[] { "https://database.windows.net/.default" }));
        connection.AccessToken = token.Token;
        await connection.OpenAsync();
        return connection;
    }

    public async Task<List<ProductReviewData>> GetProductReviewsForEmbeddingAsync()
    {
        using var connection = await GetConnectionAsync();

        // Get all product reviews that have comments and don't have embeddings yet
        var sql = @"
            SELECT 
                ProductReviewID,
                ProductID,
                ReviewerName,
                ReviewDate,
                Rating,
                Comments,
                ModifiedDate
            FROM Production.ProductReview
            WHERE Comments IS NOT NULL
              AND CommentsEmbedding IS NULL
            ORDER BY ProductID, ProductReviewID";

        var reviews = await connection.QueryAsync<ProductReviewData>(sql);
        return reviews.ToList();
    }

    public async Task SaveEmbeddingAsync(ProductReviewEmbedding embedding)
    {
        using var connection = await GetConnectionAsync();

        // Save embedding to ProductReview table
        var updateSql = @"
            UPDATE Production.ProductReview
            SET 
                CommentsEmbedding = @Embedding,
                ModifiedDate = GETDATE()
            WHERE ProductReviewID = @ProductReviewID";

        await connection.ExecuteAsync(updateSql, new
        {
            embedding.ProductReviewID,
            embedding.Embedding
        });
    }

    public async Task<List<ProductForReviewGeneration>> GetProductsForReviewGenerationAsync()
    {
        using var connection = await GetConnectionAsync();

        // Get all finished goods products with their English descriptions and review counts
        var sql = @"
            SELECT 
                p.ProductID,
                p.Name,
                pd.Description,
                COUNT(pr.ProductReviewID) AS ExistingReviewCount
            FROM Production.Product p
            LEFT JOIN Production.ProductModel pm ON p.ProductModelID = pm.ProductModelID
            LEFT JOIN Production.ProductModelProductDescriptionCulture pmx 
                ON pm.ProductModelID = pmx.ProductModelID AND pmx.CultureID = 'en'
            LEFT JOIN Production.ProductDescription pd ON pmx.ProductDescriptionID = pd.ProductDescriptionID
            LEFT JOIN Production.ProductReview pr ON p.ProductID = pr.ProductID
            WHERE p.FinishedGoodsFlag = 1
            GROUP BY p.ProductID, p.Name, pd.Description
            ORDER BY p.ProductID";

        var products = await connection.QueryAsync<ProductForReviewGeneration>(sql);
        return products.ToList();
    }

    public async Task SaveGeneratedReviewAsync(GeneratedReview review)
    {
        using var connection = await GetConnectionAsync();

        // Insert new review into database
        var insertSql = @"
            INSERT INTO Production.ProductReview 
            (ProductID, ReviewerName, ReviewDate, EmailAddress, Rating, Comments, ModifiedDate)
            VALUES 
            (@ProductID, @ReviewerName, GETDATE(), @EmailAddress, @Rating, @Comments, GETDATE())";

        await connection.ExecuteAsync(insertSql, new
        {
            review.ProductID,
            review.ReviewerName,
            review.EmailAddress,
            review.Rating,
            review.Comments
        });
    }
}
