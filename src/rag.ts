// src/rag.ts
// Runtime RAG retrieval using LanceDB — no Docker, no external server.
// Data lives in a local folder (data/lancedb/) as files on disk.
// Called by the Orchestrator every turn. Never calls the live website.

import * as lancedb from "@lancedb/lancedb";
import OpenAI from "openai";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface KnowledgeChunk {
  id:        string;
  text:      string;
  productId: string;
  sourceUrl: string;
  score:     number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LanceDB — singleton connection
// ─────────────────────────────────────────────────────────────────────────────

const LANCEDB_PATH = process.env.LANCEDB_PATH ||
  path.join(process.cwd(), "data", "lancedb");

const TABLE_NAME = "alo_products";

let _db:    lancedb.Connection | null = null;
let _table: lancedb.Table | null = null;

async function getTable(): Promise<lancedb.Table> {
  if (_table) return _table;

  if (!_db) {
    _db = await lancedb.connect(LANCEDB_PATH);
  }

  const tableNames = await _db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    throw new Error(
      `LanceDB table "${TABLE_NAME}" not found. Run \`npm run scrape\` first.`
    );
  }

  _table = await _db.openTable(TABLE_NAME);
  return _table;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding
// ─────────────────────────────────────────────────────────────────────────────

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export async function embedText(text: string): Promise<number[]> {
  const res = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query — top-K vector similarity search
// ─────────────────────────────────────────────────────────────────────────────

export async function queryKnowledgeBase(
  query: string,
  topK = 4
): Promise<KnowledgeChunk[]> {
  const table       = await getTable();
  const queryVector = await embedText(query);

  const results = await table
    .vectorSearch(queryVector)
    .limit(topK)
    .toArray();

  return results.map((row: Record<string, unknown>, i: number) => ({
    id:        String(row["id"]        ?? `result-${i}`),
    text:      String(row["text"]      ?? ""),
    productId: String(row["productId"] ?? ""),
    sourceUrl: String(row["sourceUrl"] ?? ""),
    score:     Number(row["_distance"] ?? 0),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Health check — called at server startup
// ─────────────────────────────────────────────────────────────────────────────

export async function knowledgeBaseHealthCheck(): Promise<void> {
  const table = await getTable();
  const count = await table.countRows();

  if (count === 0) {
    throw new Error(
      "Knowledge base is empty. Run `npm run scrape` to populate LanceDB first."
    );
  }

  console.log(`✓ Knowledge base loaded: ${count} chunks in LanceDB`);
}
