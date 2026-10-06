FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Build with the repository root as context: docker build -f api-functions/Dockerfile .
COPY api-functions/api-functions.csproj api-functions/
RUN dotnet restore api-functions/api-functions.csproj

# Copy everything else and build
COPY api-functions/ api-functions/
COPY api-mcp/AdventureWorks/Services/PromotionProductData.cs api-mcp/AdventureWorks/Services/
WORKDIR /src/api-functions
RUN dotnet publish -c Release -o /app/publish

# Build runtime image
FROM mcr.microsoft.com/azure-functions/dotnet-isolated:4-dotnet-isolated10.0
WORKDIR /home/site/wwwroot

# Copy published app
COPY --from=build /app/publish .

# Azure Functions configuration
ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    ASPNETCORE_URLS=http://+:80

# Expose port 80
EXPOSE 80
