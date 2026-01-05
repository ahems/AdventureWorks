using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using AddressFunctions.Models;
using AddressFunctions.Services;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;

namespace AddressFunctions.Functions;

public class AddressFunctions
{
    private readonly ILogger<AddressFunctions> _logger;
    private readonly AddressService _addressService;

    public AddressFunctions(ILogger<AddressFunctions> logger, AddressService addressService)
    {
        _logger = logger;
        _addressService = addressService;
    }

    /// <summary>
    /// Get all addresses with pagination
    /// </summary>
    /// <param name="req">HTTP request with optional query parameters: limit (default 100), offset (default 0)</param>
    /// <returns>Paginated list of addresses</returns>
    /// <response code="200">Successfully retrieved addresses</response>
    /// <response code="500">Internal server error</response>
    [Function("GetAddresses")]
    public async Task<HttpResponseData> GetAddresses(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "addresses")] HttpRequestData req)
    {
        _logger.LogInformation("GetAddresses function processing request");

        try
        {
            // Parse query parameters
            var queryParams = QueryHelpers.ParseQuery(req.Url.Query);
            var limit = queryParams.TryGetValue("limit", out var limitValue) && int.TryParse(limitValue, out var l) ? l : 100;
            var offset = queryParams.TryGetValue("offset", out var offsetValue) && int.TryParse(offsetValue, out var o) ? o : 0;

            var addresses = await _addressService.GetAddressesAsync(limit, offset);

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(addresses);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting addresses");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while retrieving addresses" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Get a specific address by ID
    /// </summary>
    /// <param name="req">HTTP request</param>
    /// <param name="id">The address ID</param>
    /// <returns>Address details</returns>
    /// <response code="200">Successfully retrieved address</response>
    /// <response code="404">Address not found</response>
    /// <response code="500">Internal server error</response>
    [Function("GetAddressById")]
    public async Task<HttpResponseData> GetAddressById(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "addresses/{id:int}")] HttpRequestData req,
        int id)
    {
        _logger.LogInformation("GetAddressById function processing request for ID: {Id}", id);

        try
        {
            var address = await _addressService.GetAddressByIdAsync(id);

            if (address == null)
            {
                var notFoundResponse = req.CreateResponse(HttpStatusCode.NotFound);
                await notFoundResponse.WriteAsJsonAsync(new { error = $"Address with ID {id} not found" });
                return notFoundResponse;
            }

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(address);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting address {Id}", id);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while retrieving the address" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Create a new address
    /// </summary>
    /// <param name="req">HTTP request with address data in body</param>
    /// <returns>Created address</returns>
    /// <response code="201">Address created successfully</response>
    /// <response code="400">Invalid request body or missing required fields</response>
    /// <response code="500">Internal server error</response>
    [Function("CreateAddress")]
    public async Task<HttpResponseData> CreateAddress(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "addresses")] HttpRequestData req)
    {
        _logger.LogInformation("CreateAddress function processing request");

        try
        {
            var createRequest = await req.ReadFromJsonAsync<CreateAddressRequest>();

            if (createRequest == null)
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteAsJsonAsync(new { error = "Invalid request body" });
                return badRequest;
            }

            // Validate required fields
            if (string.IsNullOrWhiteSpace(createRequest.AddressLine1) ||
                string.IsNullOrWhiteSpace(createRequest.City) ||
                string.IsNullOrWhiteSpace(createRequest.PostalCode))
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteAsJsonAsync(new { error = "AddressLine1, City, and PostalCode are required" });
                return badRequest;
            }

            var address = await _addressService.CreateAddressAsync(createRequest);

            var response = req.CreateResponse(HttpStatusCode.Created);
            response.Headers.Add("Location", $"{req.Url.Scheme}://{req.Url.Authority}/api/addresses/{address.AddressID}");
            await response.WriteAsJsonAsync(address);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating address");
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while creating the address" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Update an existing address
    /// </summary>
    /// <param name="req">HTTP request with updated address data</param>
    /// <param name="id">The address ID to update</param>
    /// <returns>Updated address</returns>
    /// <response code="200">Address updated successfully</response>
    /// <response code="404">Address not found</response>
    /// <response code="400">Invalid request body</response>
    /// <response code="500">Internal server error</response>
    [Function("UpdateAddress")]
    public async Task<HttpResponseData> UpdateAddress(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "addresses/{id:int}")] HttpRequestData req,
        int id)
    {
        _logger.LogInformation("UpdateAddress function processing request for ID: {Id}", id);

        try
        {
            var updateRequest = await req.ReadFromJsonAsync<UpdateAddressRequest>();

            if (updateRequest == null)
            {
                var badRequest = req.CreateResponse(HttpStatusCode.BadRequest);
                await badRequest.WriteAsJsonAsync(new { error = "Invalid request body" });
                return badRequest;
            }

            var address = await _addressService.UpdateAddressAsync(id, updateRequest);

            if (address == null)
            {
                var notFoundResponse = req.CreateResponse(HttpStatusCode.NotFound);
                await notFoundResponse.WriteAsJsonAsync(new { error = $"Address with ID {id} not found" });
                return notFoundResponse;
            }

            var response = req.CreateResponse(HttpStatusCode.OK);
            await response.WriteAsJsonAsync(address);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating address {Id}", id);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while updating the address" });
            return errorResponse;
        }
    }

    /// <summary>
    /// Delete an address
    /// </summary>
    /// <param name="req">HTTP request</param>
    /// <param name="id">The address ID to delete</param>
    /// <returns>No content on success</returns>
    /// <response code="204">Address deleted successfully</response>
    /// <response code="404">Address not found</response>
    /// <response code="500">Internal server error</response>
    [Function("DeleteAddress")]
    public async Task<HttpResponseData> DeleteAddress(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "addresses/{id:int}")] HttpRequestData req,
        int id)
    {
        _logger.LogInformation("DeleteAddress function processing request for ID: {Id}", id);

        try
        {
            var deleted = await _addressService.DeleteAddressAsync(id);

            if (!deleted)
            {
                var notFoundResponse = req.CreateResponse(HttpStatusCode.NotFound);
                await notFoundResponse.WriteAsJsonAsync(new { error = $"Address with ID {id} not found" });
                return notFoundResponse;
            }

            var response = req.CreateResponse(HttpStatusCode.NoContent);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting address {Id}", id);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteAsJsonAsync(new { error = "An error occurred while deleting the address" });
            return errorResponse;
        }
    }
}
