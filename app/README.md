# AdventureWorks E-Commerce Application

A modern e-commerce web application built with React, TypeScript, and Vite, featuring a GraphQL API integration with the AdventureWorks database.

## Features

- 🛒 Full-featured e-commerce with shopping cart and wishlist
- 🎨 Modern UI with doodle-style design system
- 📱 Responsive design for all devices
- 🔍 Advanced search and filtering
- 🎯 Product categories and subcategories
- ⭐ Product reviews and ratings
- 🔐 User authentication
- 🌐 GraphQL API integration
- 🏥 **Health page** (`/health`) — status of all backend services (GraphQL API, MCP, Azure Functions) and the **Seed Job** (whether the database seed has finished; when running, shows “Running for X minutes Y seconds”)

## GraphQL API Integration

This app fetches data from a GraphQL API powered by Microsoft Data API Builder. See [GRAPHQL_INTEGRATION.md](./GRAPHQL_INTEGRATION.md) for detailed documentation.

### Quick Start

1. Copy the environment template:

```bash
cp .env.example .env
```

2. Update `.env` with your API URL:

```env
VITE_API_URL=https://your-api-url.azurecontainerapps.io/graphql
```

3. Install dependencies and run:

```bash
npm install
npm run dev
```

## Project info

## How can I edit this code?

There are several ways of editing your application.

**Use your preferred IDE**

Clone this repo and push changes.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

Deploy using `azd up` — see [QUICKSTART.md](../QUICKSTART.md) for details.

## Related docs

- Overall solution architecture and services: [README.md](../README.md)
- Azure deployment and azd workflow: [QUICKSTART.md](../QUICKSTART.md)
- Frontend local development details: [app/LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md)
- Data API Builder service and container config: [api/README.md](../api/README.md)
- Azure Functions and AI/MCP workflows: [api-functions/README.md](../api-functions/README.md)
- GraphQL naming rules from the AdventureWorks schema: [docs/architecture/DAB_NAMING_CONVENTIONS.md](../docs/architecture/DAB_NAMING_CONVENTIONS.md)
