// src/orchestrator.ts
// Node 3 in the 5-node pipeline.
// Pure deterministic TypeScript — NO LLM calls here.
//
// Responsibilities every turn:
//   1. Reset scratch fields
//   2. Merge Analyzer JSON output into session state (phase-specific rules)
//   3. Apply non-linear navigation overrides
//   4. Evaluate standard phase transition (canTransition / maxTurns)
//   5. Retrieve RAG context from ChromaDB for the Speaker
//   6. Schedule conversation summary generation (Skill 7 thresholds)
//   7. Increment turn counters
//   8. Log stuck sessions

import {
  AloAgentState,
  Phase,
  ProductId,
  ProductCategory,
  UrgencyLevel,
  UserLanguage,
} from "../state/schema";

import {
  applyNonLinearNavigation,
  evaluateTransition,
  isStuckSession,
  PHASE_REGISTRY,
} from "../config/phase_registry";

import { queryKnowledgeBase } from "./rag";
import { generateConversationSummary } from "./summariser";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (Skill 7 thresholds)
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_GENERATE_THRESHOLD = 15;  // generate first summary at this turn count
const SUMMARY_REFRESH_INTERVAL   = 10;  // regenerate every N turns after threshold

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function isValidProductId(value: unknown): value is ProductId {
  const valid: ProductId[] = [
    "obd", "vehicle-tracker", "vehicle-tracker-pro",
    "remote-socket", "gas-detector", "smoke-detector", "cc-camera", "",
  ];
  return typeof value === "string" && valid.includes(value as ProductId);
}

function isValidCategory(value: unknown): value is ProductCategory {
  return typeof value === "string" &&
    ["vehicle", "home-safety", "smart-home", ""].includes(value as string);
}

function isValidUrgency(value: unknown): value is UrgencyLevel {
  return typeof value === "string" &&
    ["buying-now", "researching", "comparing", ""].includes(value as string);
}

function isValidLanguage(value: unknown): value is UserLanguage {
  return typeof value === "string" &&
    ["en", "bn", "mixed", ""].includes(value as string);
}

