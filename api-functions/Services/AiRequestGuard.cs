using System.Net;
using System.Text;
using Microsoft.Azure.Functions.Worker.Http;

namespace api_functions.Services;

/// <summary>Request-size caps and shared 413/400/429 responses for the anonymous AI routes.</summary>
public static class AiRequestGuard
{
    public const int MaxBodyBytes = 8 * 1024;
    public const int MaxContextLength = 500;
    public const int MaxCultureIdLength = 16;
    public const int MaxAnswers = 20;
    public const int MaxQuestionOrAnswerLength = 300;
    public const int MaxProfileFieldLength = 50;
    public const int MaxPreferredColors = 20;
    public const int MaxSessionIdLength = 100;
    public const int MaxSearchQueryLength = 200;
    public const int MaxSuggestionQueryLength = 100;
    public const int MaxTopN = 50;

    /// <summary>Reads at most <see cref="MaxBodyBytes"/>; <c>TooLarge</c> is true when the body exceeds it.</summary>
    public static async Task<(string Body, bool TooLarge)> ReadBodyAsync(HttpRequestData request, CancellationToken cancellationToken = default)
    {
        if (request.Headers.TryGetValues("Content-Length", out var lengths)
            && long.TryParse(lengths.FirstOrDefault(), out var declared)
            && declared > MaxBodyBytes)
        {
            return (string.Empty, true);
        }

        using var buffer = new MemoryStream();
        var chunk = new byte[4096];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > MaxBodyBytes)
                return (string.Empty, true);
            buffer.Write(chunk, 0, read);
        }

        return (Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length), false);
    }

    public static string? Validate(HelpMeQuestionsRequest request)
    {
        if (request.Context?.Length > MaxContextLength)
            return $"context must be at most {MaxContextLength} characters";
        return ValidateCulture(request.CultureId);
    }

    public static string? Validate(HelpMeRecommendRequest request)
    {
        if (request.Answers.Count > MaxAnswers)
            return $"at most {MaxAnswers} answers are allowed";
        if (request.Answers.Any(answer => answer is null
                || answer.Question?.Length > MaxQuestionOrAnswerLength
                || answer.Answer?.Length > MaxQuestionOrAnswerLength))
            return $"each question and answer must be at most {MaxQuestionOrAnswerLength} characters";
        if (request.SessionId?.Length > MaxSessionIdLength)
            return $"sessionId must be at most {MaxSessionIdLength} characters";
        if (request.FirstName?.Length > MaxProfileFieldLength
            || request.Gender?.Length > MaxProfileFieldLength
            || request.HeightLabel?.Length > MaxProfileFieldLength)
            return $"profile fields must be at most {MaxProfileFieldLength} characters";
        if (request.PreferredColors is { } colors
            && (colors.Count > MaxPreferredColors || colors.Any(color => color?.Length > MaxProfileFieldLength)))
            return $"at most {MaxPreferredColors} preferred colours of up to {MaxProfileFieldLength} characters are allowed";
        return ValidateCulture(request.CultureId);
    }

    public static string? ValidateSemanticSearch(string query, int? topN, string? cultureId)
    {
        if (query.Length > MaxSearchQueryLength)
            return $"query must be at most {MaxSearchQueryLength} characters";
        if (topN is < 1 or > MaxTopN)
            return $"topN must be between 1 and {MaxTopN}";
        return ValidateCulture(cultureId);
    }

    private static string? ValidateCulture(string? cultureId) =>
        cultureId?.Length > MaxCultureIdLength ? $"cultureId must be at most {MaxCultureIdLength} characters" : null;

    public static async Task<HttpResponseData> PayloadTooLargeAsync(HttpRequestData request)
    {
        var response = request.CreateResponse(HttpStatusCode.RequestEntityTooLarge);
        await response.WriteAsJsonAsync(new { error = "Request body is too large", maxBytes = MaxBodyBytes });
        return response;
    }

    public static async Task<HttpResponseData> BadRequestAsync(HttpRequestData request, string message)
    {
        var response = request.CreateResponse(HttpStatusCode.BadRequest);
        await response.WriteAsJsonAsync(new { error = message });
        return response;
    }

    public static async Task<HttpResponseData> TooManyRequestsAsync(HttpRequestData request, AiRateLimitDecision decision)
    {
        var response = request.CreateResponse(HttpStatusCode.TooManyRequests);
        response.Headers.Add("Retry-After", decision.RetryAfterSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        await response.WriteAsJsonAsync(new
        {
            error = "rate_limited",
            message = "Too many AI requests. Please try again later.",
            retryAfterSeconds = decision.RetryAfterSeconds,
            scope = decision.Scope
        });
        return response;
    }
}
