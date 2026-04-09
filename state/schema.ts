// state/schema.ts
// Single source of truth for all session state.
// Persisted as JSON blob in SQLite after every turn.

export type Phase =
  | "greeting"
  | "product-discovery"
  | "product-detail"
  | "comparison"
  | "wrapup"
  | "done";

export type ProductId =
  | "obd"
  | "vehicle-tracker"
  | "vehicle-tracker-pro"
  | "remote-socket"
  | "gas-detector"
  | "smoke-detector"
  | "cc-camera"
  | "";

export type ProductCategory = "vehicle" | "home-safety" | "smart-home" | "";

export type UrgencyLevel = "buying-now" | "researching" | "comparing" | "";

export type UserLanguage = "en" | "bn" | "mixed" | "";

// ─────────────────────────────────────────────────────────────────────────────
// Main state interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AloAgentState {
  // ── Session metadata ────────────────────────────────────────────────────────
  sessionId: string;           // UUID assigned at session creation
  currentPhase: Phase;         // active conversation phase
  turnCount: number;           // total turns since session start (never decreases)
  phaseTurnCount: number;      // turns within current phase (resets on transition)
  createdAt: string;           // ISO 8601

  // ── Conversation history ────────────────────────────────────────────────────
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;         // ISO 8601
  }>;
  conversationSummary: string; // auto-generated after 15 turns; refreshed every 10 turns after

  // ── Phase: greeting ─────────────────────────────────────────────────────────
  userLanguage: UserLanguage;  // detected from first message(s) — update: overwrite
  initialIntent: string;       // raw intent captured from first message — update: set-once

  // ── Phase: product-discovery ────────────────────────────────────────────────
  productCategory: ProductCategory; // vehicle | home-safety | smart-home — update: overwrite
  specificProduct: ProductId;       // product user has named — update: overwrite
  useCase: string;                  // user's stated need in ≤10 words — update: overwrite
  urgency: UrgencyLevel;            // buying-now | researching | comparing — update: overwrite
  hasVehicle: boolean | null;       // explicitly stated ownership — update: overwrite

  // ── Phase: product-detail ───────────────────────────────────────────────────
  currentDetailProduct: ProductId;  // product currently being discussed — update: overwrite
  questionsAsked: string[];         // user questions answered this session — update: append
  mentionedProducts: ProductId[];   // all products user referenced — update: append + dedupe

  // ── Phase: comparison ──────────────────────────────────────────────────────
  compareProducts: ProductId[];     // products to compare (≥2 to enter phase) — update: overwrite

  // ── Phase: wrapup ──────────────────────────────────────────────────────────
  recommendedProduct: ProductId;    // final recommendation — update: set-once
  sessionClosed: boolean;           // true once wrapup completes — update: set-once

  // ── Scratch fields (reset each turn before Analyzer runs) ──────────────────
  currentUserInput: string;                    // raw input this turn
  currentAssistantReply: string;               // speaker output this turn
  analyzerOutput: Record<string, unknown>;     // raw JSON from Analyzer LLM
  ragContext: string;                          // knowledge chunks injected for this turn
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory — safe defaults; all fields falsy
// ─────────────────────────────────────────────────────────────────────────────

export function initialState(sessionId: string): AloAgentState {
  return {
    // Session metadata
    sessionId,
    currentPhase: "greeting",
    turnCount: 0,
    phaseTurnCount: 0,
    createdAt: new Date().toISOString(),

    // Conversation history
    messages: [],
    conversationSummary: "",

    // Greeting
    userLanguage: "",
    initialIntent: "",

    // Product discovery
    productCategory: "",
    specificProduct: "",
    useCase: "",
    urgency: "",
    hasVehicle: null,

    // Product detail
    currentDetailProduct: "",
    questionsAsked: [],
    mentionedProducts: [],

    // Comparison
    compareProducts: [],

    // Wrapup
    recommendedProduct: "",
    sessionClosed: false,

    // Scratch (reset each turn)
    currentUserInput: "",
    currentAssistantReply: "",
    analyzerOutput: {},
    ragContext: "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Update policy reference (for orchestrator authors)
// ─────────────────────────────────────────────────────────────────────────────
//
// Field                  | Policy
// ---------------------- | --------------------------------------------------
// currentPhase           | Overwrite (orchestrator controls)
// turnCount              | Always +1 (never skip, never decrease)
// phaseTurnCount         | +1 per turn; reset to 0 on phase transition
// userLanguage           | Overwrite
// initialIntent          | Set-once (never overwrite after first assignment)
// productCategory        | Overwrite
// specificProduct        | Overwrite
// useCase                | Overwrite (refinement allowed)
// urgency                | Overwrite
// hasVehicle             | Overwrite
// currentDetailProduct   | Overwrite
// questionsAsked         | Append
// mentionedProducts      | Append + deduplicate
// compareProducts        | Overwrite (replace entire array)
// recommendedProduct     | Set-once
// sessionClosed          | Set-once (true only)
// conversationSummary    | Overwrite (regenerated on schedule)
// ragContext             | Always refreshed — never cached across turns
// analyzerOutput         | Overwrite (scratch)
// currentUserInput       | Overwrite (scratch)
// currentAssistantReply  | Overwrite (scratch)