export const PRODUCT_NAMES: Record<ProductId, string> = {
  "obd":                 "alo Vehicle Tracker OBD",
  "vehicle-tracker":     "alo Vehicle Tracker",
  "vehicle-tracker-pro": "alo Vehicle Tracker Pro",
  "remote-socket":       "alo Remote Socket",
  "gas-detector":        "alo Gas Detector",
  "smoke-detector":      "alo Smoke Detector",
  "cc-camera":           "alo CC Camera",
  "":                    "",
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase-specific merge functions
// Each returns a partial state update — never mutates state directly.
// ─────────────────────────────────────────────────────────────────────────────

function mergeGreeting(
  state: AloAgentState,
  out: Record<string, unknown>
): Partial<AloAgentState> {
  const update: Partial<AloAgentState> = {};

  if (isValidLanguage(out.userLanguage) && out.userLanguage) {
    update.userLanguage = out.userLanguage;
  }

  // set-once
  if (!state.initialIntent && typeof out.initialIntent === "string" && out.initialIntent) {
    update.initialIntent = out.initialIntent;
  }

  // Carry product signals forward so non-linear navigation can fire
  if (isValidProductId(out.specificProduct) && out.specificProduct) {
    update.specificProduct = out.specificProduct;
    update.currentDetailProduct = out.specificProduct;
    update.mentionedProducts = dedupe([...state.mentionedProducts, out.specificProduct]);
  }

  if (isValidCategory(out.productCategory) && out.productCategory) {
    update.productCategory = out.productCategory;
  }

  return update;
}

function mergeProductDiscovery(
  state: AloAgentState,
  out: Record<string, unknown>
): Partial<AloAgentState> {
  const update: Partial<AloAgentState> = {};

  if (isValidCategory(out.productCategory) && out.productCategory) {
    update.productCategory = out.productCategory;
  }

  if (isValidProductId(out.specificProduct) && out.specificProduct) {
    update.specificProduct = out.specificProduct;
    update.currentDetailProduct = out.specificProduct;
    update.mentionedProducts = dedupe([...state.mentionedProducts, out.specificProduct]);
  }

  if (typeof out.useCase === "string" && out.useCase) {
    update.useCase = out.useCase;
  }

  if (isValidUrgency(out.urgency) && out.urgency) {
    update.urgency = out.urgency;
  }

  if (typeof out.hasVehicle === "boolean") {
    update.hasVehicle = out.hasVehicle;
  }

  // compareProducts carried forward so non-linear navigation can fire
  if (Array.isArray(out.compareProducts) && out.compareProducts.length >= 2) {
    update.compareProducts = out.compareProducts as ProductId[];
  }

  return update;
}

function mergeProductDetail(
  state: AloAgentState,
  out: Record<string, unknown>
): Partial<AloAgentState> {
  const update: Partial<AloAgentState> = {};

  // Product switch — user is now asking about a different product
  if (
    isValidProductId(out.specificProduct) &&
    out.specificProduct &&
    out.specificProduct !== state.currentDetailProduct
  ) {
    update.currentDetailProduct = out.specificProduct;
    update.specificProduct = out.specificProduct;
    update.mentionedProducts = dedupe([...state.mentionedProducts, out.specificProduct]);
  }

  if (typeof out.useCase === "string" && out.useCase) {
    update.useCase = out.useCase;
  }

  if (isValidUrgency(out.urgency) && out.urgency) {
    update.urgency = out.urgency;
  }

  // Track every user question answered this session
  if (state.currentUserInput) {
    update.questionsAsked = [...state.questionsAsked, state.currentUserInput];
  }

  // compareProducts carried forward
  if (Array.isArray(out.compareProducts) && out.compareProducts.length >= 2) {
    update.compareProducts = out.compareProducts as ProductId[];
  }

  return update;
}

function mergeComparison(
  state: AloAgentState,
  out: Record<string, unknown>
): Partial<AloAgentState> {
  const update: Partial<AloAgentState> = {};

  if (Array.isArray(out.compareProducts) && out.compareProducts.length >= 2) {
    update.compareProducts = out.compareProducts as ProductId[];
  }

  return update;
}

function mergeWrapup(
  state: AloAgentState,
  out: Record<string, unknown>
): Partial<AloAgentState> {
  const update: Partial<AloAgentState> = {};

  // set-once: use the most specific product signal available
  if (!state.recommendedProduct) {
    const candidate =
      (isValidProductId(out.specificProduct) && out.specificProduct
        ? out.specificProduct
        : null) ||
      state.currentDetailProduct ||
      state.specificProduct;

    if (candidate) {
      update.recommendedProduct = candidate as ProductId;
    }
  }

  // Close session after first wrapup reply has been delivered
  if (state.phaseTurnCount >= 1 && !state.sessionClosed) {
    update.sessionClosed = true;
  }

  return update;
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG search query builder
// ─────────────────────────────────────────────────────────────────────────────

function buildRagQuery(state: AloAgentState): string {
  const parts: string[] = [state.currentUserInput];

  const productForSearch =
    state.currentDetailProduct ||
    state.specificProduct ||
    (state.compareProducts.length > 0 ? state.compareProducts.join(" vs ") : "");

  if (productForSearch) {
    parts.push(PRODUCT_NAMES[productForSearch as ProductId] || productForSearch);
  }

  if (state.useCase) parts.push(state.useCase);
  if (state.productCategory) parts.push(state.productCategory);

  return parts.filter(Boolean).join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary scheduling (Skill 7)
// ─────────────────────────────────────────────────────────────────────────────

async function maybeRefreshSummary(state: AloAgentState): Promise<string> {
  const { turnCount, conversationSummary, messages } = state;

  // Not yet at threshold
  if (turnCount < SUMMARY_GENERATE_THRESHOLD) {
    return conversationSummary;
  }

  // First generation
  if (!conversationSummary) {
    console.log(`[Summariser] Generating first summary at turn ${turnCount}`);
    return await generateConversationSummary(messages);
  }

  // Periodic refresh every SUMMARY_REFRESH_INTERVAL turns after threshold
  const turnsSinceThreshold = turnCount - SUMMARY_GENERATE_THRESHOLD;
  if (turnsSinceThreshold > 0 && turnsSinceThreshold % SUMMARY_REFRESH_INTERVAL === 0) {
    console.log(`[Summariser] Refreshing summary at turn ${turnCount}`);
    return await generateConversationSummary(messages);
  }

  return conversationSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrate function
// Called by the server after Analyzer LLM returns its JSON.
// Returns the fully updated state ready for the Speaker Prompt Creator.
// ─────────────────────────────────────────────────────────────────────────────

export async function orchestrate(
  state: AloAgentState,
  analyzerOutput: Record<string, unknown>
): Promise<AloAgentState> {

  // ── 0. Store raw analyzer output (scratch) ──────────────────────────────────
  let next: AloAgentState = {
    ...state,
    analyzerOutput,
  };

  // ── 1. Phase-specific merge ─────────────────────────────────────────────────
  let phaseUpdate: Partial<AloAgentState> = {};

  switch (next.currentPhase) {
    case "greeting":
      phaseUpdate = mergeGreeting(next, analyzerOutput);
      break;
    case "product-discovery":
      phaseUpdate = mergeProductDiscovery(next, analyzerOutput);
      break;
    case "product-detail":
      phaseUpdate = mergeProductDetail(next, analyzerOutput);
      break;
    case "comparison":
      phaseUpdate = mergeComparison(next, analyzerOutput);
      break;
    case "wrapup":
      phaseUpdate = mergeWrapup(next, analyzerOutput);
      break;
    case "done":
      // No merging — session is closed
      break;
  }

  next = { ...next, ...phaseUpdate };

  // ── 2. Non-linear navigation (checked BEFORE standard transition) ───────────
  const navOverride = applyNonLinearNavigation(next, analyzerOutput);

  if (navOverride) {
    console.log(`[Orchestrator] Navigation override → ${navOverride.targetPhase}: ${navOverride.reason}`);
    next = {
      ...next,
      currentPhase: navOverride.targetPhase,
      phaseTurnCount: 0,
    };
  } else {
    // ── 3. Standard phase transition ─────────────────────────────────────────
    const transition = evaluateTransition(next);

    if (transition.shouldTransition) {
      console.log(`[Orchestrator] Phase transition → ${transition.nextPhase}: ${transition.reason}`);
      next = {
        ...next,
        currentPhase: transition.nextPhase,
        phaseTurnCount: 0,
      };
    }
  }

  // ── 4. RAG retrieval — always refresh, never cache across turns ─────────────
  try {
    const ragQuery = buildRagQuery(next);
    const chunks = await queryKnowledgeBase(ragQuery, 4);
    next.ragContext = chunks
      .map(c => `[SOURCE: ${PRODUCT_NAMES[c.productId as ProductId] || c.productId} — ${c.sourceUrl}]\n${c.text}`)
      .join("\n\n");
  } catch (err) {
    console.error("[Orchestrator] RAG retrieval failed:", err);
    // Skill 8 fallback — Speaker will redirect to GP website
    next.ragContext =
      "I was unable to retrieve product details for this query. " +
      "Please advise the user to visit grameenphone.com/business for accurate information.";
  }

  // ── 5. Conversation summary scheduling ─────────────────────────────────────
  next.conversationSummary = await maybeRefreshSummary(next);

  // ── 6. Increment turn counters ──────────────────────────────────────────────
  next.turnCount = state.turnCount + 1;
  next.phaseTurnCount = next.phaseTurnCount + 1;
  // Note: if a phase transition just fired, phaseTurnCount was reset to 0 above,
  // so +1 here correctly starts the new phase at turn 1.

  // ── 7. Stuck session detection (log only — no user-facing change) ───────────
  if (isStuckSession(next)) {
    console.warn(
      `[Orchestrator] STUCK SESSION detected: sessionId=${next.sessionId} ` +
      `turnCount=${next.turnCount} phase=${next.currentPhase}`
    );
  }

  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant checklist (enforced above — documented here for auditing)
// ─────────────────────────────────────────────────────────────────────────────
//
// ✓  turnCount always +1, never decreases
// ✓  phaseTurnCount resets to 0 on transition, then +1 for the new phase's first turn
// ✓  recommendedProduct and initialIntent are set-once (checked before assign)
// ✓  ragContext always refreshed — never carried over from previous turn
// ✓  Orchestrator makes zero LLM calls (RAG is a vector similarity search, not generation)
// ✓  analyzerOutput stored as scratch — overwritten every turn
