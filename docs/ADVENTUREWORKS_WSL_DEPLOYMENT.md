# Local AdventureWorks Deployment from Windows Using WSL

This guide documents how to prepare a Windows laptop to clone and deploy the LFS-enabled AdventureWorks repository using Ubuntu in Windows Subsystem for Linux (WSL).

> [!IMPORTANT]
> Run this repository's deployment workflow from **Ubuntu in WSL**, not from Windows PowerShell. The repository uses Bash-based scripts, so native PowerShell is not a supported execution environment for this workflow.
>
> Docker is not required for this procedure because the application is built remotely.

## Prerequisites

- Windows Subsystem for Linux (WSL)
- Ubuntu 22.04 LTS or later installed in WSL
- Access to the `3cloud-sandbox/AdventureWorks` GitHub repository
- Access to the target Azure subscription

Keep the repository in the Linux filesystem, such as `~/src/AdventureWorks`, rather than under `/mnt/c`. This provides a Linux-native environment for Bash scripts, permissions, line endings, and tooling.

## 1. Open Ubuntu in WSL

Launch the Ubuntu terminal from Windows Terminal or the Start menu.

## 2. Install GitHub CLI

Install the GitHub CLI from its official package repository:

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
&& sudo mkdir -p -m 755 /etc/apt/keyrings \
&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
| sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
&& sudo apt update \
&& sudo apt install gh -y
```

## 3. Sign in to GitHub with SSO

Use the browser-based OAuth flow with HTTPS for Git operations:

```bash
gh auth login --web --git-protocol https
```

When prompted:

1. Select `GitHub.com`.
2. Authenticate with the GitHub account that has access to the `3cloud-sandbox` organization.
3. Complete the organization's SSO flow in the browser.

## 4. Install Git LFS

Install and initialize Git Large File Storage inside Ubuntu:

```bash
sudo apt update
sudo apt install git-lfs -y
git lfs install
```

Git LFS must be installed within WSL. A Git LFS installation on Windows does not configure the separate Ubuntu environment.

## 5. Clone the AdventureWorks Repository

Create a source directory in the WSL filesystem and clone the repository:

```bash
mkdir -p ~/src
cd ~/src
gh repo clone 3cloud-sandbox/AdventureWorks
cd AdventureWorks
```

## 6. Switch to the OAuth Demonstration Branch

Fetch the latest remote references and switch to the required branch:

```bash
git fetch origin
git switch copilot/oauth-authorization-demonstration-again
```

## 7. Download the Git LFS Content

Hydrate the LFS-managed files for the checked-out branch:

```bash
git lfs pull
```

## 8. Install Azure CLI

Install the Linux version of Azure CLI inside Ubuntu:

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
```

Sign in to Azure:

```bash
az login
```

If the required subscription is not the default subscription, select it explicitly:

```bash
az account set --subscription "<subscription-name-or-id>"
```

## 9. Install Azure Developer CLI

Install the Linux version of Azure Developer CLI inside Ubuntu:

```bash
curl -fsSL https://aka.ms/install-azd.sh | bash
```

Sign in to Azure Developer CLI:

```bash
azd auth login
```

## 10. Create and Configure an AZD Environment

From the repository root, create an environment with a random three-digit suffix and set the required Azure regions:

```bash
cd ~/src/AdventureWorks

ENV_SUFFIX=$((RANDOM % 900 + 100)) && \
azd env new "adamhems-adventureworks${ENV_SUFFIX}" --no-prompt && \
azd env set AZURE_LOCATION "eastus2" && \
azd env set FOUNDRY_LOCATION "swedencentral" && \
azd env set PLAYWRIGHT_LOCATION "westeurope"
```

This creates an environment name similar to:

```text
adamhems-adventureworks472
```

## 11. Deploy AdventureWorks

Run the deployment from the repository root:

```bash
azd up
```

The repository's Bash-based deployment scripts will execute within the Ubuntu/WSL environment, and application builds will run remotely.

## Returning to the Repository Later

For subsequent sessions, open Ubuntu in WSL and run:

```bash
cd ~/src/AdventureWorks
git switch copilot/oauth-authorization-demonstration-again
git pull
git lfs pull
azd up
```

If authentication has expired, sign in again before running the deployment:

```bash
gh auth login --web --git-protocol https
az login
azd auth login
```
