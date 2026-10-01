# Local AdventureWorks Deployment from Windows Using WSL

This guide documents how to prepare a Windows laptop to clone and deploy the LFS-enabled AdventureWorks repository using Ubuntu 22.04 in Windows Subsystem for Linux (WSL).

> [!IMPORTANT]
> Run this repository's deployment workflow from **Ubuntu in WSL**, not from Windows PowerShell. The repository uses Bash-based scripts, while parts of the deployment also require **PowerShell 7+ (`pwsh`) inside WSL**.
>
> Docker is not required for this procedure because the application is built remotely.

## Prerequisites

- Windows Subsystem for Linux (WSL)
- Ubuntu 22.04 LTS installed in WSL
- Access to the `<reponame>/AdventureWorks` GitHub repository
- Access to the target Azure subscription

Keep the repository in the Linux filesystem, such as `~/src/AdventureWorks`, rather than under `/mnt/c`.

## 1. Install GitHub CLI

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

## 2. Sign in to GitHub with SSO

```bash
gh auth login --web --git-protocol https
```

Select `GitHub.com`, authenticate with the account you want to use.

## 3. Install Git LFS

```bash
sudo apt update
sudo apt install git-lfs -y
git lfs install
```

Git LFS must be installed inside WSL. A Windows Git LFS installation does not configure the Ubuntu environment.

## 4. Clone AdventureWorks

```bash
mkdir -p ~/src
cd ~/src
gh repo clone <reponame>/AdventureWorks
cd AdventureWorks
```

## 6. Hydrate the Git LFS Content

```bash
git lfs pull
```

## 7. Install Azure CLI

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
```

Sign in:

```bash
az login
```

If required, select the target subscription:

```bash
az account set --subscription "<subscription-name-or-id>"
```

## 8. Install Azure Developer CLI

```bash
curl -fsSL https://aka.ms/install-azd.sh | bash
```

Sign in:

```bash
azd auth login
```

## 9. Install .NET 10 SDK

The `api-functions` project targets `net10.0`. The repository's `global.json` specifies SDK `10.0.100` with `rollForward` set to `latestFeature`.

On Ubuntu 22.04, enable the Ubuntu .NET backports repository and install the .NET 10 SDK:

```bash
sudo add-apt-repository ppa:dotnet/backports -y
sudo apt update
sudo apt install dotnet-sdk-10.0 -y
```

A compatible later .NET 10 SDK can be selected because of the repository's roll-forward policy. This procedure was validated with SDK `10.0.112`.

## 10. Install PowerShell 7+

Parts of the deployment require the `pwsh` executable, so PowerShell 7+ must also be installed **inside Ubuntu/WSL**. Installing PowerShell on the Windows host is not sufficient.

Configure the Microsoft package repository for the installed Ubuntu release and install PowerShell:

```bash
sudo apt-get update
sudo apt-get install -y wget apt-transport-https software-properties-common
source /etc/os-release
wget -q https://packages.microsoft.com/config/ubuntu/$VERSION_ID/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
rm packages-microsoft-prod.deb
sudo apt-get update
sudo apt-get install -y powershell
```

PowerShell is invoked on Linux with `pwsh`.

## 11. Create and Configure the AZD Environment

From the repository root, create an environment with a random three-digit suffix and configure the required Azure regions as per this example:

```bash
cd ~/src/AdventureWorks

ENV_SUFFIX=$((RANDOM % 900 + 100)) && \
azd env new "adventureworks${ENV_SUFFIX}" --no-prompt && \
azd env set AZURE_LOCATION "eastus2" && \
azd env set FOUNDRY_LOCATION "swedencentral"
```

## 12. Deploy AdventureWorks

Use `--no-prompt` when running `azd up`:

```bash
azd up --no-prompt
```

The repository's `azure.yaml` requires the Foundry agents extension (`azure.ai.agents`). With `--no-prompt`, AZD automatically installs required extensions and their dependencies rather than waiting for interactive confirmation.

The repository runs from Ubuntu/WSL. Bash scripts execute under Linux, and any PowerShell-based deployment steps use the Linux `pwsh` installation. Application builds run remotely, so Docker is not required locally for this workflow.
