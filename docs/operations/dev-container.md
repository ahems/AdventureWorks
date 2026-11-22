---
title: Dev container and local tooling
summary: What the AdventureWorks dev container installs, the VS Code tasks and launch configurations it provides, and how to run it on Windows 11 with Docker Engine in WSL instead of Docker Desktop.
audience: [developer]
components: [devcontainer, api-functions, app, api, api-mcp]
related:
  - docs/operations/wsl-deployment.md
  - docs/operations/deployment.md
  - docs/testing/testing-strategy.md
  - docs/operations/troubleshooting.md
---

# Dev container and local tooling

The repository's dev container provides every CLI and SDK used to build, test and deploy the demo. Local tools run against the Azure-hosted demo services. SQL is private after deployment, so call the deployed DAB and Functions APIs instead of connecting directly.

## What the container provides

| Source | Contents |
| --- | --- |
| [`.devcontainer/Dockerfile`](../../.devcontainer/Dockerfile) | Ubuntu 24.04 devcontainers base image, curl/wget, Git LFS, Node.js 22 (NodeSource) and the Azure Static Web Apps CLI (`@azure/static-web-apps-cli`) |
| [`.devcontainer/devcontainer.json`](../../.devcontainer/devcontainer.json) features | Azure CLI, Git with LFS, Azure Developer CLI, PowerShell, .NET SDK 10.0 |
| VS Code extensions | Bicep, PowerShell, ESLint, Prettier, Tailwind CSS |
| Environment | `AZD_SKIP_FIRST_RUN=true`; the host must provide at least 8 GB of memory |
| [`global.json`](../../global.json) | .NET SDK `10.0.100`, `rollForward: latestFeature` |

When the container is created, `postCreateCommand` runs these steps in order:

1. `git lfs pull` (failures are ignored so an offline clone still opens)
2. `az bicep install`
3. `npm ci` in the repository root, `app/`, `app-admin/` and `app-manufacturing/`
4. `dotnet restore` for `api-functions`, `api-mcp/ServiceDefaults` and `api-mcp/AppHost`

The root `package.json` contains only `mssql` and `typescript`, which are used by the historic export scripts described in [Seed data generation](seed-data-generation.md). [`AdventureWorks.sln`](../../AdventureWorks.sln) contains `api-functions`, the `api-mcp` projects and both .NET test projects.

## VS Code tasks

Defined in [`.vscode/tasks.json`](../../.vscode/tasks.json):

| Task | What it does |
| --- | --- |
| `func: host start` | Starts the Functions host locally. It depends on `build (functions)`. |
| `build (functions)`, `clean (functions)`, `watch (functions)`, `restore (functions)` | .NET lifecycle tasks for `api-functions` |
| `build all` | Builds `api-functions/api-functions.csproj` only, despite its label |
| `start frontend` | Runs `npm run dev` in `app/` only |
| `build frontend`, `lint frontend` | Build or lint the storefront |
| `start api (DAB)` | Runs `dab start` in `api/`. Supply the `@env()` placeholders from `api/dab-config.json`; do not disable authentication. |
| `deploy app-admin`, `deploy api-functions` | Run `azd deploy` for one service |
| `reseed-demo-logins` | Builds the seed image with `az acr build`, then updates and starts the seed job directly |

