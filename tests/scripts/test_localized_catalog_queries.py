"""Guard against cross-culture duplication in agent-facing catalog SQL.

Production.ProductCategory and Production.ProductSubcategory hold one row per
CultureID. A statement that joins them must pick one culture (or deduplicate
with SELECT DISTINCT or MIN(alias.Name) and GROUP BY); otherwise every row is
multiplied by the culture count, inflating sums, sitemaps, reports and MCP
tool output.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE_ROOTS = ("api-functions", "api-mcp/AdventureWorks")
LITERAL = re.compile(
    r'(?:\$@|@\$|@)"((?:[^"]|"")*)"|"""(.*?)"""|"((?:[^"\\\n]|\\.)*)"', re.S)
LOCALIZED_TABLE = re.compile(
    r"\b(?:FROM|JOIN)\s+Production\.Product(?:Sub)?category\s+(?:AS\s+)?(?!WITH\b|ON\b|WHERE\b)(\w+)",
    re.I)


def unscoped_localized_names(sql):
    aliases = {match.group(1) for match in LOCALIZED_TABLE.finditer(sql)}
    deduplicated = re.search(r"\bSELECT\s+DISTINCT\b", sql, re.I) or any(
        re.search(rf"\bMIN\(\s*{re.escape(alias)}\.Name\s*\)", sql, re.I) for alias in aliases)
    if deduplicated:
        return []
    return sorted(
        alias for alias in aliases
        if not re.search(rf"\b{re.escape(alias)}\.CultureID\b", sql, re.I))


def catalog_violations():
    violations = []
    for root in SOURCE_ROOTS:
        for path in sorted((ROOT / root).rglob("*.cs")):
            if {"bin", "obj"} & set(path.parts):
                continue
            text = path.read_text(encoding="utf-8")
            for match in LITERAL.finditer(text):
                sql = next(group for group in match.groups() if group is not None)
                for alias in unscoped_localized_names(sql):
                    line = text.count("\n", 0, match.start()) + 1
                    violations.append(f"{path.relative_to(ROOT)}:{line} ({alias})")
    return violations


class LocalizedCatalogQueryTests(unittest.TestCase):
    def test_rule_flags_unscoped_joins_and_accepts_culture_or_dedup(self):
        join = ("SELECT pc.Name FROM Production.ProductCategory pc "
                "LEFT JOIN Production.ProductSubcategory ps ON ps.ProductCategoryID = pc.ProductCategoryID")
        self.assertEqual(unscoped_localized_names(join), ["pc", "ps"])
        self.assertEqual(unscoped_localized_names(join + " AND RTRIM(ps.CultureID) = 'en'"), ["pc"])
        self.assertEqual(unscoped_localized_names(
            join + " AND RTRIM(ps.CultureID) = 'en' WHERE RTRIM(pc.CultureID) = 'en'"), [])
        self.assertEqual(unscoped_localized_names(join.replace("SELECT pc.Name", "SELECT MIN(pc.Name)")), [])
        self.assertEqual(unscoped_localized_names(join.replace("SELECT pc.Name", "SELECT DISTINCT pc.Name")), [])
        self.assertEqual(unscoped_localized_names(
            "SELECT MAX(ProductCategoryID) FROM Production.ProductCategory"), [])

    def test_service_queries_select_one_culture_for_localized_tables(self):
        self.assertEqual(catalog_violations(), [])


if __name__ == "__main__":
    unittest.main()
