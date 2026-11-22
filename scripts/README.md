---
title: Scripts (scripts/) — azd hooks, utilities, generators and data-management tools
summary: Folder index for the repository scripts with the rules for running them against the demo environment, the documentation link checker and the locale translation workflow; the full per-script reference lives in docs/reference/scripts.md.
audience: [developer, operator, ai-agent]
components: [scripts]
related: [docs/reference/scripts.md, docs/operations/deployment.md, docs/operations/seed-data-generation.md, docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md]
---

# Scripts (`scripts/`)

Automation scripts for the AdventureWorks demo, grouped by purpose. The per-script
reference (arguments, prerequisites and safety notes) is
**[docs/reference/scripts.md](../docs/reference/scripts.md)**.

| Folder | Contents |
|---|---|
| `hooks/` | azd lifecycle hooks (bash only), referenced from `azure.yaml`. See [deployment](../docs/operations/deployment.md) for the order and what each hook does |
| `utilities/` | Operator and developer utilities, including `azure-auth.py` for authenticated calls, Foundry agent definitions (`agents/`) and the docs link checker |
| `generators/` | AI content and translation generators for seed data |
| `data-management/` | Export, manufacturing-content and validation tools for seed data. See [seed data generation](../docs/operations/seed-data-generation.md) |

Seed SQL and CSV files live in [`seed-job/sql/`](../seed-job/sql/README.md); test scripts
live in [`tests/scripts/`](../tests/scripts/README.md).

## Rules

- Do not move or rename hooks without updating `azure.yaml`.
- Run scripts from the repository root. Read only the azd values a script needs
  (`azd env get-value KEY --no-prompt`).
- SQL and Storage are private after deployment, so tools that connect to them directly
  need a VNet-connected host. Prefer the deployed APIs.
- For auth-protected endpoints use
  [`azure-auth.py`](../docs/testing/AZURE_AUTHENTICATED_SCRIPTS.md); never print tokens.
- Generators and AI-backed scripts call paid models; run them intentionally.

## Documentation link checker

`utilities/check-docs-links.mjs` (Node.js built-ins only) scans tracked and untracked (not ignored) `*.md` files (plus `llms.txt` when present) and validates relative links, images, reference-style links, HTML `<a href>`/`<img src>` targets and GitHub-style heading anchors. External URLs and code blocks are ignored. Paths listed in `FROZEN_EXCLUDES` (empty by default) or passed with `--exclude` are not scanned, but links into them are still validated. Exit code is `1` when broken links are found.

```bash
node scripts/utilities/check-docs-links.mjs                       # report broken links
node scripts/utilities/check-docs-links.mjs --orphans             # also list docs/ files with no inbound links
node scripts/utilities/check-docs-links.mjs --orphans --strict    # fail on orphans too
node scripts/utilities/check-docs-links.mjs --json --exclude 'docs/archive/**'
node --test scripts/utilities/check-docs-links.test.mjs           # unit tests
```

## Locale translation gaps (audit and fill)

Workflow to ensure every locale has complete, correctly structured translations (run from repo root):

1. **Audit** – Report missing folders/files, key gaps, and wrapped keys:  
   `./scripts/utilities/audit-locale-gaps.sh`
2. **Re-translate** (optional) – Regenerate all non-en locale files:  
   `./scripts/utilities/batch-translate-language-file.sh`  
   Completed translations are downloaded to `app/src/locales` when `az` and `STORAGE_ACCOUNT_NAME` are available.
3. **Flatten** – Fix wrapped keys (`{"": "value"}` → `"value"`):  
   `./scripts/utilities/flatten-locale-json.sh --write`
4. **Re-audit** – Confirm no remaining gaps:  
   `./scripts/utilities/audit-locale-gaps.sh`

Required locales are taken from `seed-job/sql/Culture.csv` and `Culture-ai.csv`.

## Related docs

- [Scripts reference](../docs/reference/scripts.md)
- [Deployment and hooks](../docs/operations/deployment.md)
- [Seed data generation](../docs/operations/seed-data-generation.md)
- [Test scripts](../tests/scripts/README.md)
