#!/bin/bash
# Launch seed job container in interactive PowerShell mode for debugging

echo "Launching seed job container with interactive PowerShell..."
echo "===================================================="
echo ""
echo "Inside the container you can:"
echo "  - List files: ls /app"
echo "  - Run diagnostics: pwsh /app/diagnose.ps1"
echo "  - Run seed script: pwsh /app/seed-database.ps1"
echo "  - Check env vars: \$env:AZURE_RESOURCE_GROUP"
echo "  - Exit: exit"
echo ""
echo "===================================================="
echo ""

docker run --rm -it \
  -e AZURE_RESOURCE_GROUP="rg-adamhems-adventureworks15" \
  -e SQL_SERVER_NAME="av-sql-agtyjfry4y6w6" \
  -e SQL_DATABASE_NAME="AdventureWorks" \
  -e USER_MANAGED_IDENTITY_NAME="av-identity-agtyjfry4y6w6" \
  -e TENANT_ID="ed9aa516-5358-4016-a8b2-b6ccb99142d0" \
  -e AZURE_CLIENT_ID="5de33f7d-713b-4ffb-ab5f-d028ed3ec872" \
  --entrypoint pwsh \
  avacragtyjfry4y6w6.azurecr.io/seed-job:latest
