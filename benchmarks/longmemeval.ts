import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { embedText, embedBatch } from "../src/embeddings/gemini.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LongMemEvalItem {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: string[];
}

interface BenchmarkResult {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  answer_session_ids: string[];
  retrieved_session_ids: string[];
  recall_at_5: number;
  recall_at_10: number;
  hit_at_5: boolean;
  hit_at_10: boolean;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── NDCG Calculation ───────────────────────────────────────────────────────

function dcg(relevances: number[]): number {
  return relevances.reduce(
    (sum, rel, i) => sum + rel / Math.log2(i + 2),
    0
  );
}

function ndcg(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);
  const relevances = topK.map((id) => (relevant.has(id) ? 1 : 0));

  const idealRelevances = Array(Math.min(relevant.size, k))
    .fill(1)
    .concat(Array(Math.max(0, k - relevant.size)).fill(0));

  const idealDcg = dcg(idealRelevances);
  if (idealDcg === 0) return 0;
  return dcg(relevances) / idealDcg;
}

// ─── Main Benchmark ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes("--limit")
    ? parseInt(args[args.indexOf("--limit") + 1]!)
    : undefined;
  const topK = args.includes("--top-k")
    ? parseInt(args[args.indexOf("--top-k") + 1]!)
    : 10;

  console.log("=== LongMemEval Benchmark ===");
  console.log(`Mode: raw (Gemini embeddings + cosine similarity)`);
  console.log(`Top-K: ${topK}`);

  // Load dataset
  const dataPath = args.includes("--data")
    ? args[args.indexOf("--data") + 1]!
    : "benchmarks/data/longmemeval_s_cleaned.json";
  console.log(`Loading dataset from ${dataPath}...`);
  const rawData = readFileSync(dataPath, "utf-8");
  const dataset: LongMemEvalItem[] = JSON.parse(rawData);

  const items = limit ? dataset.slice(0, limit) : dataset;
  console.log(
    `Evaluating ${items.length}/${dataset.length} questions\n`
  );

  // Aggregate metrics
  const results: BenchmarkResult[] = [];
  const categoryMetrics: Record<
    string,
    { total: number; hit5: number; hit10: number; ndcg10: number }
  > = {};

  let totalHit5 = 0;
  let totalHit10 = 0;
  let totalNdcg10 = 0;
  let processed = 0;

  for (const item of items) {
    const startTime = Date.now();

    // Embed the question
    const questionEmb = await embedText(item.question);

    // Flatten sessions: each is an array of {role, content} messages
    // Convert to plain text for embedding
    const sessionTexts = item.haystack_sessions.map((session) => {
      if (typeof session === "string") return session.slice(0, 8000);
      if (Array.isArray(session)) {
        const text = (session as Array<{ role: string; content: string }>)
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n");
        return text.slice(0, 8000);
      }
      return String(session).slice(0, 8000);
    });

    // Embed in batches to avoid rate limits
    const sessionEmbeddings: number[][] = [];
    const batchSize = 20;
    for (let i = 0; i < sessionTexts.length; i += batchSize) {
      const batch = sessionTexts.slice(i, i + batchSize);
      const batchEmbs = await embedBatch(batch);
      sessionEmbeddings.push(...batchEmbs);
    }

    // Compute similarities and rank
    const scored = item.haystack_session_ids.map((id, idx) => ({
      id,
      similarity: cosineSimilarity(questionEmb, sessionEmbeddings[idx]!),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);

    const retrievedIds = scored.map((s) => s.id);
    const relevantSet = new Set(item.answer_session_ids);

    // Recall@5: does any answer session appear in top 5?
    const top5 = new Set(retrievedIds.slice(0, 5));
    const hit5 = item.answer_session_ids.some((id) => top5.has(id));

    // Recall@10
    const top10 = new Set(retrievedIds.slice(0, topK));
    const hit10 = item.answer_session_ids.some((id) => top10.has(id));

    // NDCG@10
    const ndcg10 = ndcg(retrievedIds, relevantSet, 10);

    // Track results
    const result: BenchmarkResult = {
      question_id: item.question_id,
      question_type: item.question_type,
      question: item.question,
      answer: item.answer,
      answer_session_ids: item.answer_session_ids,
      retrieved_session_ids: retrievedIds.slice(0, topK),
      recall_at_5: hit5 ? 1 : 0,
      recall_at_10: hit10 ? 1 : 0,
      hit_at_5: hit5,
      hit_at_10: hit10,
    };
    results.push(result);

    if (hit5) totalHit5++;
    if (hit10) totalHit10++;
    totalNdcg10 += ndcg10;
    processed++;

    // Category tracking
    const cat = item.question_type;
    if (!categoryMetrics[cat]) {
      categoryMetrics[cat] = { total: 0, hit5: 0, hit10: 0, ndcg10: 0 };
    }
    categoryMetrics[cat]!.total++;
    if (hit5) categoryMetrics[cat]!.hit5++;
    if (hit10) categoryMetrics[cat]!.hit10++;
    categoryMetrics[cat]!.ndcg10 += ndcg10;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Progress
    if (processed % 5 === 0 || processed === items.length) {
      const runningR5 = ((totalHit5 / processed) * 100).toFixed(1);
      const runningR10 = ((totalHit10 / processed) * 100).toFixed(1);
      console.log(
        `[${processed}/${items.length}] R@5: ${runningR5}% | R@10: ${runningR10}% | Last: ${elapsed}s | ${hit5 ? "HIT" : "MISS"} | ${item.question.slice(0, 60)}...`
      );
    }
  }

  // ─── Final Report ──────────────────────────────────────────────────

  console.log("\n========================================");
  console.log("         FINAL RESULTS");
  console.log("========================================\n");

  const r5 = ((totalHit5 / processed) * 100).toFixed(1);
  const r10 = ((totalHit10 / processed) * 100).toFixed(1);
  const avgNdcg = (totalNdcg10 / processed).toFixed(3);

  console.log(`Total questions: ${processed}`);
  console.log(`Recall@5:  ${r5}% (${totalHit5}/${processed})`);
  console.log(`Recall@10: ${r10}% (${totalHit10}/${processed})`);
  console.log(`NDCG@10:   ${avgNdcg}`);

  console.log("\n--- Per-Category Breakdown ---\n");
  console.log(
    `${"Category".padEnd(30)} ${"R@5".padStart(8)} ${"R@10".padStart(8)} ${"NDCG@10".padStart(8)} ${"Count".padStart(6)}`
  );
  console.log("-".repeat(66));

  for (const [cat, m] of Object.entries(categoryMetrics).sort()) {
    const catR5 = ((m.hit5 / m.total) * 100).toFixed(1);
    const catR10 = ((m.hit10 / m.total) * 100).toFixed(1);
    const catNdcg = (m.ndcg10 / m.total).toFixed(3);
    console.log(
      `${cat.padEnd(30)} ${(catR5 + "%").padStart(8)} ${(catR10 + "%").padStart(8)} ${catNdcg.padStart(8)} ${String(m.total).padStart(6)}`
    );
  }

  // ─── Save Results ──────────────────────────────────────────────────

  const outputPath = `benchmarks/results_longmemeval_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
  const output = {
    benchmark: "LongMemEval",
    mode: "raw",
    embedding_model: "gemini-embedding-001",
    dimensions: 3072,
    top_k: topK,
    total_questions: processed,
    recall_at_5: parseFloat(r5),
    recall_at_10: parseFloat(r10),
    ndcg_at_10: parseFloat(avgNdcg),
    category_metrics: categoryMetrics,
    timestamp: new Date().toISOString(),
    results,
  };
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
