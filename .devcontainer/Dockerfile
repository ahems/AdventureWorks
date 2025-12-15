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
RUN curl https://packages.microsoft.com/keys/microsoft.asc | apt-key add - \
    && curl https://packages.microsoft.com/config/ubuntu/22.04/prod.list | tee /etc/apt/sources.list.d/msprod.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends \
        mssql-tools18 \
        unixodbc-dev \
    && echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' >> /etc/bash.bashrc \
    && rm -rf /var/lib/apt/lists/*

# Install .NET SDK 8.0 (for Azure Functions)
RUN wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh \
    && chmod +x dotnet-install.sh \
    && ./dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
    && rm dotnet-install.sh \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet

# Install Node.js 20.x (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Install Azure Static Web Apps CLI
RUN npm install -g @azure/static-web-apps-cli

# Install Data API Builder CLI
RUN dotnet tool install -g Microsoft.DataApiBuilder \
    && echo 'export PATH="$PATH:/root/.dotnet/tools"' >> /etc/bash.bashrc

# Install Azure Functions Core Tools
RUN wget -q https://packages.microsoft.com/config/ubuntu/22.04/packages-microsoft-prod.deb \
    && dpkg -i packages-microsoft-prod.deb \
    && rm packages-microsoft-prod.deb \
    && apt-get update \
    && apt-get install -y azure-functions-core-tools-4 \
    && rm -rf /var/lib/apt/lists/*

# Ensure tools are available in PATH for all users
ENV PATH="${PATH}:/opt/mssql-tools18/bin:/root/.dotnet/tools"
