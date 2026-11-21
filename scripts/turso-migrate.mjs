// Creates or updates the tables in your Turso database from
// prisma/migrations. Safe to run again: it remembers which migrations
// it has applied, and skips tables/columns that already exist.
//
// PowerShell:
//   $env:TURSO_DATABASE_URL = "libsql://your-db.turso.io"
//   $env:TURSO_AUTH_TOKEN   = "your token"
//   npm run db:turso
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) first.");
  process.exit(1);
}

const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const dir = path.join(process.cwd(), "prisma", "migrations");

await db.execute(
  "CREATE TABLE IF NOT EXISTS _turso_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
);
const done = new Set(
  (await db.execute("SELECT name FROM _turso_migrations")).rows.map((r) => r.name),
);

// Already there from an earlier, manual setup
const harmless = /already exists|duplicate column/i;

const names = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "migration.sql")))
  .map((d) => d.name)
  .sort();

let applied = 0;
for (const name of names) {
  if (done.has(name)) continue;
  const sql = readFileSync(path.join(dir, name, "migration.sql"), "utf8");
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      await db.execute(statement);
    } catch (err) {
      if (!harmless.test(String(err?.message))) {
        console.error(`\n${name} failed on:\n${statement}\n\n${err?.message}`);
        process.exit(1);
      }
    }
  }
  await db.execute({
    sql: "INSERT INTO _turso_migrations (name, applied_at) VALUES (?, ?)",
    args: [name, new Date().toISOString()],
  });
  console.log(`applied  ${name}`);
  applied++;
}

console.log(applied ? `\nDone: ${applied} migration(s) applied.` : "Already up to date.");
