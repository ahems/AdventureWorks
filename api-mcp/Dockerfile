# Build stage
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Copy csproj files and restore dependencies
COPY ["AdventureWorks/AdventureWorks.csproj", "AdventureWorks/"]
COPY ["ServiceDefaults/ServiceDefaults.csproj", "ServiceDefaults/"]
RUN dotnet restore "AdventureWorks/AdventureWorks.csproj"

# Copy everything else and build
COPY AdventureWorks/ AdventureWorks/
COPY ServiceDefaults/ ServiceDefaults/
WORKDIR "/src/AdventureWorks"
RUN dotnet build "AdventureWorks.csproj" -c Release -o /app/build

# Publish stage
FROM build AS publish
RUN dotnet publish "AdventureWorks.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
EXPOSE 8080
EXPOSE 8081

# Copy published app
COPY --from=publish /app/publish .

ENTRYPOINT ["dotnet", "AdventureWorks.dll"]
