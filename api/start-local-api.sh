#!/bin/bash

# Start local Data API Builder server
# This will run the API with the development configuration that allows CORS from any origin

echo "Starting Data API Builder locally..."
echo "API will be available at: http://localhost:5000"
echo "GraphQL endpoint: http://localhost:5000/graphql"
echo "REST endpoint: http://localhost:5000/api"
echo ""

cd /workspaces/AdventureWorks/api

# Check if .env file exists
if [ ! -f .env ]; then
    echo "Error: .env file not found!"
    echo "Please run the setup script first:"
    echo "  cd /workspaces/AdventureWorks"
    echo "  ./setup-local-dev.sh"
    exit 1
fi

# Load environment variables from .env
echo "Loading environment variables from .env..."
export $(cat .env | grep -v '^#' | xargs)

# Check if DAB is installed
if ! command -v dab &> /dev/null; then
    echo "Installing Data API Builder..."
    dotnet tool install -g Microsoft.DataApiBuilder
fi

# Start DAB with the development configuration
echo "Starting DAB with development configuration..."
echo "Press Ctrl+C to stop"
echo ""
dab start --config dab-config.json
