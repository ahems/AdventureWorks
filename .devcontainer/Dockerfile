# Start from the base Ubuntu image
FROM mcr.microsoft.com/devcontainers/base:ubuntu-22.04

# Install prerequisites
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        curl \
        apt-transport-https \
        gnupg \
        ca-certificates \
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

# Ensure bcp is available in PATH for all users
ENV PATH="${PATH}:/opt/mssql-tools18/bin"
