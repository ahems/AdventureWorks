# Start from the base Ubuntu image
FROM mcr.microsoft.com/devcontainers/base:ubuntu-22.04

# Install prerequisites
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        curl \
        wget \
        apt-transport-https \
        gnupg \
        ca-certificates \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Add Microsoft repository and install SQL Server command-line tools (includes bcp)
# Uses the modern /etc/apt/keyrings/ signed-by approach instead of deprecated apt-key
RUN mkdir -p /etc/apt/keyrings \
    && curl -sSL https://packages.microsoft.com/keys/microsoft.asc \
        | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
    && chmod a+r /etc/apt/keyrings/microsoft.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/ubuntu/22.04/prod jammy main" \
        | tee /etc/apt/sources.list.d/msprod.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends \
        mssql-tools18 \
        unixodbc-dev \
    && rm -rf /var/lib/apt/lists/*

# Add mssql-tools to PATH for all users
RUN echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' >> /etc/bash.bashrc

# Install .NET SDK 8.0 (for Azure Functions)
RUN wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh \
    && chmod +x dotnet-install.sh \
    && ./dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
    && rm dotnet-install.sh \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet

# Install Node.js 22.x (LTS - Node 20 reaches EOL April 2026)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Azure Static Web Apps CLI
RUN npm install -g @azure/static-web-apps-cli

# Install Data API Builder CLI globally for all users
RUN dotnet tool install Microsoft.DataApiBuilder --tool-path /usr/local/bin

# Install Azure Functions Core Tools
RUN wget -q https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb \
    && dpkg -i packages-microsoft-prod.deb \
    && rm packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y azure-functions-core-tools-4 \
    && rm -rf /var/lib/apt/lists/*
