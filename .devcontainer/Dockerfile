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
        git-lfs \
    && git lfs install \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x (LTS - Node 20 reaches EOL April 2026)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Azure Static Web Apps CLI
RUN npm install -g @azure/static-web-apps-cli

