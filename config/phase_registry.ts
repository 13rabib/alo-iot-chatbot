// config/phase_registry.ts
// Defines transition rules, turn limits, and non-linear navigation for every phase.
// Consumed by the Orchestrator (src/orchestrator.ts) every turn.
// Pure configuration — no LLM calls, no side effects.

import { AloAgentState, Phase } from "../state/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Phase config interface
// ─────────────────────────────────────────────────────────────────────────────

export interface PhaseConfig {
  /** Human-readable label shown in debug/logs */
  label: string;
  /** Maximum turns before the Orchestrator forces a transition */
  maxTurns: number;
  /** Phase to advance to when canTransition returns true OR maxTurns is reached */
  nextPhase: Phase;
  /**
   * Returns true when the session has gathered enough signal to advance.
   * Called AFTER analyzer output has been merged into state.
   */
  canTransition: (state: AloAgentState) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase registry
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE_REGISTRY: Record<Phase, PhaseConfig> = {

  // ── greeting ────────────────────────────────────────────────────────────────
  // Goal: detect language + initial intent. Very short — 2 turns max.
  // Fast-track to product-detail is handled in the Orchestrator before canTransition
  // is evaluated (see orchestrator.ts → applyNonLinearNavigation).
  greeting: {
    label: "Welcome",
    maxTurns: 2,
    nextPhase: "product-discovery",
    canTransition: (s) => s.initialIntent !== "",
  },

  // ── product-discovery ───────────────────────────────────────────────────────
  // Goal: identify which product or category the user needs.
  // Comparison bypass is handled in the Orchestrator before canTransition runs.
  "product-discovery": {
    label: "Finding the right product",
    maxTurns: 6,
    nextPhase: "product-detail",
    canTransition: (s) =>
      s.specificProduct !== "" ||
      (s.productCategory !== "" && s.useCase !== ""),
  },

  // ── product-detail ──────────────────────────────────────────────────────────
  // Goal: answer all feature / compatibility / pricing questions about one product.
  // Buying-intent jump to wrapup is handled in the Orchestrator.
  // Comparison request from this phase is also intercepted before canTransition.
  "product-detail": {
    label: "Product details",
    maxTurns: 10,
    nextPhase: "wrapup",
    canTransition: (s) =>
      s.questionsAsked.length >= 2 &&
      (s.urgency === "buying-now" || s.urgency === "researching"),
  },

  // ── comparison ──────────────────────────────────────────────────────────────
  // Goal: produce a side-by-side comparison of exactly the products in compareProducts.
  comparison: {
    label: "Comparing products",
    maxTurns: 6,
    nextPhase: "wrapup",
    canTransition: (s) =>
      s.compareProducts.length >= 2 && s.phaseTurnCount >= 2,
  },

  // ── wrapup ──────────────────────────────────────────────────────────────────
  // Goal: confirm recommendation and provide GP website / contact CTA.
  wrapup: {
    label: "Recommendation & next steps",
    maxTurns: 3,
    nextPhase: "done",
    canTransition: (s) => s.recommendedProduct !== "",
  },

  // ── done ────────────────────────────────────────────────────────────────────
  // Terminal state — no further transitions.
  done: {
    label: "Session complete",
    maxTurns: 0,
    nextPhase: "done",
    canTransition: () => false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Non-linear navigation rules
// Evaluated by the Orchestrator BEFORE canTransition / maxTurns checks.
// Returns the override phase if a rule fires, otherwise null.
// ─────────────────────────────────────────────────────────────────────────────

export interface NavigationOverride {
  targetPhase: Phase;
  reason: string;
}

export function applyNonLinearNavigation(
  state: AloAgentState,
  analyzerOutput: Record<string, unknown>
): NavigationOverride | null {

  const out = analyzerOutput;

  // ── Rule 1: Greeting fast-track ─────────────────────────────────────────────
  // If user names a specific product in their very first message, skip discovery.
  if (
    state.currentPhase === "greeting" &&
    typeof out.specificProduct === "string" &&
    out.specificProduct !== ""
  ) {
    return {
      targetPhase: "product-detail",
      reason: `Fast-track: user named product "${out.specificProduct}" in greeting`,
    };
  }

  // ── Rule 2: Comparison bypass (any phase) ───────────────────────────────────
  // If user explicitly asks to compare ≥2 products, jump to comparison immediately.
  if (
    Array.isArray(out.compareProducts) &&
    (out.compareProducts as string[]).length >= 2 &&
    state.currentPhase !== "comparison"
  ) {
    return {
      targetPhase: "comparison",
      reason: `Comparison bypass: user wants to compare [${(out.compareProducts as string[]).join(", ")}]`,
    };
  }

  // ── Rule 3: Buying-intent jump (product-detail only) ────────────────────────
  // If user signals they want to buy while in product-detail, skip to wrapup.
  if (
    state.currentPhase === "product-detail" &&
    out.urgency === "buying-now" &&
    state.currentDetailProduct !== ""
  ) {
    return {
      targetPhase: "wrapup",
      reason: `Buying intent detected for "${state.currentDetailProduct}"`,
    };
  }

  // ── Rule 4: Mid-session "I want to buy this" from any phase ─────────────────
  if (
    out.urgency === "buying-now" &&
    state.currentPhase !== "wrapup" &&
    state.currentPhase !== "done" &&
    (state.specificProduct !== "" || state.currentDetailProduct !== "")
  ) {
    return {
      targetPhase: "wrapup",
      reason: "Buying intent from outside product-detail phase",
    };
  }

  // ── Rule 5: Product switch mid-detail ───────────────────────────────────────
  // User asks about a completely different product category — reset to discovery.
  if (
    state.currentPhase === "product-detail" &&
    typeof out.productCategory === "string" &&
    out.productCategory !== "" &&
    out.productCategory !== state.productCategory &&
    (typeof out.specificProduct !== "string" || out.specificProduct === "")
  ) {
    return {
      targetPhase: "product-discovery",
      reason: `Category switch from "${state.productCategory}" to "${out.productCategory}"`,
    };
  }

  return null; // no override — proceed with standard canTransition / maxTurns logic
}

// ─────────────────────────────────────────────────────────────────────────────
// Transition evaluator
// Called by Orchestrator after non-linear rules have been checked.
// ─────────────────────────────────────────────────────────────────────────────

export interface TransitionResult {
  shouldTransition: boolean;
  nextPhase: Phase;
  reason: string;
}

export function evaluateTransition(state: AloAgentState): TransitionResult {
  const config = PHASE_REGISTRY[state.currentPhase];

  // Terminal phase — never transitions
  if (state.currentPhase === "done") {
    return { shouldTransition: false, nextPhase: "done", reason: "Session already done" };
  }

  // canTransition predicate fires
  if (config.canTransition(state)) {
    return {
      shouldTransition: true,
      nextPhase: config.nextPhase,
      reason: `canTransition satisfied in phase "${state.currentPhase}"`,
    };
  }

  // maxTurns exceeded — force advance
  if (state.phaseTurnCount >= config.maxTurns) {
    return {
      shouldTransition: true,
      nextPhase: config.nextPhase,
      reason: `maxTurns (${config.maxTurns}) reached in phase "${state.currentPhase}"`,
    };
  }

  return {
    shouldTransition: false,
    nextPhase: state.currentPhase,
    reason: "No transition condition met",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stuck session detection (logged only — no user-facing change)
// ─────────────────────────────────────────────────────────────────────────────

export function isStuckSession(state: AloAgentState): boolean {
  return (
    state.turnCount > 20 &&
    (state.currentPhase === "greeting" || state.currentPhase === "product-discovery")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn limit reference (informational)
// ─────────────────────────────────────────────────────────────────────────────
//
// Phase              | maxTurns | Rationale
// ------------------ | -------- | -------------------------------------------
// greeting           |    2     | Quick orientation only
// product-discovery  |    6     | 3 questions max before committing to product
// product-detail     |   10     | Users have many specific product questions
// comparison         |    6     | Table + a few follow-ups
// wrapup             |    3     | Confirm + CTA — keep brief
// done               |    0     | Terminal
