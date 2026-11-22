# Data API Builder (DAB) Naming Conventions

## Overview
Microsoft Data API Builder automatically generates GraphQL schemas from database tables. Understanding its naming conventions is crucial for querying the API correctly.

## Entity Naming Rules

### Standard Pluralization
Most entities follow simple pluralization rules:
- **Product** → `products` (list query), `product_by_pk` (single record)
- **Customer** → `customers` (list query), `customer_by_pk` (single record)
- **Category** → `productCategories` (list query), `productCategory_by_pk` (single record)

### Irregular Plurals
DAB respects English grammar for irregular plurals:
- **Person** → `people` (list query), `person_by_pk` (single record)

### camelCase Conversion
Database table names are converted to camelCase:
- **ProductCategory** → `productCategories`
- **SalesOrderHeader** → `salesOrderHeaders`
- **BusinessEntity** → `businessEntities`

### Compound Names
For multi-word table names, DAB maintains the case:
- **SalesPerson** → `salesPeople` (irregular plural)
- **EmailAddress** → `emailAddresses`

## Query Response Structure

All list queries return data in a consistent structure:
```graphql
{
  entityName {
    items {
      field1
      field2
    }
  }
}
```

Example:
```graphql
query {
  people {
    items {
      BusinessEntityID
      FirstName
      LastName
    }
  }
}
```

## Primary Key Queries

Single record queries use the `_by_pk` suffix:
```graphql
query {
  person_by_pk(BusinessEntityID: 1) {
    FirstName
    LastName
  }
}
```

## Relationship Fields

DAB generates relationship fields based on foreign keys:
- **personPhones** - One-to-many relationship
- **personCreditCards** - One-to-many relationship
- **salesPerson_by_pk** - Related entity

## Reserved Words & Special Cases

### Person Entity
The `Person` table in AdventureWorks is particularly interesting:
- List query: `people` (not `persons`)
- Single query: `person_by_pk`
- Related queries: `personPhones`, `personCreditCards`

This follows English grammar where "person" → "people" is the correct plural.

## Common Patterns

### Entity Name Discovery
To find the correct GraphQL field name for an entity:

1. **Use Introspection Query:**
```bash
curl -X POST https://your-api.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { queryType { fields { name } } } }"}'
```

2. **Search for Entity Name:**
```bash
# Find all fields containing "person"
curl -s -X POST https://your-api.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { queryType { fields { name } } } }"}' \
  | python3 -c "import sys, json; data = json.load(sys.stdin); print([f['name'] for f in data['data']['__schema']['queryType']['fields'] if 'person' in f['name'].lower()])"
```

## Entity Configuration Issues

### Entities with Invalid Column Names
DAB cannot generate GraphQL schemas for tables with columns containing spaces or special characters:

**Problem Entities Removed:**
- `AWBuildVersion` - Column `Database Version` has space
- `DatabaseLog` - Column `Post Time` has space
- `ErrorLog` - Incompatible data types

These were removed from `dab-config.json` to prevent API startup errors.

## Testing GraphQL Endpoints

Use the test script to verify all endpoints:
```bash
cd api
bash test-graphql-endpoints.sh
```

This will test:
- All entity list queries
- Primary key lookups
- Relationship queries
- Query response structure

## Reference

### Full List of Query Fields
Run introspection to see all available queries:
```bash
curl -s -X POST https://your-api.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { queryType { fields { name } } } }"}' \
  | python3 -m json.tool
```

### Common Entity Mappings
| Database Table | List Query | Single Query |
|---------------|------------|--------------|
| Product | `products` | `product_by_pk` |
| ProductCategory | `productCategories` | `productCategory_by_pk` |
| Customer | `customers` | `customer_by_pk` |
| Person | `people` | `person_by_pk` |
| SalesOrderHeader | `salesOrderHeaders` | `salesOrderHeader_by_pk` |
| SalesPerson | `salesPeople` | `salesPerson_by_pk` |

## Best Practices

1. **Always use introspection** to discover field names rather than guessing
2. **Test queries** with the test script after configuration changes
3. **Handle irregular plurals** (person → people, not persons)
4. **Remove problematic entities** with invalid column names from config
5. **Use camelCase** for all GraphQL queries (DAB converts automatically)

## Troubleshooting

### Query Field Not Found
**Error:** `Cannot query field "persons" on type "Query"`

**Solution:** Use introspection to find the correct field name:
- The entity `Person` uses `people` not `persons`
- Check for irregular plurals in English grammar

### Entity Not Available
**Error:** Entity defined in dab-config.json but not in GraphQL schema

**Possible Causes:**
1. Column names with spaces or special characters
2. Incompatible data types
3. Missing permissions in entity configuration

**Solution:** Check API logs and remove problematic entities from config.

## Related Documentation
- [GRAPHQL_INTEGRATION.md](./GRAPHQL_INTEGRATION.md) - Overall integration guide
- [API_CONFIGURATION.md](./API_CONFIGURATION.md) - DAB configuration details
- [../api/test-graphql-endpoints.sh](../api/test-graphql-endpoints.sh) - Endpoint testing script
