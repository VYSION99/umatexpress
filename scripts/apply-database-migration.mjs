#!/usr/bin/env node
/**
 * Applies a SQL migration file to the Turso database over its HTTP pipeline.
 *
 * The combined manual migration (sql/000_umatexpress_full_migration.sql) is
 * written to be re-runnable: tables and indexes are created with IF NOT EXISTS,
 * and the few additive columns sit in passes the app itself already tolerates
 * `duplicate column name` for. This runner applies the same rule — a statement
 * the database has already seen is reported as skipped, never as a failure —
 * so an operator can point it at a live database without first probing every
 * column by hand.
 *
 * Usage:
 *   node scripts/apply-database-migration.mjs                       # the combined bundle
 *   node scripts/apply-database-migration.mjs sql/024_hostel_refunds.sql
 *   node scripts/apply-database-migration.mjs --dry-run             # count statements only
 *   node scripts/apply-database-migration.mjs --verify              # list tables and schema passes
 *
 * Credentials come from the environment, else from .env:
 * TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FILE = "sql/000_umatexpress_full_migration.sql";
const BATCH_SIZE = 20;

/** Already-applied statements answer with one of these; none of them is an error here. */
const TOLERATED = /already exists|duplicate column name|duplicate index|duplicate key/i;

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function databaseConfig() {
  const fileEnv = loadEnvFile(join(ROOT, ".env"));
  const rawUrl = process.env.TURSO_DATABASE_URL || fileEnv.TURSO_DATABASE_URL || "";
  const token = process.env.TURSO_AUTH_TOKEN || fileEnv.TURSO_AUTH_TOKEN || "";
  if (!rawUrl || !token || rawUrl.includes("your-database") || token.startsWith("replace-with")) {
    console.error("Missing Turso credentials: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment or .env.");
    process.exit(2);
  }
  const url = rawUrl.replace("libsql://", "https://").replace(/\/$/, "");
  return { url, token };
}

/**
 * Splits a script into statements on unquoted semicolons. String literals,
 * `--` line comments and block comments are skipped, so a semicolon inside a
 * seed value or a comment cannot cut a statement in half.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let quote = "";
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = "";
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      current += char + next;
      index += 1;
      inLineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += char + next;
      index += 1;
      inBlockComment = true;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => {
      const withoutComments = statement.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
      return withoutComments.length > 0;
    });
}

async function pipeline(url, token, requests) {
  const response = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [...requests, { type: "close" }] }),
  });
  if (!response.ok) {
    throw new Error(`Turso answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json();
  return data.results || [];
}

const preview = (statement) => statement.replace(/\s+/g, " ").trim().slice(0, 90);

async function applyStatementBatch(url, token, statements, summary, offset) {
  const results = await pipeline(url, token, statements.map((sql) => ({ type: "execute", stmt: { sql, args: [] } })));
  statements.forEach((statement, index) => {
    const step = results[index];
    const message = step?.error?.message || "";
    if (!step?.error) {
      summary.applied += 1;
      return;
    }
    if (TOLERATED.test(message)) {
      summary.skipped += 1;
      return;
    }
    summary.failed += 1;
    summary.failures.push({ statement: offset + index + 1, message, preview: preview(statement) });
  });
}

async function run() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const dryRun = args.includes("--dry-run");
  const listOnly = args.includes("--list");
  const file = args.find((arg) => !arg.startsWith("--")) || DEFAULT_FILE;
  const path = resolve(ROOT, file);
  if (!existsSync(path)) {
    console.error(`No such migration file: ${file}`);
    process.exit(2);
  }

  const statements = splitStatements(readFileSync(path, "utf8"));
  console.log(`${file}: ${statements.length} statements`);
  if (listOnly) {
    statements.forEach((statement, index) => console.log(`  ${index + 1}. ${preview(statement)}`));
    return;
  }
  if (dryRun) return;

  const { url, token } = databaseConfig();

  if (verifyOnly) {
    const [tables, passes] = await Promise.all([
      pipeline(url, token, [{ type: "execute", stmt: { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", args: [] } }]),
      pipeline(url, token, [{ type: "execute", stmt: { sql: "SELECT id,version,applied_at FROM campus_schema_meta ORDER BY id", args: [] } }]),
    ]);
    const rows = (step) => (step?.response?.result?.rows || []).map((row) => row.map((cell) => cell?.value ?? ""));
    console.log(`Tables (${rows(tables[0]).length}):`);
    for (const [name] of rows(tables[0])) console.log(`  ${name}`);
    console.log(`Schema passes (${rows(passes[0]).length}):`);
    for (const [id, version, appliedAt] of rows(passes[0])) console.log(`  ${id} = ${version} (${appliedAt})`);
    return;
  }

  const summary = { applied: 0, skipped: 0, failed: 0, failures: [] };
  for (let offset = 0; offset < statements.length; offset += BATCH_SIZE) {
    const batch = statements.slice(offset, offset + BATCH_SIZE);
    await applyStatementBatch(url, token, batch, summary, offset);
    process.stdout.write(`  ${Math.min(offset + batch.length, statements.length)}/${statements.length}\r`);
  }
  console.log(`  applied ${summary.applied}, skipped ${summary.skipped}, failed ${summary.failed}`);
  for (const failure of summary.failures.slice(0, 10)) {
    console.error(`  failed at statement ${failure.statement}: ${failure.message}\n    ${failure.preview}`);
  }
  if (summary.failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
