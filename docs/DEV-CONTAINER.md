# Dev Containers on Windows 11 (Without Docker Desktop)

This guide describes how to set up **Dev Containers** (https://containers.dev/) for local development using **Cursor** (https://www.cursor.sh/) on **Windows 11**, **without Docker Desktop**, by running **Docker Engine** (https://docs.docker.com/engine/) inside **Windows Subsystem for Linux (WSL)** (https://learn.microsoft.com/windows/wsl/).

This approach is:
- ✅ Free (no Docker Desktop licensing)
- ✅ Enterprise‑friendly
- ✅ Fully compatible with Dev Containers
- ✅ Fast and reliable

---

## Architecture Overview

Windows 11  
 └─ WSL 2 (Ubuntu 22.04 LTS)  
     ├─ Docker Engine (dockerd)  
     └─ Dev Containers  
          ↑  
       Cursor (Remote WSL + Dev Containers)

Cursor runs on Windows but connects to Linux tools inside WSL.

---

## Prerequisites

- Windows 11
- WSL enabled: https://learn.microsoft.com/windows/wsl/install
- Cursor installed: https://www.cursor.sh/
- Internet access (corporate proxy configuration may be required)

---

## Step 1: Install Ubuntu on WSL 2

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

## Step 2: Update Ubuntu

Inside the Ubuntu terminal:

    sudo apt update

Docs:
https://help.ubuntu.com/community/AptGet/Howto

---

## Step 3: Install Docker Engine (No Docker Desktop)

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

## Step 4: Enable Docker Without sudo

    sudo usermod -aG docker $USER

Exit Ubuntu:

    exit

From PowerShell:

    wsl --shutdown

Reopen Ubuntu.

Docs:
https://docs.docker.com/engine/install/linux-postinstall/

---

## Step 5: Verify Docker

Inside Ubuntu:

    docker --version
    docker compose version
    docker run hello-world

Expected output includes:

    Hello from Docker!
    This message shows that your installation appears to be working correctly.

Docker is now running correctly inside WSL.

---

## Step 6: Create a Workspace Directory (Important)

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

## Step 7: Clone Your Repository

    git clone https://github.com/<org>/<repo>.git
    cd <repo>

Docs:
https://git-scm.com/docs/git-clone

---

## Step 8: Connect Cursor to WSL

1. Open Cursor: https://www.cursor.sh/
2. Press Ctrl + Shift + P
3. Select “Connect to WSL”
4. Choose Ubuntu‑22.04

Cursor reloads and is now connected to Linux.

Related:
https://learn.microsoft.com/windows/wsl/tutorials/wsl-vscode  
(Cursor uses the same Remote WSL architecture.)

---

## Step 9: Open the Project in Cursor

In Cursor:
- File → Open Folder
- Open:

    /home/<your-user>/projects/<repo>

You should see a WSL indicator in the UI.

---

## Step 10: Start the Dev Container

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

## Common Issues & Fixes

### “Cannot resolve authority” when connecting to WSL

- Install the WSL extension:
  https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl

- Remove stale server folders:

    rm -rf ~/.vscode-server ~/.cursor-server

- Restart WSL:

    wsl --shutdown

Docs:
https://code.visualstudio.com/docs/remote/wsl

---

### Docker permission denied

Check group membership:

    groups

Restart WSL after adding your user to the docker group.

---

## Notes for Corporate Environments

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

## Result

You now have:
- WSL 2: https://learn.microsoft.com/windows/wsl/
- Ubuntu 22.04 LTS: https://ubuntu.com/download/server
- Docker Engine: https://docs.docker.com/engine/
- Cursor Remote WSL
- Dev Containers: https://containers.dev/

---

## Optional Enhancements

- WSL resource tuning (.wslconfig):  
  https://learn.microsoft.com/windows/wsl/wsl-config
- Dev Container Dockerfile best practices:  
  https://containers.dev/guide/dockerfile
- Docker build cache optimization:  
  https://docs.docker.com/build/cache/
- Corporate CA certificates in Docker:  
  https://docs.docker.com/engine/security/certificates/

---

Happy coding! 🚀