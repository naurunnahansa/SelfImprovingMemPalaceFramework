import "dotenv/config";
import { db } from "./db/client.js";
import { sql } from "drizzle-orm";
import { embedText } from "./embeddings/gemini.js";
import { storeDrawer } from "./palace/store.js";
import { hybridSearch } from "./palace/search.js";

async function main() {
  // 1. Test DB connection
  const result = await db.execute(sql`SELECT count(*) FROM drawers`);
  console.log("DB connected. Drawers count:", result.rows[0]);

  // 2. Test pgvector
  const ext = await db.execute(
    sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`
  );
  console.log("pgvector installed:", ext.rows.length > 0);

  // 3. Test embeddings
  console.log("Generating embedding...");
  const emb = await embedText("Hello, this is a test");
  console.log(`Embedding generated: ${emb.length} dimensions`);

  // 4. Test storing a drawer
  console.log("Storing test drawer...");
  const drawer = await storeDrawer({
    wing: "system",
    hall: "identity",
    room: "test",
    content: "This is a test memory stored in the palace.",
    source: "smoke-test",
  });
  console.log(`Drawer stored: ${drawer.id}`);

  // 5. Test search
  console.log("Searching...");
  const results = await hybridSearch("test memory palace");
  console.log(`Search returned ${results.length} results`);
  if (results.length > 0) {
    console.log(`  Top result: "${results[0]!.content.slice(0, 50)}..." (score: ${results[0]!.score})`);
  }

  console.log("\nAll smoke tests passed!");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
