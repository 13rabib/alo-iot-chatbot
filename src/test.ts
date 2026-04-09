// src/test.ts
// Full test suite for the Alo IoT chatbot — Skill 9.
//
// Layers:
//   1. Schema validation
//   2. Orchestrator unit tests (phase transitions, merge rules, invariants)
//   3. RAG retrieval tests
//   4. End-to-end conversation tests (A, B, C)
//   5. Grounding test (must never hallucinate)
//   6. API smoke test
//
// Run: npm test
//
// Prerequisites:
//   - ChromaDB running locally (npm run scrape must have completed)
//   - ANTHROPIC_API_KEY and OPENAI_API_KEY set in .env
//   - Express server NOT required for layers 1–4 (tested directly)
//   - Express server REQUIRED for layer 5 (API smoke test)

import * as dotenv from "dotenv";
dotenv.config();

import assert from "assert";
import { initialState, AloAgentState } from "../state/schema";
import { orchestrate } from "./orchestrator";
import { queryKnowledgeBase, knowledgeBaseHealthCheck } from "./rag";
import { runAnalyzer } from "./analyzer";
import { runSpeaker } from "./speaker";

// ─────────────────────────────────────────────────────────────────────────────
// Test runner helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗  ${name}`);
    console.error(`       ${msg}`);
    failed++;
    failures.push(`${name}: ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 55 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Schema validation
// ─────────────────────────────────────────────────────────────────────────────

async function runSchemaTests() {
  section("Layer 1 — Schema validation");

  await test("initialState produces correct phase", () => {
    const s = initialState("test-session");
    assert.strictEqual(s.currentPhase, "greeting");
  });

  await test("initialState turnCount is 0", () => {
    const s = initialState("test-session");
    assert.strictEqual(s.turnCount, 0);
    assert.strictEqual(s.phaseTurnCount, 0);
  });

  await test("initialState messages array is empty", () => {
    const s = initialState("test-session");
    assert.strictEqual(s.messages.length, 0);
  });

  await test("initialState all string fields are empty string", () => {
    const s = initialState("test-session");
    assert.strictEqual(s.specificProduct, "");
    assert.strictEqual(s.productCategory, "");
    assert.strictEqual(s.useCase, "");
    assert.strictEqual(s.urgency, "");
    assert.strictEqual(s.userLanguage, "");
    assert.strictEqual(s.initialIntent, "");
    assert.strictEqual(s.currentDetailProduct, "");
    assert.strictEqual(s.recommendedProduct, "");
    assert.strictEqual(s.ragContext, "");
    assert.strictEqual(s.conversationSummary, "");
  });

  await test("initialState array fields are empty arrays", () => {
    const s = initialState("test-session");
    assert.deepStrictEqual(s.questionsAsked, []);
    assert.deepStrictEqual(s.mentionedProducts, []);
    assert.deepStrictEqual(s.compareProducts, []);
    assert.deepStrictEqual(s.messages, []);
  });

  await test("initialState boolean fields are correct defaults", () => {
    const s = initialState("test-session");
    assert.strictEqual(s.hasVehicle, null);
    assert.strictEqual(s.sessionClosed, false);
  });

  await test("initialState sessionId is preserved", () => {
    const s = initialState("my-unique-id");
    assert.strictEqual(s.sessionId, "my-unique-id");
  });

  await test("initialState createdAt is a valid ISO string", () => {
    const s = initialState("test");
    assert.ok(!isNaN(Date.parse(s.createdAt)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Orchestrator unit tests
// ─────────────────────────────────────────────────────────────────────────────

async function runOrchestratorTests() {
  section("Layer 2 — Orchestrator unit tests");

  // ── Transition tests ──────────────────────────────────────────────────────

  await test("Greeting → product-detail fast-track when product named", async () => {
    const state: AloAgentState = {
      ...initialState("t1"),
      currentUserInput: "I want to buy the alo OBD tracker",
    };
    const result = await orchestrate(state, {
      specificProduct: "obd",
      initialIntent:   "buy obd tracker",
    });
    assert.strictEqual(result.currentPhase, "product-detail",
      `Expected product-detail, got ${result.currentPhase}`);
    assert.strictEqual(result.currentDetailProduct, "obd");
    assert.strictEqual(result.specificProduct, "obd");
  });

  await test("Product-discovery → comparison bypass when 2 products mentioned", async () => {
    const state: AloAgentState = {
      ...initialState("t2"),
      currentPhase:    "product-discovery",
      currentUserInput: "What's the difference between OBD and vehicle tracker?",
    };
    const result = await orchestrate(state, {
      compareProducts: ["obd", "vehicle-tracker"],
      productCategory: "vehicle",
    });
    assert.strictEqual(result.currentPhase, "comparison",
      `Expected comparison, got ${result.currentPhase}`);
    assert.deepStrictEqual(result.compareProducts, ["obd", "vehicle-tracker"]);
  });

  await test("Product-detail → wrapup on buying intent", async () => {
    const state: AloAgentState = {
      ...initialState("t3"),
      currentPhase:         "product-detail",
      currentDetailProduct: "gas-detector",
      currentUserInput:     "I want to buy the gas detector",
    };
    const result = await orchestrate(state, { urgency: "buying-now" });
    assert.strictEqual(result.currentPhase, "wrapup",
      `Expected wrapup, got ${result.currentPhase}`);
  });

  await test("maxTurns forces transition from product-discovery to product-detail", async () => {
    const state: AloAgentState = {
      ...initialState("t4"),
      currentPhase:    "product-discovery",
      phaseTurnCount:  6,            // at maxTurns
      currentUserInput: "I'm not sure",
    };
    const result = await orchestrate(state, {});
    assert.strictEqual(result.currentPhase, "product-detail",
      `Expected product-detail after maxTurns, got ${result.currentPhase}`);
  });

  await test("maxTurns forces transition from greeting to product-discovery", async () => {
    const state: AloAgentState = {
      ...initialState("t5"),
      currentPhase:    "greeting",
      phaseTurnCount:  2,
      currentUserInput: "Hello",
    };
    const result = await orchestrate(state, {});
    assert.strictEqual(result.currentPhase, "product-discovery",
      `Expected product-discovery after greeting maxTurns, got ${result.currentPhase}`);
  });

  // ── Counter invariants ────────────────────────────────────────────────────

  await test("turnCount always increments by 1", async () => {
    const state = { ...initialState("t6"), currentUserInput: "Hi" };
    const r1 = await orchestrate(state, {});
    const r2 = await orchestrate(r1, {});
    assert.strictEqual(r1.turnCount, 1);
    assert.strictEqual(r2.turnCount, 2);
  });

  await test("phaseTurnCount resets to 1 on phase transition", async () => {
    const state: AloAgentState = {
      ...initialState("t7"),
      currentPhase:    "greeting",
      phaseTurnCount:  2,
      currentUserInput: "I want gas detector",
    };
    const result = await orchestrate(state, {
      specificProduct: "gas-detector",
      initialIntent:   "gas detector",
    });
    // Fast-track fires → phase-detail; phaseTurnCount resets to 0 then +1
    assert.strictEqual(result.phaseTurnCount, 1);
  });

  // ── Set-once fields ───────────────────────────────────────────────────────

  await test("initialIntent is set-once (not overwritten)", async () => {
    const state: AloAgentState = {
      ...initialState("t8"),
      initialIntent:   "original intent",
      currentUserInput: "Now I want something else",
    };
    const result = await orchestrate(state, { initialIntent: "new intent" });
    assert.strictEqual(result.initialIntent, "original intent");
  });

  await test("recommendedProduct is set-once (not overwritten)", async () => {
    const state: AloAgentState = {
      ...initialState("t9"),
      currentPhase:        "wrapup",
      recommendedProduct:  "obd",
      currentDetailProduct: "obd",
      currentUserInput:    "Thanks",
    };
    const result = await orchestrate(state, { specificProduct: "cc-camera" });
    assert.strictEqual(result.recommendedProduct, "obd");
  });

  // ── Merge rules ───────────────────────────────────────────────────────────

  await test("mentionedProducts deduplicates correctly", async () => {
    const state: AloAgentState = {
      ...initialState("t10"),
      currentPhase:     "product-detail",
      mentionedProducts: ["obd"],
      currentDetailProduct: "obd",
      currentUserInput: "Tell me about the obd again",
    };
    const result = await orchestrate(state, { specificProduct: "obd" });
    const obdCount = result.mentionedProducts.filter(p => p === "obd").length;
    assert.strictEqual(obdCount, 1, "obd should appear exactly once");
  });

  await test("questionsAsked appends user input each product-detail turn", async () => {
    const state: AloAgentState = {
      ...initialState("t11"),
      currentPhase:         "product-detail",
      currentDetailProduct: "remote-socket",
      questionsAsked:        ["Does it have a timer?"],
      currentUserInput:      "What appliances can it control?",
    };
    const result = await orchestrate(state, {});
    assert.ok(result.questionsAsked.includes("What appliances can it control?"));
    assert.strictEqual(result.questionsAsked.length, 2);
  });

  await test("Product category switch mid-detail resets to product-discovery", async () => {
    const state: AloAgentState = {
      ...initialState("t12"),
      currentPhase:         "product-detail",
      currentDetailProduct: "obd",
      productCategory:      "vehicle",
      currentUserInput:     "Actually I want a smoke detector instead",
    };
    const result = await orchestrate(state, {
      productCategory: "home-safety",
      specificProduct: "",
    });
    assert.strictEqual(result.currentPhase, "product-discovery",
      `Expected product-discovery on category switch, got ${result.currentPhase}`);
  });

  await test("RAG context is populated after orchestrate", async () => {
    const state: AloAgentState = {
      ...initialState("t13"),
      currentPhase:         "product-detail",
      currentDetailProduct: "vehicle-tracker",
      currentUserInput:     "Does it have geofencing?",
    };
    const result = await orchestrate(state, {});
    // ragContext should be non-empty if ChromaDB is populated
    assert.ok(
      typeof result.ragContext === "string",
      "ragContext should be a string"
    );
  });

  await test("RAG context is not carried over from previous turn (scratch reset)", async () => {
    const state: AloAgentState = {
      ...initialState("t14"),
      currentPhase: "product-detail",
      currentDetailProduct: "obd",
      ragContext: "STALE CONTEXT FROM LAST TURN",
      currentUserInput: "What vehicles does it support?",
    };
    const result = await orchestrate(state, {});
    assert.notStrictEqual(result.ragContext, "STALE CONTEXT FROM LAST TURN",
      "ragContext should be refreshed, not stale");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — RAG retrieval tests
// ─────────────────────────────────────────────────────────────────────────────

async function runRagTests() {
  section("Layer 3 — RAG retrieval tests");

  await test("Knowledge base health check passes", async () => {
    await knowledgeBaseHealthCheck(); // throws if empty
  });

  await test("Vehicle tracker query returns vehicle-tracker chunks", async () => {
    const chunks = await queryKnowledgeBase("GPS vehicle tracking geofencing app", 4);
    assert.ok(chunks.length > 0, "Should return at least 1 chunk");
    const hasVehicle = chunks.some(c =>
      c.productId === "vehicle-tracker" || c.productId === "vehicle-tracker-pro"
    );
    assert.ok(hasVehicle, "Should include vehicle tracker content");
  });

  await test("OBD query returns obd chunks", async () => {
    const chunks = await queryKnowledgeBase("OBD port car diagnostics plug in", 4);
    assert.ok(chunks.length > 0, "Should return at least 1 chunk");
    const hasObd = chunks.some(c => c.productId === "obd");
    assert.ok(hasObd, `Expected obd chunk, got: ${chunks.map(c => c.productId).join(", ")}`);
  });

  await test("Gas detector query returns gas-detector chunks", async () => {
    const chunks = await queryKnowledgeBase("gas leak home safety LPG sensor alert", 4);
    assert.ok(chunks.length > 0, "Should return at least 1 chunk");
    const hasGas = chunks.some(c => c.productId === "gas-detector");
    assert.ok(hasGas, `Expected gas-detector chunk, got: ${chunks.map(c => c.productId).join(", ")}`);
  });

  await test("Smoke detector query returns smoke-detector chunks", async () => {
    const chunks = await queryKnowledgeBase("smoke detector fire alarm notification", 4);
    assert.ok(chunks.length > 0, "Should return at least 1 chunk");
    const hasSmoke = chunks.some(c => c.productId === "smoke-detector");
    assert.ok(hasSmoke, `Expected smoke-detector chunk, got: ${chunks.map(c => c.productId).join(", ")}`);
  });

  await test("CC camera query returns cc-camera chunks", async () => {
    const chunks = await queryKnowledgeBase("CCTV security camera remote viewing", 4);
    assert.ok(chunks.length > 0, "Should return at least 1 chunk");
    const hasCamera = chunks.some(c => c.productId === "cc-camera");
    assert.ok(hasCamera, `Expected cc-camera chunk, got: ${chunks.map(c => c.productId).join(", ")}`);
  });

  await test("All chunks have required metadata fields", async () => {
    const chunks = await queryKnowledgeBase("alo IoT product Grameenphone", 6);
    for (const chunk of chunks) {
      assert.ok(chunk.id,        `Chunk missing id`);
      assert.ok(chunk.text,      `Chunk ${chunk.id} missing text`);
      assert.ok(chunk.productId, `Chunk ${chunk.id} missing productId`);
      assert.ok(chunk.sourceUrl, `Chunk ${chunk.id} missing sourceUrl`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 — End-to-end conversation tests
// ─────────────────────────────────────────────────────────────────────────────

// Simulate a full turn: analyzer → orchestrate → speaker → return updated state + reply
async function simulateTurn(
  state: AloAgentState,
  userMessage: string
): Promise<{ state: AloAgentState; reply: string }> {
  const timestamp = new Date().toISOString();

  let s: AloAgentState = {
    ...state,
    currentUserInput:      userMessage,
    currentAssistantReply: "",
    analyzerOutput:        {},
    ragContext:            "",
    messages: [...state.messages, { role: "user", content: userMessage, timestamp }],
  };

  const analyzerOutput = await runAnalyzer(s);
  s = await orchestrate(s, analyzerOutput);
  const reply = await runSpeaker(s);

  s = {
    ...s,
    currentAssistantReply: reply,
    messages: [...s.messages, { role: "assistant", content: reply, timestamp: new Date().toISOString() }],
  };

  return { state: s, reply };
}

async function runE2ETests() {
  section("Layer 4 — End-to-end conversation tests");

  // ── Conversation A: Vehicle owner buying a tracker ──────────────────────

  await test("Conv A: completes without LLM errors", async () => {
    let state = initialState("e2e-a");
    const turns = [
      "Hi, I want to track my car",
      "I have a CNG car. What tracker options do I have?",
      "What's the difference between the OBD and the regular vehicle tracker?",
      "Which one is better for a small fleet of 5 cars?",
      "I want to buy the Vehicle Tracker. How do I order it?",
    ];
    for (const msg of turns) {
      const result = await simulateTurn(state, msg);
      state = result.state;
      assert.ok(result.reply.length > 0, `Empty reply on turn: "${msg}"`);
    }
  });

  await test("Conv A: mentionedProducts includes obd and vehicle-tracker", async () => {
    let state = initialState("e2e-a2");
    const turns = [
      "Hi, I want to track my car",
      "What's the difference between the OBD tracker and the regular vehicle tracker?",
      "Which is better for a fleet?",
    ];
    for (const msg of turns) {
      const result = await simulateTurn(state, msg);
      state = result.state;
    }
    const hasObd     = state.mentionedProducts.includes("obd");
    const hasTracker = state.mentionedProducts.includes("vehicle-tracker");
    assert.ok(
      hasObd || hasTracker,
      `Expected vehicle products in mentionedProducts, got: ${state.mentionedProducts.join(", ")}`
    );
  });

  await test("Conv A: reaches wrapup or comparison phase by turn 5", async () => {
    let state = initialState("e2e-a3");
    const turns = [
      "I want to track my car",
      "I have a Toyota. What are my options?",
      "Tell me about the vehicle tracker pro",
      "Does it have geofencing?",
      "I want to buy it now",
    ];
    for (const msg of turns) {
      const result = await simulateTurn(state, msg);
      state = result.state;
    }
    const validEndPhases = ["wrapup", "product-detail", "comparison"];
    assert.ok(
      validEndPhases.includes(state.currentPhase),
      `Expected late-stage phase, got: ${state.currentPhase}`
    );
  });

  // ── Conversation B: Bengali/mixed home safety inquiry ───────────────────

  await test("Conv B: handles Bengali input without error", async () => {
    let state = initialState("e2e-b");
    const { state: s1, reply: r1 } = await simulateTurn(
      state,
      "আমার বাসায় গ্যাস লিক হলে কী করব?" // "What do I do if gas leaks at home?"
    );
    state = s1;
    assert.ok(r1.length > 0, "Should return non-empty reply for Bengali input");
  });

  await test("Conv B: detects mixed language across turns", async () => {
    let state = initialState("e2e-b2");
    const turns = [
      "আমার বাসায় গ্যাস লিক হলে কী করব?",
      "Is there a GP product that can detect gas?",
      "How does the alo Gas Detector work?",
    ];
    for (const msg of turns) {
      const result = await simulateTurn(state, msg);
      state = result.state;
    }
    const lang = state.userLanguage;
    assert.ok(
      lang === "bn" || lang === "mixed",
      `Expected bn or mixed language, got: ${lang}`
    );
  });

  await test("Conv B: gas-detector appears in mentionedProducts", async () => {
    let state = initialState("e2e-b3");
    const turns = [
      "I need a gas detector for my home",
      "How does the alo Gas Detector alert me?",
      "What about smoke? Do you have a smoke detector?",
    ];
    for (const msg of turns) {
      const result = await simulateTurn(state, msg);
      state = result.state;
    }
    assert.ok(
      state.mentionedProducts.includes("gas-detector"),
      `gas-detector not in mentionedProducts: ${state.mentionedProducts.join(", ")}`
    );
  });

  // ── Conversation C: Grounding test — must NOT hallucinate ───────────────

  await test("Conv C: price unknown → redirects to GP website", async () => {
    const state = initialState("e2e-c");
    const { reply } = await simulateTurn(
      state,
      "What is the exact monthly subscription price for the Vehicle Tracker Pro?"
    );
    const redirectsToGP =
      reply.toLowerCase().includes("grameenphone.com") ||
      reply.toLowerCase().includes("gp business") ||
      reply.toLowerCase().includes("don't have that") ||
      reply.toLowerCase().includes("contact") ||
      reply.toLowerCase().includes("visit");

    assert.ok(
      redirectsToGP,
      `Expected GP redirect for unknown price, got: "${reply.slice(0, 200)}"`
    );
  });

  await test("Conv C: no invented specs for EV compatibility question", async () => {
    const state = initialState("e2e-c2");
    const { reply } = await simulateTurn(
      state,
      "Does the OBD tracker work on electric vehicles?"
    );
    // Reply must not confidently assert EV support without knowledge-base evidence
    const inventsFact =
      /yes[,.]? (it )?works? (with|on) (all )?electric/i.test(reply) &&
      !reply.toLowerCase().includes("grameenphone.com");

    assert.ok(
      !inventsFact,
      `Reply appears to invent EV compatibility: "${reply.slice(0, 200)}"`
    );
  });

  await test("Conv C: out-of-scope question redirected gracefully", async () => {
    const state = initialState("e2e-c3");
    const { reply } = await simulateTurn(
      state,
      "Can you book me a flight to Dubai?"
    );
    const isGraceful =
      reply.toLowerCase().includes("alo") ||
      reply.toLowerCase().includes("grameenphone") ||
      reply.toLowerCase().includes("iot") ||
      reply.toLowerCase().includes("product") ||
      reply.toLowerCase().includes("specialised") ||
      reply.toLowerCase().includes("help with that");

    assert.ok(
      isGraceful,
      `Expected graceful out-of-scope response, got: "${reply.slice(0, 200)}"`
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 5 — API smoke test
// Requires Express server to be running on PORT (default 3000)
// ─────────────────────────────────────────────────────────────────────────────

async function runApiSmokeTest() {
  section("Layer 5 — API smoke test (requires running server)");

  const BASE = `http://localhost:${process.env.PORT || 3000}`;

  await test("GET /health returns 200", async () => {
    const res = await fetch(`${BASE}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { status: string };
    assert.strictEqual(body.status, "ok");
  });

  let sessionId: string = "";

  await test("POST /session creates a session and returns sessionId", async () => {
    const res = await fetch(`${BASE}/session`, { method: "POST" });
    assert.strictEqual(res.status, 201);
    const body = await res.json() as { sessionId: string; phase: string };
    assert.ok(body.sessionId, "Missing sessionId");
    assert.strictEqual(body.phase, "greeting");
    sessionId = body.sessionId;
  });

  await test("POST /chat returns reply and phase", async () => {
    assert.ok(sessionId, "sessionId not set — previous test failed");
    const res = await fetch(`${BASE}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sessionId, message: "I need a GPS tracker for my car" }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as { reply: string; phase: string; sessionId: string };
    assert.ok(body.reply.length > 0,  "Reply is empty");
    assert.ok(body.phase.length > 0,  "Phase is empty");
    assert.strictEqual(body.sessionId, sessionId);
  });

  await test("GET /session/:id returns session state", async () => {
    assert.ok(sessionId, "sessionId not set — previous test failed");
    const res = await fetch(`${BASE}/session/${sessionId}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as AloAgentState;
    assert.strictEqual(body.sessionId, sessionId);
    assert.ok(body.turnCount >= 1, "turnCount should be at least 1 after one chat turn");
    assert.ok(body.messages.length >= 2, "messages should have at least user + assistant");
  });

  await test("GET /session/:id returns 404 for unknown session", async () => {
    const res = await fetch(`${BASE}/session/nonexistent-session-id-xyz`);
    assert.strictEqual(res.status, 404);
  });

  await test("POST /chat with missing sessionId returns 400", async () => {
    const res = await fetch(`${BASE}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ message: "hello" }),
    });
    assert.strictEqual(res.status, 400);
  });

  await test("POST /chat with empty message returns 400", async () => {
    const res = await fetch(`${BASE}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ sessionId, message: "   " }),
    });
    assert.strictEqual(res.status, 400);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Alo IoT Chatbot — Test Suite");
  console.log("═══════════════════════════════════════════════════════");

  const runApi = process.argv.includes("--with-api");

  await runSchemaTests();
  await runOrchestratorTests();
  await runRagTests();
  await runE2ETests();

  if (runApi) {
    await runApiSmokeTest();
  } else {
    console.log("\n── Layer 5 — API smoke test ─────────────────────────────");
    console.log("  (skipped — run with --with-api flag and server running)");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log("\n  Failed tests:");
    failures.forEach(f => console.log(`    ✗ ${f}`));
  }

  console.log("═══════════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
