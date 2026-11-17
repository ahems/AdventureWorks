FROM node:22-bookworm-slim AS node
FROM mcr.microsoft.com/dotnet/sdk:10.0

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /suite
COPY tests/auth/container/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/assurance \
    && /opt/assurance/bin/pip install --no-cache-dir -r /tmp/requirements.txt
ENV PATH="/opt/assurance/bin:${PATH}" \
    PLAYWRIGHT_BROWSERS_PATH="/opt/browsers" \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1

COPY app/package.json app/package-lock.json app/.npmrc ./app/
RUN npm --prefix app ci --ignore-scripts \
    && cd app && npx playwright install --with-deps chromium

COPY app-manufacturing/package.json app-manufacturing/package-lock.json ./app-manufacturing/
RUN npm --prefix app-manufacturing ci --ignore-scripts

COPY app-admin/package.json app-admin/package-lock.json ./app-admin/
RUN npm --prefix app-admin ci --ignore-scripts

COPY mcp-inspector/package.json mcp-inspector/package-lock.json ./mcp-inspector/
RUN npm --prefix mcp-inspector ci --ignore-scripts

COPY . .
RUN dotnet restore api-functions.Tests/api-functions.Tests.csproj \
    && dotnet restore api-mcp/AdventureWorks.Tests/AdventureWorks.Tests.csproj \
    && dotnet restore tests/auth/private/PrivateProbe.csproj

ENTRYPOINT ["python3", "-B", "tests/auth/container/entrypoint.py"]
