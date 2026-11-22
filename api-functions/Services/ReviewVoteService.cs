using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;

namespace api_functions.Services;

public enum ReviewVoteOutcome
{
    Changed,
    Unchanged,
    NotFound,
    OwnReview,
}

public sealed record ReviewVoteResult(ReviewVoteOutcome Outcome, int ProductReviewId, int? ProductId, int HelpfulVotes, bool Voted);

/// <summary>
/// Records one "helpful" vote per person per review. The vote row and the
/// <c>Production.ProductReview.HelpfulVotes</c> counter change in the same SQL transaction.
/// </summary>
public interface IReviewVoteStore
{
    Task<ReviewVoteResult> AddVoteAsync(int productReviewId, int voterBusinessEntityId);
    Task<ReviewVoteResult> RemoveVoteAsync(int productReviewId, int voterBusinessEntityId);
}

public sealed class SqlReviewVoteStore(string connectionString) : IReviewVoteStore
{
    private sealed record ReviewRow(int ProductID, int? UserID, int HelpfulVotes);

    public Task<ReviewVoteResult> AddVoteAsync(int productReviewId, int voterBusinessEntityId) =>
        ChangeAsync(productReviewId, voterBusinessEntityId, add: true);

    public Task<ReviewVoteResult> RemoveVoteAsync(int productReviewId, int voterBusinessEntityId) =>
        ChangeAsync(productReviewId, voterBusinessEntityId, add: false);

    private async Task<ReviewVoteResult> ChangeAsync(int productReviewId, int voter, bool add)
    {
        await using var connection = new SqlConnection(connectionString);
        await connection.OpenAsync();
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        var args = new { productReviewId, voter };

        // UPDLOCK serializes concurrent votes on the same review so the counter matches the vote rows.
        var review = await connection.QuerySingleOrDefaultAsync<ReviewRow>(
            """
            SELECT ProductID, UserID, HelpfulVotes
            FROM Production.ProductReview WITH (UPDLOCK, ROWLOCK)
            WHERE ProductReviewID = @productReviewId
            """, args, transaction);
        if (review is null)
        {
            await transaction.RollbackAsync();
            return new(ReviewVoteOutcome.NotFound, productReviewId, null, 0, false);
        }

        if (review.UserID == voter)
        {
            await transaction.RollbackAsync();
            return new(ReviewVoteOutcome.OwnReview, productReviewId, review.ProductID, review.HelpfulVotes, false);
        }

        var changed = add
            ? await connection.ExecuteAsync(
                """
                INSERT INTO Production.ProductReviewVote (ProductReviewID, BusinessEntityID)
                SELECT @productReviewId, @voter
                WHERE NOT EXISTS (SELECT 1 FROM Production.ProductReviewVote
                                  WHERE ProductReviewID = @productReviewId AND BusinessEntityID = @voter)
                """, args, transaction)
            : await connection.ExecuteAsync(
                "DELETE FROM Production.ProductReviewVote WHERE ProductReviewID = @productReviewId AND BusinessEntityID = @voter",
                args, transaction);

        var votes = review.HelpfulVotes;
        if (changed == 1)
        {
            votes = await connection.ExecuteScalarAsync<int>(
                add
                    ? """
                      UPDATE Production.ProductReview
                      SET HelpfulVotes = HelpfulVotes + 1
                      OUTPUT inserted.HelpfulVotes
                      WHERE ProductReviewID = @productReviewId
                      """
                    : """
                      UPDATE Production.ProductReview
                      SET HelpfulVotes = CASE WHEN HelpfulVotes > 0 THEN HelpfulVotes - 1 ELSE 0 END
                      OUTPUT inserted.HelpfulVotes
                      WHERE ProductReviewID = @productReviewId
                      """, args, transaction);
        }

        await transaction.CommitAsync();
        return new(changed == 1 ? ReviewVoteOutcome.Changed : ReviewVoteOutcome.Unchanged,
            productReviewId, review.ProductID, votes, add);
    }
}
