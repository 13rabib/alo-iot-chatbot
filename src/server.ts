// src/server.ts
// Express API server for the Alo IoT chatbot.
//
// Endpoints:
//   POST /session          — create a new session, return sessionId
//   POST /chat             — send a message, run the 5-node pipeline, return reply
//   GET  /session/:id      — return full session state (debug)

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { createClient, Client } from "@libsql/client";
import * as dotenv from "dotenv";

dotenv.config();

import { AloAgentState, initialState } from "../state/schema";
import { runAnalyzer } from "./analyzer";
import { orchestrate } from "./orchestrator";
import { runSpeaker } from "./speaker";
import { knowledgeBaseHealthCheck } from "./rag";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT     = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// ─────────────────────────────────────────────────────────────────────────────
// Turso — session persistence
// ─────────────────────────────────────────────────────────────────────────────

let _turso: Client | null = null;

function getTurso(): Client {
  if (_turso) return _turso;
  _turso = createClient({
    url:       process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  return _turso;
}

async function initDb(): Promise<void> {
  await getTurso().execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id  TEXT PRIMARY KEY,
      state       TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);
}

async function loadSession(sessionId: string): Promise<AloAgentState | null> {
  const result = await getTurso().execute({
    sql:  "SELECT state FROM sessions WHERE session_id = ?",
    args: [sessionId],
  });

  if (result.rows.length === 0) return null;

  try {
    return JSON.parse(result.rows[0].state as string) as AloAgentState;
  } catch {
    console.error(`[Server] Failed to parse state for session ${sessionId}`);
    return null;
  }
}

async function saveSession(state: AloAgentState): Promise<void> {
  await getTurso().execute({
    sql: `
      INSERT INTO sessions (session_id, state, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE
      SET state = excluded.state, updated_at = excluded.updated_at
    `,
    args: [state.sessionId, JSON.stringify(state), new Date().toISOString()],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

if (NODE_ENV === "development") {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[Server] ${req.method} ${req.path}`);
    next();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /session
// ─────────────────────────────────────────────────────────────────────────────

app.post("/session", async (_req: Request, res: Response) => {
  const sessionId = uuidv4();
  const state     = initialState(sessionId);

  await saveSession(state);
  console.log(`[Server] New session created: ${sessionId}`);

  res.status(201).json({ sessionId, phase: state.currentPhase });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat
// ─────────────────────────────────────────────────────────────────────────────

app.post("/chat", async (req: Request, res: Response) => {
  const { sessionId, message } = req.body as {
    sessionId?: string;
    message?:   string;
  };

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Missing or invalid sessionId." });
  }

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Missing or empty message." });
  }

  let state = await loadSession(sessionId);

  if (!state) {
    return res.status(404).json({
      error: "Session not found. Please refresh to start a new session.",
    });
  }

  if (state.currentPhase === "done" || state.sessionClosed) {
    return res.status(200).json({
      reply:     "This session has ended. Please refresh to start a new conversation.",
      phase:     "done",
      sessionId,
    });
  }

  // Reset scratch + append user message
  const userTimestamp = new Date().toISOString();
  state = {
    ...state,
    currentUserInput:      message.trim(),
    currentAssistantReply: "",
    analyzerOutput:        {},
    ragContext:            "",
    messages: [...state.messages, { role: "user", content: message.trim(), timestamp: userTimestamp }],
  };

  // Node 1+2: Analyzer
  let analyzerOutput: Record<string, unknown> = {};
  try {
    analyzerOutput = await runAnalyzer(state);
    console.log(`[Server] Analyzer (turn ${state.turnCount}):`, JSON.stringify(analyzerOutput));
  } catch (err) {
    console.error("[Server] Analyzer threw:", err);
  }

  // Node 3: Orchestrator
  try {
    state = await orchestrate(state, analyzerOutput);
  } catch (err) {
    console.error("[Server] Orchestrator failed:", err);
    return res.status(500).json({ error: "An internal error occurred. Please try again." });
  }

  // Node 4+5: Speaker
  let reply: string;
  try {
    reply = await runSpeaker(state);
  } catch (err) {
    console.error("[Server] Speaker threw:", err);
    reply = "I encountered a brief issue. Please try again or visit grameenphone.com/business.";
  }

  // Append assistant reply
  state = {
    ...state,
    currentAssistantReply: reply,
    messages: [
      ...state.messages,
      { role: "assistant", content: reply, timestamp: new Date().toISOString() },
    ],
  };

  await saveSession(state);

  console.log(`[Server] Turn ${state.turnCount} done — phase: ${state.currentPhase}`);

  return res.status(200).json({ reply, phase: state.currentPhase, sessionId });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /session/:id
// ─────────────────────────────────────────────────────────────────────────────

app.get("/session/:id", async (req: Request, res: Response) => {
  const state = await loadSession(req.params.id);

  if (!state) {
    return res.status(404).json({
      error: "Session not found. Please refresh to start a new session.",
    });
  }

  if (NODE_ENV !== "development") {
    const { ragContext, analyzerOutput, ...safeState } = state;
    void ragContext; void analyzerOutput;
    return res.status(200).json(safeState);
  }

  return res.status(200).json(state);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", env: NODE_ENV });
});

// ─────────────────────────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({ error: "An unexpected error occurred. Please try again." });
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await initDb();
  console.log("✓ Turso database ready");

  try {
    await knowledgeBaseHealthCheck();
  } catch (err) {
    console.error("[Server] Knowledge base health check failed:", (err as Error).message);
    console.error("[Server] Run `npm run scrape` first, then restart the server.");
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n✓ Alo IoT Chatbot server running on http://localhost:${PORT}`);
    console.log(`  Environment: ${NODE_ENV}`);
    console.log(`  Endpoints:`);
    console.log(`    POST /session`);
    console.log(`    POST /chat`);
    console.log(`    GET  /session/:id`);
    console.log(`    GET  /health\n`);
  });
}

start().catch(err => {
  console.error("[Server] Fatal startup error:", err);
  process.exit(1);
});

export default app;
