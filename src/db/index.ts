import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

/**
 * Next dev reloads modules on every edit. Without this global cache each
 * reload opens another handle to the same file and SQLite starts throwing
 * SQLITE_BUSY under concurrent writes from the worker.
 */
const globalForDb = globalThis as unknown as {
  __sqlite?: Database.Database;
};

const sqlite =
  globalForDb.__sqlite ??
  (() => {
    const conn = new Database(dbPath);
    // WAL lets the Next server and the worker process write concurrently.
    conn.pragma("journal_mode = WAL");
    conn.pragma("busy_timeout = 5000");
    conn.pragma("foreign_keys = ON");
    return conn;
  })();

if (process.env.NODE_ENV !== "production") globalForDb.__sqlite = sqlite;

export const db = drizzle(sqlite, { schema });
export { schema, sqlite };
