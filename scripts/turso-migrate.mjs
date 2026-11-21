// Applies new Prisma migrations (prisma/migrations) to the Turso database.
// `prisma migrate deploy` only works on the local file, so after making a
// migration locally with `prisma migrate dev`, run:
//
//   node --env-file=.env scripts/turso-migrate.mjs
//
// It records each one in _prisma_migrations, the same way Prisma does.
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "crypto";
import { readdir, readFile } from "fs/promises";
import path from "path";

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } = process.env;
if (!url || !authToken) {
  console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env first.");
  process.exit(1);
}
const db = createClient({ url, authToken });

await db.execute(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
)`);

const applied = new Set(
  (await db.execute("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL")).rows.map(
    (r) => r.migration_name
  )
);

const dir = path.join("prisma", "migrations");
const names = (await readdir(dir, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let count = 0;
for (const name of names) {
  if (applied.has(name)) continue;
  const sql = await readFile(path.join(dir, name, "migration.sql"), "utf8");
  const now = new Date().toISOString();
  await db.executeMultiple(sql);
  await db.execute({
    sql: "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)",
    args: [randomUUID(), createHash("sha256").update(sql).digest("hex"), new Date().toISOString(), name, now],
  });
  console.log(`Applied ${name}`);
  count++;
}
console.log(count ? `Done: ${count} migration(s).` : "Turso is up to date.");
