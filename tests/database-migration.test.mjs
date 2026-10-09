import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { splitStatements } from "../scripts/apply-database-migration.mjs";

test("finance migration keeps SQLite trigger bodies intact", () => {
  const sql = readFileSync(new URL("../sql/036_finance_core.sql", import.meta.url), "utf8");
  const statements = splitStatements(sql);
  const triggers = statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement));

  assert.equal(statements.length, 20);
  assert.equal(triggers.length, 7);
  assert.ok(triggers.every((statement) => /;\s*END$/i.test(statement)));
  assert.ok(statements.every((statement) => statement.trim() !== "END"));
});
