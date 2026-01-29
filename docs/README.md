# AdventureWorks Documentation

This directory contains technical documentation for the AdventureWorks e-commerce application, organized by topic.

## 📁 Documentation Structure

```
docs/
├── architecture/          # System design and architecture
├── features/             # Feature-specific documentation
│   ├── ai-agent/        # AI agent and MCP implementation
│   ├── authentication/   # Password and authentication flows
│   ├── email/           # Email and receipt generation
│   ├── internationalization/  # Translation and localization
│   ├── monitoring/      # Application Insights and telemetry
│   ├── reviews/         # Product review generation
│   ├── search/          # Semantic search and AI features
│   └── seo/             # SEO implementation
├── testing/             # Testing guides and results
└── data-management/     # Data export and management
```

## 🏗️ Architecture

**Location:** `architecture/`

- [DAB_NAMING_CONVENTIONS.md](architecture/DAB_NAMING_CONVENTIONS.md) - Data API Builder naming patterns and GraphQL schema generation

## ✨ Features

### AI Agent & MCP

**Location:** `features/ai-agent/`

- [AGENT_FRAMEWORK_MIGRATION.md](features/ai-agent/AGENT_FRAMEWORK_MIGRATION.md) - Migration to Microsoft Agent Framework
- [AI_AGENT_AUTOMATION.md](features/ai-agent/AI_AGENT_AUTOMATION.md) - Agent automation and workflows
- [AI_AGENT_DEPLOYMENT_SUMMARY.md](features/ai-agent/AI_AGENT_DEPLOYMENT_SUMMARY.md) - Deployment architecture
- [AI_AGENT_TELEMETRY_IMPLEMENTATION.md](features/ai-agent/AI_AGENT_TELEMETRY_IMPLEMENTATION.md) - Telemetry integration

### Authentication

**Location:** `features/authentication/`

- [PASSWORD_IMPLEMENTATION.md](features/authentication/PASSWORD_IMPLEMENTATION.md) - Password hashing and storage
- [PASSWORD_RESET_FLOW.md](features/authentication/PASSWORD_RESET_FLOW.md) - Password reset workflow

### Email & Receipts

**Location:** `features/email/`

- [SEND_EMAIL_FUNCTION.md](features/email/SEND_EMAIL_FUNCTION.md) - Azure Communication Services email
- [RECEIPT_GENERATION.md](features/email/RECEIPT_GENERATION.md) - PDF receipt generation
- [RECEIPT_GENERATION_FLOW.md](features/email/RECEIPT_GENERATION_FLOW.md) - Receipt workflow

### Internationalization

**Location:** `features/internationalization/`

- [LANGUAGE_FILE_TRANSLATION.md](features/internationalization/LANGUAGE_FILE_TRANSLATION.md) - UI translation process
- [LANGUAGE_TRANSLATION_DURABLE_FUNCTIONS.md](features/internationalization/LANGUAGE_TRANSLATION_DURABLE_FUNCTIONS.md) - Translation automation
- [EMOJI_IN_TRANSLATIONS.md](features/internationalization/EMOJI_IN_TRANSLATIONS.md) - Handling emojis in translations
- [TRANSLATION_BLOB_STORAGE.md](features/internationalization/TRANSLATION_BLOB_STORAGE.md) - Blob storage integration

### Monitoring & Telemetry

**Location:** `features/monitoring/`

- [APP_INSIGHTS_CONNECTION_STRING_FLOW.md](features/monitoring/APP_INSIGHTS_CONNECTION_STRING_FLOW.md) - Connection string configuration
- [APP_INSIGHTS_INTEGRATION.md](features/monitoring/APP_INSIGHTS_INTEGRATION.md) - Application Insights setup
- [TELEMETRY_GENERATION.md](features/monitoring/TELEMETRY_GENERATION.md) - Telemetry generation for testing

### Product Reviews

**Location:** `features/reviews/`

- [REVIEW_GENERATION.md](features/reviews/REVIEW_GENERATION.md) - AI-powered review generation
- [REVIEW_GENERATION_SCRIPTS.md](features/reviews/REVIEW_GENERATION_SCRIPTS.md) - Review generation scripts
- [REVIEW_GENERATION_WORKFLOW.md](features/reviews/REVIEW_GENERATION_WORKFLOW.md) - Review workflow

### Search

**Location:** `features/search/`

- [AI_SEARCH_TROUBLESHOOTING.md](features/search/AI_SEARCH_TROUBLESHOOTING.md) - Semantic search troubleshooting

### SEO

**Location:** `features/seo/`

- [SEO_COMPONENTS_IMPLEMENTATION.md](features/seo/SEO_COMPONENTS_IMPLEMENTATION.md) - SEO React components
- [SEO_IMPLEMENTATION.md](features/seo/SEO_IMPLEMENTATION.md) - Overall SEO strategy
- [ROBOTS_SITEMAP_TESTING.md](features/seo/ROBOTS_SITEMAP_TESTING.md) - robots.txt and sitemap testing

## 🧪 Testing

**Location:** `testing/`

- [AI_AND_MCP_TESTING_GUIDE.md](testing/AI_AND_MCP_TESTING_GUIDE.md) - Comprehensive AI and MCP testing guide
- [AI_CHAT_MCP_TESTING.md](testing/AI_CHAT_MCP_TESTING.md) - AI chat testing procedures
- [AZURE_PLAYWRIGHT_TESTING.md](testing/AZURE_PLAYWRIGHT_TESTING.md) - Playwright testing guide
- [AZURE_PLAYWRIGHT_TESTING_IMPLEMENTATION.md](testing/AZURE_PLAYWRIGHT_TESTING_IMPLEMENTATION.md) - Implementation details
- Test results and analysis documents

## 📊 Data Management

**Location:** `data-management/`

- [EMBEDDING_EXPORT.md](data-management/EMBEDDING_EXPORT.md) - Exporting vector embeddings
- [EMBEDDING_EXPORT_LIMITATION.md](data-management/EMBEDDING_EXPORT_LIMITATION.md) - Known limitations
- [TRANSLATION_EXPORT.md](data-management/TRANSLATION_EXPORT.md) - Exporting translations

## 🎬 Media

- `adventureworks-demo.gif` - Animated demo of the application
- `adventureworks-demo.webm` - Video demo

## 📝 Documentation Guidelines

When adding new documentation:

1. **Choose the right location:**
   - `architecture/` - System-wide design decisions
   - `features/<topic>/` - Feature-specific implementation
   - `testing/` - Testing procedures and results
   - `data-management/` - Data export/import procedures

2. **Use clear titles and structure:**
   - Start with overview/purpose
   - Include prerequisites
   - Provide step-by-step procedures
   - Add troubleshooting section

3. **Keep it up-to-date:**
   - Update docs when implementation changes
   - Archive outdated docs with date prefix
   - Link related documents

4. **Cross-reference:**
   - Link to related code files
   - Reference other documentation
   - Include working examples

## 🔗 Quick Links

- [Main README](../README.md) - Project overview
- [Quick Start Guide](../QUICKSTART.md) - Local development setup
- [Scripts Documentation](../scripts/README.md) - Automation scripts
- [Test Scripts](../tests/scripts/README.md) - API and integration tests
- [Playwright Tests](../tests/README.md) - E2E testing
