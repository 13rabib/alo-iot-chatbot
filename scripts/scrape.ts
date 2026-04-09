// scripts/scrape.ts
// Knowledge base scraper for the Alo IoT chatbot.
//
// Responsibilities:
//   1. Fetch all 9 source URLs (HTML pages + OBD PDF)
//   2. Clean and extract main content
//   3. Detect changes via MD5 hash — skip unchanged sources
//   4. Chunk text (~500 tokens / ~400 words, 80-token overlap)
//   5. Embed each chunk with OpenAI text-embedding-3-small
//   6. Upsert into LanceDB (local files — no Docker needed)
//   7. Persist source hashes in SQLite for next run comparison
//   8. Schedule automatic re-scrape every 15 days via node-cron
//
// Run manually:  npx ts-node scripts/scrape.ts --run-now
// Cron mode:     npx ts-node scripts/scrape.ts          (starts scheduler)

import axios from "axios";
import * as cheerio from "cheerio";
import { PDFExtract } from "pdf.js-extract";
import { createHash } from "crypto";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Schema, Utf8, Int32 } from "apache-arrow";
import OpenAI from "openai";
import { createClient, Client } from "@libsql/client";
import * as cron from "node-cron";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Source definitions
// ─────────────────────────────────────────────────────────────────────────────

type SourceType = "html" | "pdf";

interface Source {
  id: string;
  url: string;
  type: SourceType;
  productName: string;
}

