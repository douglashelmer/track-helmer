import { readFileSync } from "node:fs";
import { pool } from "./db.js";

const sql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
await pool.query(sql);
console.log("✓ schema aplicado");
await pool.end();
