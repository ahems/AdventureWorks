"""Guard against OUTPUT clauses that SQL Server rejects on realtime-notified tables.

The seed job adds an AFTER trigger (RealtimeNotify_*) to every table listed in
seed-job/sql/realtime-notification-outbox.sql. SQL Server refuses
INSERT/UPDATE/DELETE/MERGE ... OUTPUT without INTO on a table with enabled
triggers, so service SQL that does so fails at runtime with HTTP 500.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE_ROOTS = ("api-functions", "api-mcp/AdventureWorks")
OUTBOX_SQL = ROOT / "seed-job/sql/realtime-notification-outbox.sql"
LITERAL = re.compile(
    r'(?:\$@|@\$|@)"((?:[^"]|"")*)"|"""(.*?)"""|"((?:[^"\\\n]|\\.)*)"', re.S)
TARGET = re.compile(
    r"\b(?:INSERT\s+(?:INTO\s+)?|UPDATE\s+|DELETE\s+(?:FROM\s+)?|MERGE\s+(?:INTO\s+)?)"
    r"(\w+\.\w+)", re.I)


def triggered_tables():
    text = OUTBOX_SQL.read_text(encoding="utf-8")
    block = re.search(r"INSERT INTO @tables VALUES(.*?);", text, re.S)
    return {name.lower() for name in re.findall(r"\('([\w.]+)'\)", block.group(1))}


def unbuffered_outputs(sql, tables):
    """Return triggered tables targeted by a DML statement whose OUTPUT clause lacks INTO."""
    found = []
    for statement in re.split(r";|\bEND\b", sql, flags=re.I):
        target = TARGET.search(statement)
        if not target or target.group(1).lower() not in tables:
            continue
        output = re.search(r"\bOUTPUT\b(.*)", statement, re.I | re.S)
        if output and not re.search(r"\bINTO\b", output.group(1), re.I):
            found.append(target.group(1))
    return found


def violations():
    tables = triggered_tables()
    result = []
    for root in SOURCE_ROOTS:
        for path in sorted((ROOT / root).rglob("*.cs")):
            if {"bin", "obj"} & set(path.parts):
                continue
            text = path.read_text(encoding="utf-8")
            for match in LITERAL.finditer(text):
                sql = next(group for group in match.groups() if group is not None)
                for table in unbuffered_outputs(sql, tables):
                    line = text.count("\n", 0, match.start()) + 1
                    result.append(f"{path.relative_to(ROOT)}:{line} ({table})")
    return result


class TriggerOutputClauseTests(unittest.TestCase):
    def test_trigger_table_list_is_parsed(self):
        self.assertIn("production.productreview", triggered_tables())

    def test_rule_flags_output_without_into_on_triggered_tables(self):
        tables = {"production.productreview"}
        self.assertEqual(unbuffered_outputs(
            "UPDATE Production.ProductReview SET HelpfulVotes = 1 OUTPUT inserted.HelpfulVotes WHERE ProductReviewID = 1",
            tables), ["Production.ProductReview"])
        self.assertEqual(unbuffered_outputs(
            "INSERT INTO Production.ProductReview (Comments) OUTPUT INSERTED.ProductReviewID INTO @ids VALUES ('x')",
            tables), [])
        self.assertEqual(unbuffered_outputs(
            "UPDATE Sales.SalesOrderHeader SET Status = 7 OUTPUT INSERTED.SalesOrderID WHERE Status = 5",
            tables), [])
        self.assertEqual(unbuffered_outputs(
            "UPDATE Production.ProductReview SET HelpfulVotes = 1 WHERE ProductReviewID = 1; "
            "SELECT HelpfulVotes FROM Production.ProductReview", tables), [])

    def test_service_sql_buffers_output_on_triggered_tables(self):
        self.assertEqual(violations(), [])


if __name__ == "__main__":
    unittest.main()