const SOURCES: Source[] = [
  {
    id: "alo-overview",
    url: "https://www.grameenphone.com/business/products-and-services/alo",
    type: "html",
    productName: "Alo IoT Overview",
  },
  {
    id: "obd",
    url: "https://www.grameenphone.com/business/products-and-services/iot/alo-vehicle-tracker-obd",
    type: "html",
    productName: "alo Vehicle Tracker OBD",
  },
  {
    id: "vehicle-tracker",
    url: "https://www.grameenphone.com/business/products-and-services/iot/alo-vehicle-tracker",
    type: "html",
    productName: "alo Vehicle Tracker",
  },
  {
    id: "vehicle-tracker-pro",
    url: "https://www.grameenphone.com/business/products-and-services/iot/alo-vehicle-tracker-pro",
    type: "html",
    productName: "alo Vehicle Tracker Pro",
  },
  {
    id: "remote-socket",
    url: "https://www.grameenphone.com/business/products-and-services/iot/alo-remote-socket",
    type: "html",
    productName: "alo Remote Socket",
  },
  {
    id: "gas-detector",
    url: "https://www.grameenphone.com/business/products-and-services/iot/alo-gas-detector",
    type: "html",
    productName: "alo Gas Detector",
  },
  {
    id: "smoke-detector",
    url: "https://www.grameenphone.com/business/products-and-services/iot/alo-smoke-detector",
    type: "html",
    productName: "alo Smoke Detector",
  },
  {
    id: "cc-camera",
    url: "https://www.grameenphone.com/business/products-and-services/iot/alo-cc-camera",
    type: "html",
    productName: "alo CC Camera",
  },
  {
    id: "obd-supported-vehicles",
    url: "https://cdn01.grameenphone.com/sites/default/files/Supported%20Vehicle_OBD.pdf",
    type: "pdf",
    productName: "OBD Supported Vehicles",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE_WORDS    = 150;
const CHUNK_OVERLAP_WORDS = 20;
const EMBED_DIM           = 1536; // text-embedding-3-small dimension
const TABLE_NAME          = "alo_products";

const LANCEDB_PATH = process.env.LANCEDB_PATH ||
  path.join(process.cwd(), "data", "lancedb");

// Turso client singleton
let _turso: Client | null = null;
function getTurso(): Client {
  if (_turso) return _turso;
  _turso = createClient({
    url:       process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  return _turso;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite — stores source hashes and last-scraped timestamps
// ─────────────────────────────────────────────────────────────────────────────

async function initScrapeTable(): Promise<void> {
  await getTurso().execute(`
    CREATE TABLE IF NOT EXISTS scrape_hashes (
      source_id   TEXT PRIMARY KEY,
      hash        TEXT NOT NULL,
      scraped_at  TEXT NOT NULL
    )
  `);
}

async function getStoredHash(sourceId: string): Promise<string | null> {
  const result = await getTurso().execute({
    sql:  "SELECT hash FROM scrape_hashes WHERE source_id = ?",
    args: [sourceId],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].hash as string;
}

async function setStoredHash(sourceId: string, hash: string): Promise<void> {
  await getTurso().execute({
    sql: `
      INSERT INTO scrape_hashes (source_id, hash, scraped_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE
      SET hash = excluded.hash, scraped_at = excluded.scraped_at
    `,
    args: [sourceId, hash, new Date().toISOString()],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetching
// ─────────────────────────────────────────────────────────────────────────────

const HTTP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; AloBot/1.0; university-project)",
  "Accept-Language": "en-US,en;q=0.9",
};

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHtml(url: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get(url, { headers: HTTP_HEADERS, timeout: 15000 });
      const $ = cheerio.load(res.data);
      $("style, script, nav, footer, .breadcrumb, .follow-us, .cookie-banner, header").remove();
      const text = $("body").text().replace(/\s+/g, " ").trim();
      return text;
    } catch (err) {
      console.warn(`[Scraper] Attempt ${attempt}/${MAX_RETRIES} failed for ${url}:`, (err as Error).message);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(`[Scraper] All ${MAX_RETRIES} attempts failed for ${url}`);
}

async function fetchPdf(url: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: HTTP_HEADERS,
        responseType: "arraybuffer",
        timeout: 30000,
      });
      const extractor = new PDFExtract();
      const data      = await extractor.extractBuffer(Buffer.from(res.data), {});
      return data.pages
        .flatMap(page => page.content.map(item => item.str))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (err) {
      console.warn(`[Scraper] PDF attempt ${attempt}/${MAX_RETRIES} failed:`, (err as Error).message);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(`[Scraper] PDF fetch failed after ${MAX_RETRIES} attempts for ${url}`);
}

async function scrapeSource(source: Source): Promise<string> {
  console.log(`[Scraper] Fetching ${source.id} (${source.type}) ...`);
  return source.type === "pdf" ? await fetchPdf(source.url) : await fetchHtml(source.url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

function md5(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking
// ─────────────────────────────────────────────────────────────────────────────

interface Chunk {
  id:          string;
  productId:   string;
  productName: string;
  sourceUrl:   string;
  text:        string;
  chunkIndex:  number;
}

function chunkText(text: string, source: Source): Chunk[] {
  const words  = text.split(" ").filter(w => w.length > 0);
  const chunks: Chunk[] = [];
  let start    = 0;

  while (start < words.length) {
    const end       = Math.min(start + CHUNK_SIZE_WORDS, words.length);
    const chunkBody = words.slice(start, end).join(" ");

    if (chunkBody.length > 80) {
      chunks.push({
        id:          `${source.id}-chunk-${chunks.length}`,
        productId:   source.id,
        productName: source.productName,
        sourceUrl:   source.url,
        text:        chunkBody,
        chunkIndex:  chunks.length,
      });
    }

    if (end === words.length) break;
    start += CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS;
  }

  console.log(`[Scraper] ${source.id} → ${chunks.length} chunks`);
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding
// ─────────────────────────────────────────────────────────────────────────────

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const EMBED_BATCH_SIZE = 50;

async function embedChunks(chunks: Chunk[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    console.log(`[Scraper] Embedding batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1} (${batch.length} chunks) ...`);

    const res = await getOpenAI().embeddings.create({
      model: "text-embedding-3-small",
      input: batch.map(c => c.text),
    });

    embeddings.push(...res.data.map(d => d.embedding));
    await sleep(200);
  }

  return embeddings;
}

// ─────────────────────────────────────────────────────────────────────────────
// LanceDB upsert
// ─────────────────────────────────────────────────────────────────────────────

let _db:    lancedb.Connection | null = null;
let _table: lancedb.Table | null = null;

async function getLanceTable(): Promise<lancedb.Table> {
  if (_table) return _table;

  fs.mkdirSync(LANCEDB_PATH, { recursive: true });

  if (!_db) {
    _db = await lancedb.connect(LANCEDB_PATH);
  }

  const tableNames = await _db.tableNames();

  if (!tableNames.includes(TABLE_NAME)) {
    // Create table with explicit schema on first run
    const schema = new Schema([
      new Field("id",          new Utf8(),                              false),
      new Field("text",        new Utf8(),                              false),
      new Field("productId",   new Utf8(),                              false),
      new Field("productName", new Utf8(),                              false),
      new Field("sourceUrl",   new Utf8(),                              false),
      new Field("chunkIndex",  new Int32(),                             false),
      new Field("vector",      new FixedSizeList(EMBED_DIM, new Field("item", new Float32(), false)), false),
    ]);

    _table = await _db.createEmptyTable(TABLE_NAME, schema);
    console.log(`[Scraper] Created LanceDB table "${TABLE_NAME}"`);
  } else {
    _table = await _db.openTable(TABLE_NAME);
  }

  return _table;
}

async function deleteChunksForSource(sourceId: string): Promise<void> {
  const table = await getLanceTable();
  await table.delete(`"productId" = '${sourceId}'`);
  console.log(`[Scraper] Deleted stale chunks for ${sourceId}`);
}

async function upsertChunks(chunks: Chunk[], embeddings: number[][]): Promise<void> {
  const table = await getLanceTable();

  const rows = chunks.map((chunk, i) => ({
    id:          chunk.id,
    text:        chunk.text,
    productId:   chunk.productId,
    productName: chunk.productName,
    sourceUrl:   chunk.sourceUrl,
    chunkIndex:  chunk.chunkIndex,
    vector:      embeddings[i],
  }));

  await table.add(rows);
  console.log(`[Scraper] Added ${chunks.length} chunks to LanceDB`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-source pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function processSource(source: Source): Promise<void> {
  let text: string;

  try {
    text = await scrapeSource(source);
  } catch (err) {
    console.error(`[Scraper] SKIP ${source.id} — fetch failed:`, (err as Error).message);
    return;
  }

  if (!text || text.length < 100) {
    console.warn(`[Scraper] SKIP ${source.id} — content too short (${text?.length ?? 0} chars)`);
    return;
  }

  const newHash    = md5(text);
  const storedHash = await getStoredHash(source.id);

  if (newHash === storedHash) {
    console.log(`[Scraper] UNCHANGED ${source.id} — skipping`);
    return;
  }

  console.log(`[Scraper] CHANGED ${source.id} — re-embedding ...`);

  const chunks = chunkText(text, source);
  if (chunks.length === 0) {
    console.warn(`[Scraper] SKIP ${source.id} — no usable chunks`);
    return;
  }

  const embeddings = await embedChunks(chunks);

  await deleteChunksForSource(source.id);
  await upsertChunks(chunks, embeddings);

  await setStoredHash(source.id, newHash);
  console.log(`✓ ${source.id} updated (${chunks.length} chunks)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full scrape run
// ─────────────────────────────────────────────────────────────────────────────

async function runScrape(): Promise<void> {
  console.log(`\n[Scraper] ===== Scrape run started at ${new Date().toISOString()} =====`);

  await initScrapeTable();

  for (const source of SOURCES) {
    await processSource(source);
    await sleep(1000);
  }

  const table       = await getLanceTable();
  const totalChunks = await table.countRows();
  console.log(`\n[Scraper] ===== Run complete — ${totalChunks} total chunks in LanceDB =====\n`);

}

// ─────────────────────────────────────────────────────────────────────────────
// 15-day cron scheduler
// ─────────────────────────────────────────────────────────────────────────────

function startCronScheduler(): void {
  const CRON_EXPRESSION = "0 2 */15 * *";
  console.log(`[Scraper] Cron scheduler started — re-scrapes every 15 days (${CRON_EXPRESSION})`);

  cron.schedule(CRON_EXPRESSION, async () => {
    console.log("[Scraper] Cron triggered — starting scheduled re-scrape ...");
    try {
      await runScrape();
    } catch (err) {
      console.error("[Scraper] Cron scrape failed:", err);
    }
  });

  process.on("SIGTERM", () => {
    console.log("[Scraper] SIGTERM received — shutting down");
    process.exit(0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const runNow = process.argv.includes("--run-now");

  if (runNow) {
    await runScrape();
    process.exit(0);
  } else {
    await runScrape();
    startCronScheduler();
  }
}

main().catch(err => {
  console.error("[Scraper] Fatal error:", err);
  process.exit(1);
});
