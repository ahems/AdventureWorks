---
title: Data API Builder (DAB) GraphQL and REST naming conventions
summary: How Data API Builder turns AdventureWorks tables and views into GraphQL query names, REST paths and list response shapes, and how to discover and paginate them.
audience: [developer, ai-agent]
components: [api, app, app-admin, app-manufacturing]
related: [../reference/dab-entities.md, ../services/dab-api.md, ../../api/README.md, data-stores.md]
---

# Data API Builder (DAB) GraphQL and REST naming conventions

Data API Builder (DAB) generates GraphQL field names and REST paths from the entity
names in [`api/dab-config.json`](../../api/dab-config.json). This page explains those
rules so you can write correct queries without guessing. The full list of the 69
entities (66 tables + 3 views) and their role permissions is in the
[DAB entity reference](../reference/dab-entities.md).

## Entity naming rules

No entity overrides its `rest` or `graphql` settings, so every entity uses the DAB
defaults:

| Item | Rule | Example (`Person`) |
| ---- | ---- | ------------------ |
| GraphQL list query | camelCase plural (English pluralisation) | `people` |
| GraphQL single record | camelCase singular + `_by_pk` | `person_by_pk` |
| GraphQL mutations | `create<Entity>`, `update<Entity>`, `delete<Entity>` | `createPerson` |
| REST collection | `/api/<EntityName>` (PascalCase, case-sensitive) | `/api/Person` |
| REST single record | `/api/<EntityName>/<pk-name>/<pk-value>` | `/api/Person/BusinessEntityID/1` |

### Standard and irregular plurals

- `Product` → `products`, `product_by_pk`
- `ProductCategory` → `productCategories`, `productCategory_by_pk`
- `SalesOrderHeader` → `salesOrderHeaders`
- `BusinessEntity` → `businessEntities`
- `EmailAddress` → `emailAddresses`
- `Person` → `people` (not `persons`)
- `SalesPerson` → `salesPeople`

### Relationship fields

DAB adds relationship fields for relationships declared in the configuration, for
example `personPhones` and `personCreditCards` on a person.

## Response shapes

GraphQL list queries always wrap results in `items`:

```graphql
query {
  people(first: 10) {
    items {
      BusinessEntityID
      FirstName
      LastName
    }
    hasNextPage
    endCursor
  }
}
```

REST collections return `{ "value": [...], "nextLink": "..." }`.

Single-record GraphQL queries return the object directly:

```graphql
query {
  person_by_pk(BusinessEntityID: 1) {
    FirstName
    LastName
  }
}
```

## Pagination

DAB returns **100 items per page by default**. This is a page size, not a total count.

- GraphQL: pass `first` and `after`, and follow `hasNextPage` / `endCursor`.
- REST: use `$first` and `$after`, or follow the returned `nextLink`. DAB uses
  `$first`, not `$top`, and does not support `$skip`.

## Discovering field names

GraphQL introspection is enabled. Use the authenticated helper so the request
carries a DAB-audience token and the `X-MS-API-ROLE` header:

```bash
python3 scripts/utilities/azure-auth.py request \
  --identity admin --resource dab --path /graphql --method POST \
  --data '{"query":"{ __schema { queryType { fields { name } } } }"}'
```

A quick REST check:

```bash
python3 scripts/utilities/azure-auth.py request \
  --identity manufacturing --resource dab --path '/api/Product?$first=5'
```

See [Authenticated local scripts](../testing/AZURE_AUTHENTICATED_SCRIPTS.md) for
identities and token handling.

## Tables that are not DAB entities

DAB can only expose tables whose columns and types it supports. These AdventureWorks
objects are deliberately not in the configuration:

| Object | Reason | Alternative |
| ------ | ------ | ----------- |
| `Person.Address` | `SpatialLocation` uses the SQL `geography` type | `AddressFunctions` in [api-functions](../services/functions.md) |
| `HumanResources.Employee` | `hierarchyid` columns | `Employee` entity backed by the `HumanResources.vEmployee` view |
| `Production.Document`, `Production.ProductDocument` | `hierarchyid` column | Not exposed |
| `Sales.GuestCartSession` | Guest cart state owned by Functions | Cart routes in api-functions |
| `dbo.RealtimeNotificationOutbox` | Internal Web PubSub outbox | See [real-time eventing](realtime-eventing.md) |
| `dbo.AWBuildVersion`, `dbo.DatabaseLog`, `dbo.ErrorLog` | Column names with spaces or unsupported types | Not exposed |

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `Cannot query field "persons" on type "Query"` | Use the generated plural (`people`). Check with introspection. |
| HTTP 200 with an `errors` array | Read the GraphQL `errors`; for `AUTH_NOT_AUTHENTICATED` or permission errors check the token audience and the `X-MS-API-ROLE` header. |
| Fewer rows than expected | Follow pagination; 100 is only the default page size. |
| Entity missing from the schema | Check the entity exists in `dab-config.json` and the role has `read` permission. |

## Related documentation

- [DAB entity reference](../reference/dab-entities.md) – all entities, roles and policies
- [DAB API service](../services/dab-api.md) – hosting, startup and configuration
- [Identity and authentication](identity-and-auth.md) – how DAB validates tokens and roles
- [`api/README.md`](../../api/README.md)
