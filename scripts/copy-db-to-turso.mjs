// Copies the local database (prisma/dev.db), tables and data, into an empty
// Turso database. Run once when moving to Turso:
//
//   node --env-file=.env scripts/copy-db-to-turso.mjs
//
// Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. Stops if the Turso database
// already has tables, so it can't overwrite live data.
import { createClient } from "@libsql/client";

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } = process.env;
if (!url || !authToken) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env first.");
  process.exit(1);
}

const local = createClient({ url: process.argv[2] ?? "file:./prisma/dev.db" });
const remote = createClient({ url, authToken });

const objects = async (db, type) =>
  (await db.execute({
    sql: "SELECT name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
    args: [type],
  })).rows;

if ((await objects(remote, "table")).length > 0) {
  console.error("The Turso database already has tables. Use an empty database.");
  process.exit(1);
}

const tables = await objects(local, "table");
const quote = (name) => `"${name.replace(/"/g, '""')}"`;

// Foreign keys are off while copying, so the table order doesn't matter
const statements = ["PRAGMA foreign_keys = OFF", ...tables.map((t) => t.sql)];
for (const { name } of tables) {
  const { rows, columns } = await local.execute(`SELECT * FROM ${quote(name)}`);
  if (rows.length === 0) continue;
  const insert = `INSERT INTO ${quote(name)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  for (const row of rows) statements.push({ sql: insert, args: columns.map((c) => row[c]) });
  console.log(`${name}: ${rows.length} rows`);
}
statements.push(...(await objects(local, "index")).map((i) => i.sql));

await remote.migrate(statements);
console.log(`Copied ${tables.length} tables to Turso.`);