> [!WARNING]
> `reseed-demo-logins` bypasses the azd hooks and changes a deployed resource in place, which conflicts with the [demo/POC policy](../../.github/copilot-instructions.md#azure-environment-policy-demopoc-only). Agents must not run it. The seed job keeps `SEED_SKIP_EXISTING=true`. To get a clean data set, the user recreates the environment, as described in [Deployment lifecycle](deployment.md#recreating-the-environment).

Admin and manufacturing are started from their own folders with `npm run dev`. All three Vite configs listen on port 8080, so run one at a time or pass `--port`. See [Troubleshooting](troubleshooting.md#authentication-and-authorization) for the OAuth redirect ports.

## Debugging and MCP configuration

- [`.vscode/launch.json`](../../.vscode/launch.json) has *Attach* and *Launch* configurations for the .NET Functions process, Chrome and Edge launch configurations for `http://localhost:5173`, and a *Full Stack* compound. The Functions project targets `net10.0`; *Attach* to the process started by the `func: host start` task.
- [`.vscode/mcp.json`](../../.vscode/mcp.json) registers the Azure AI Foundry MCP server, run with `uvx` from its Git repository. VS Code prompts for its inputs, and password-type inputs are not stored in the file.

For local Functions settings, copy [`api-functions/local.settings.example.json`](../../api-functions/local.settings.example.json) and never commit the populated file. Get `MCP_SERVICE_URL` with `azd env get-value MCP_SERVICE_URL --no-prompt` so it points at the Azure-hosted MCP service.

## Running dev containers on Windows 11 without Docker Desktop

This guide describes how to set up **Dev Containers** (https://containers.dev/) for local development using **Cursor** (https://www.cursor.sh/) on **Windows 11**, **without Docker Desktop**, by running **Docker Engine** (https://docs.docker.com/engine/) inside **Windows Subsystem for Linux (WSL)** (https://learn.microsoft.com/windows/wsl/).

This approach is:
- ✅ Free (no Docker Desktop licensing)
- ✅ Enterprise‑friendly
- ✅ Fully compatible with Dev Containers
- ✅ Fast and reliable

---

### Architecture Overview

Windows 11  
 └─ WSL 2 (Ubuntu 22.04 LTS)  
     ├─ Docker Engine (dockerd)  
     └─ Dev Containers  
          ↑  
       Cursor (Remote WSL + Dev Containers)

Cursor runs on Windows but connects to Linux tools inside WSL.

---

### Prerequisites

- Windows 11
- WSL enabled: https://learn.microsoft.com/windows/wsl/install
- Cursor installed: https://www.cursor.sh/
- Internet access (corporate proxy configuration may be required)

---

### Step 1: Install Ubuntu on WSL 2

Open **PowerShell** and run:

    wsl --install -d Ubuntu-22.04

This installs **Ubuntu 22.04 LTS**:
https://releases.ubuntu.com/22.04/

After installation:
- Create a Linux username and password
- Ubuntu will start automatically

Verify WSL status:

    wsl -l -v
    wsl --status

Expected:
- VERSION = 2
- Default version = 2

Docs:
https://learn.microsoft.com/windows/wsl/basic-commands

---

### Step 2: Update Ubuntu

Inside the Ubuntu terminal:

    sudo apt update

Docs:
https://help.ubuntu.com/community/AptGet/Howto

---

### Step 3: Install Docker Engine (No Docker Desktop)

This uses the **official Docker Engine for Linux**:
https://docs.docker.com/engine/

Docs:
https://docs.docker.com/engine/install/ubuntu/

Install prerequisites:

    sudo apt install -y \
      ca-certificates \
      curl \
      gnupg \
      lsb-release

Add Docker’s GPG key:

    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

Add Docker repository:

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

Update apt:

    sudo apt update

Install Docker Engine:

    sudo apt install -y \
      docker-ce \
      docker-ce-cli \
      containerd.io \
      docker-buildx-plugin \
      docker-compose-plugin

Docs:
https://docs.docker.com/engine/reference/commandline/docker/
https://docs.docker.com/compose/

---

### Step 4: Enable Docker Without sudo

    sudo usermod -aG docker $USER

Exit Ubuntu:

    exit

From PowerShell:

    wsl --shutdown

Reopen Ubuntu.

Docs:
https://docs.docker.com/engine/install/linux-postinstall/

---

### Step 5: Verify Docker

Inside Ubuntu:

    docker --version
    docker compose version
    docker run hello-world

Expected output includes:

    Hello from Docker!
    This message shows that your installation appears to be working correctly.

Docker is now running correctly inside WSL.

---

### Step 6: Create a Workspace Directory (Important)

Always keep project files **inside the WSL filesystem**, not under /mnt/c.

    mkdir -p ~/projects
    cd ~/projects

Why this matters:
- Faster filesystem performance
- Correct Linux file permissions
- Reliable file‑watching (Node, Vite, etc.)
- Fewer Dev Container issues

Docs:
https://learn.microsoft.com/windows/wsl/filesystems

---

### Step 7: Clone Your Repository

    git clone https://github.com/<org>/<repo>.git
    cd <repo>

Docs:
https://git-scm.com/docs/git-clone

---

### Step 8: Connect Cursor to WSL

1. Open Cursor: https://www.cursor.sh/
2. Press Ctrl + Shift + P
3. Select “Connect to WSL”
4. Choose Ubuntu‑22.04

Cursor reloads and is now connected to Linux.

Related:
https://learn.microsoft.com/windows/wsl/tutorials/wsl-vscode  
(Cursor uses the same Remote WSL architecture.)

---

### Step 9: Open the Project in Cursor

In Cursor:
- File → Open Folder
- Open:

    /home/<your-user>/projects/<repo>

You should see a WSL indicator in the UI.

---

### Step 10: Start the Dev Container

If the repository contains:

    .devcontainer/devcontainer.json

Then:

1. Ctrl + Shift + P
2. Dev Containers: Reopen in Container

Cursor will:
- Build the container image
- Start the container
- Attach the editor
- Forward ports automatically

Dev Containers docs:
https://containers.dev/
https://code.visualstudio.com/docs/devcontainers/containers

---

### Common Issues & Fixes

#### “Cannot resolve authority” when connecting to WSL

- Install the WSL extension:
  https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl

- Remove stale server folders:

    rm -rf ~/.vscode-server ~/.cursor-server

- Restart WSL:

    wsl --shutdown

Docs:
https://code.visualstudio.com/docs/remote/wsl

---

#### Docker permission denied

Check group membership:

    groups

Restart WSL after adding your user to the docker group.

---

### Notes for Corporate Environments

- No Docker Desktop → no commercial licensing concerns
- Uses open‑source Docker Engine
- Commonly approved in enterprise environments
- Proxy and custom CA certificates may need to be configured for:
  - Ubuntu
  - Docker
  - Dev Container builds

If asked by IT, describe the setup as:

Docker Engine running inside WSL 2 with Ubuntu 22.04 LTS.

---

### Result

You now have:
- WSL 2: https://learn.microsoft.com/windows/wsl/
- Ubuntu 22.04 LTS: https://ubuntu.com/download/server
- Docker Engine: https://docs.docker.com/engine/
- Cursor Remote WSL
- Dev Containers: https://containers.dev/

---

### Optional Enhancements

- WSL resource tuning (.wslconfig):  
  https://learn.microsoft.com/windows/wsl/wsl-config
- Dev Container Dockerfile best practices:  
  https://containers.dev/guide/dockerfile
- Docker build cache optimization:  
  https://docs.docker.com/build/cache/
- Corporate CA certificates in Docker:  
  https://docs.docker.com/engine/security/certificates/

## Related

- [Deploying from Windows with WSL](wsl-deployment.md)
- [Deployment lifecycle](deployment.md)
- [Testing strategy](../testing/testing-strategy.md)
- [Troubleshooting](troubleshooting.md)
