import pg from "pg";
import { readFile } from "node:fs/promises";
import { defaultSeedUsers } from "../src/auth.js";

const { Pool } = pg;

export async function runMigration(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    console.log("No DATABASE_URL supplied; skipping PostgreSQL migration.");
    return false;
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    console.log("Applying database schema to PostgreSQL...");
    const schemaSql = await readFile(new URL("./schema.sql", import.meta.url), "utf-8");
    await client.query(schemaSql);

    console.log("Seeding initial users...");
    for (const user of defaultSeedUsers) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, salt, role, full_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt, role = EXCLUDED.role, full_name = EXCLUDED.full_name`,
        [user.id, user.email, user.hash, user.salt, user.role, user.name]
      );
    }
    console.log("Database migration and seeding completed successfully.");
    return true;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.js")) {
  runMigration().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
