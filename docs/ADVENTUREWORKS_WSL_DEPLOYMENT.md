# Local AdventureWorks Deployment from Windows Using WSL

This guide documents how to prepare a Windows laptop to clone and deploy the LFS-enabled AdventureWorks repository using Ubuntu in Windows Subsystem for Linux (WSL).

> \[!IMPORTANT]
> Run this repository's deployment workflow from \*\*Ubuntu in WSL\*\*, not from Windows PowerShell. The repository uses Bash-based scripts, so native PowerShell is not the supported execution environment for this workflow.
>
> Docker is not required for this procedure because the application is built remotely.

## Prerequisites

* Windows Subsystem for Linux (WSL)
* Ubuntu 22.04 LTS installed in WSL
* Access to the `3cloud-sandbox/AdventureWorks` GitHub repository
* Access to the target Azure subscription

Keep the repository in the Linux filesystem, such as `\~/src/AdventureWorks`, rather than under `/mnt/c`.

## 1\. Install GitHub CLI

```bash
(type -p wget >/dev/null || (sudo apt update \&\& sudo apt install wget -y)) \\
\&\& sudo mkdir -p -m 755 /etc/apt/keyrings \\
\&\& out=$(mktemp) \&\& wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
\&\& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \\
\&\& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
\&\& sudo mkdir -p -m 755 /etc/apt/sources.list.d \\
\&\& echo "deb \[arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
| sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
\&\& sudo apt update \\
\&\& sudo apt install gh -y
```

## 2\. Sign in to GitHub with SSO

```bash
gh auth login --web --git-protocol https
```

Select `GitHub.com`, authenticate with the account that has access to the `3cloud-sandbox` organization, and complete the organization's SSO flow in the browser.

## 3\. Install Git LFS

```bash
sudo apt update
sudo apt install git-lfs -y
git lfs install
```

Git LFS must be installed inside WSL. A Windows Git LFS installation does not configure the Ubuntu environment.

## 4\. Clone AdventureWorks

```bash
mkdir -p \~/src
cd \~/src
gh repo clone 3cloud-sandbox/AdventureWorks
cd AdventureWorks
```

## 5\. Switch to the OAuth Demonstration Branch

```bash
git fetch origin
git switch copilot/oauth-authorization-demonstration-again
```

## 6\. Hydrate the Git LFS Content

```bash
git lfs pull
```

## 7\. Install Azure CLI

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

## 8\. Install Azure Developer CLI

```bash
curl -fsSL https://aka.ms/install-azd.sh | bash
```

Sign in:

```bash
azd auth login
```

## 9\. Install .NET 10 SDK

The `api-functions` project targets `net10.0`. The repository's `global.json` specifies SDK `10.0.100` with `rollForward` set to `latestFeature`.

On Ubuntu 22.04, enable the Ubuntu .NET backports repository and install the .NET 10 SDK:

```bash
sudo add-apt-repository ppa:dotnet/backports -y
sudo apt update
sudo apt install dotnet-sdk-10.0 -y
```

A compatible later .NET 10 SDK can be selected because of the repository's roll-forward policy.

## 10\. Create and Configure the AZD Environment

From the repository root, create an environment with a random three-digit suffix and configure the required Azure regions:

```bash
cd \~/src/AdventureWorks

ENV\_SUFFIX=$((RANDOM % 900 + 100)) \&\& \\
azd env new "adventureworks${ENV\_SUFFIX}" --no-prompt \&\& \\
azd env set AZURE\_LOCATION "eastus2" \&\& \\
azd env set FOUNDRY\_LOCATION "swedencentral"
```

This creates an environment name such as `adamhems-adventureworks472`.

## 11\. Deploy AdventureWorks

Use `--no-prompt` when running `azd up`:

```bash
azd up --no-prompt
```

The repository's `azure.yaml` requires the Foundry agents extension (`azure.ai.agents`). With `--no-prompt`, AZD automatically installs required extensions and their dependencies rather than waiting for interactive confirmation. This includes the Foundry-related dependencies required by the repository.

The repository's Bash-based deployment scripts execute within the Ubuntu/WSL environment, while the applications all build remotely.

## Returning to the Repository Later

For subsequent sessions:

```bash
cd \~/src/AdventureWorks
git switch copilot/oauth-authorization-demonstration-again
git pull
git lfs pull
azd up --no-prompt
```

If authentication has expired:

```bash
gh auth login --web --git-protocol https
az login
azd auth login
```

