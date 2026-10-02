import pg from "pg";
import { readFile } from "node:fs/promises";
import { defaultSeedUsers } from "../src/auth.js";

const { Pool } = pg;

export async function runMigration(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    console.log("No DATABASE_URL supplied; skipping PostgreSQL migration.");
    return false;
  }

  const pool = new Pool({ connectionString, connectionTimeoutMillis: 15000 });
  const client = await pool.connect();
  try {
    console.log("Applying schema...");
    await client.query(await readFile(new URL("./schema.sql", import.meta.url), "utf-8"));

    // The transactional order functions and the RLS lockdown live separately so
    // they can be reapplied without touching table definitions or seed rows.
    console.log("Applying order functions and access control...");
    await client.query(await readFile(new URL("./functions.sql", import.meta.url), "utf-8"));

    console.log("Seeding demo accounts...");
    for (const user of defaultSeedUsers) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, salt, role, full_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO UPDATE
            SET password_hash = EXCLUDED.password_hash,
                salt = EXCLUDED.salt,
                role = EXCLUDED.role,
                full_name = EXCLUDED.full_name`,
        [user.id, user.email, user.hash, user.salt, user.role, user.name]
      );
    }

    const { rows } = await client.query(
      "SELECT (SELECT count(*) FROM products)::int AS products, (SELECT count(*) FROM users)::int AS users"
    );
    console.log(`Migration complete: ${rows[0].products} products, ${rows[0].users} users.`);
    return true;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.js")) {
  runMigration().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  });
}
