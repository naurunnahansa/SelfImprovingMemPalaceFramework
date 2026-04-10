import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import { env } from "../config.js";

const sql = neon(env.databaseUrl);

export const db = drizzle({ client: sql, schema });

export type Database = typeof db;
