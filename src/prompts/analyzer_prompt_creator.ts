// src/prompts/analyzer_prompt_creator.ts
// Node 1 in the 5-node pipeline.
// Assembles the full extraction prompt for the Analyzer LLM every turn.
// Pure function — no side effects, no LLM calls.
//
// Consumed by: src/analyzer.ts (Node 2)
// Reference:   skill-02-analyzer-prompt-engineering.md

import { AloAgentState } from "../../state/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Entity normalisation map (Skill 2)
// Injected into every prompt to anchor Bengali + colloquial entity extraction.
// ─────────────────────────────────────────────────────────────────────────────

const ENTITY_NORMALISATION_MAP = `
ENTITY NORMALISATION — map user language to canonical product IDs:
- "car tracker" | "GPS tracker" | "vehicle GPS" | "গাড়ি ট্র্যাকার" | "ট্র্যাকার" → specificProduct: "vehicle-tracker"
- "OBD" | "OBD2" | "OBD port" | "diagnostics tracker" | "ওবিডি" → specificProduct: "obd"
- "pro tracker" | "tracker pro" | "advanced tracker" | "প্রো ট্র্যাকার" → specificProduct: "vehicle-tracker-pro"
- "smart plug" | "socket" | "power socket" | "smart socket" | "রিমোট সকেট" → specificProduct: "remote-socket"
- "gas sensor" | "gas alarm" | "LPG detector" | "গ্যাস ডিটেক্টর" | "গ্যাস সেন্সর" → specificProduct: "gas-detector"
- "smoke alarm" | "fire detector" | "smoke sensor" | "স্মোক ডিটেক্টর" → specificProduct: "smoke-detector"
- "CCTV" | "camera" | "IP camera" | "security camera" | "CC camera" | "ক্যামেরা" → specificProduct: "cc-camera"
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// Phase-specific extraction schemas (Skill 1 / Skill 2)
// Each block goes verbatim into the prompt for the relevant phase.
// ─────────────────────────────────────────────────────────────────────────────

const PHASE_EXTRACTION_SCHEMAS: Record<string, string> = {

  greeting: `
FIELDS TO EXTRACT:
{
  "userLanguage":    "en | bn | mixed | '' — detect from script and vocabulary",
  "initialIntent":  "string — user's goal in 5-10 words, e.g. 'wants GPS tracker for car' | ''",
  "specificProduct": "obd | vehicle-tracker | vehicle-tracker-pro | remote-socket | gas-detector | smoke-detector | cc-camera | ''",
  "productCategory": "vehicle | home-safety | smart-home | ''"
}

RULES:
- userLanguage = "bn" if message is entirely Bengali script
- userLanguage = "mixed" if Bengali and English are combined
- userLanguage = "en" otherwise
- initialIntent: summarise the user's goal; never leave null — use '' if genuinely unclear
- specificProduct: only set if user names a product explicitly; never infer from category alone
- productCategory: set if user mentions a domain (car/vehicle → vehicle; gas/smoke/fire → home-safety; camera/socket/plug → smart-home)
`.trim(),

  "product-discovery": `
FIELDS TO EXTRACT:
{
  "productCategory":  "vehicle | home-safety | smart-home | ''",
  "specificProduct":  "obd | vehicle-tracker | vehicle-tracker-pro | remote-socket | gas-detector | smoke-detector | cc-camera | ''",
  "useCase":          "string — user's stated need in 5-10 words | ''",
  "urgency":          "buying-now | researching | comparing | ''",
  "hasVehicle":       "true | false | null",
  "compareProducts":  "string[] — list of product IDs if user wants comparison, else []"
}

RULES:
- productCategory = "vehicle": user mentions car, bike, truck, fleet, GPS, tracking, OBD, গাড়ি, যানবাহন
- productCategory = "home-safety": user mentions gas, smoke, fire, detector, alarm, গ্যাস, আগুন, ধোঁয়া
- productCategory = "smart-home": user mentions socket, camera, CCTV, remote, plug, ক্যামেরা, সকেট
- Do NOT infer specificProduct unless user names it explicitly
- hasVehicle = true only if user explicitly states they own a vehicle
- urgency = "buying-now" if user says "want to buy", "order", "purchase", "কিনতে চাই"
- urgency = "comparing" if user says "difference", "compare", "which is better", "তুলনা"
- compareProducts: populate only when user explicitly asks to compare ≥2 products
`.trim(),

  "product-detail": `
FIELDS TO EXTRACT:
{
  "specificProduct":  "obd | vehicle-tracker | vehicle-tracker-pro | remote-socket | gas-detector | smoke-detector | cc-camera | ''",
  "useCase":          "string — updated use case if user clarifies | ''",
  "urgency":          "buying-now | researching | comparing | ''",
  "compareProducts":  "string[] — if user now wants to compare, else []",
  "questionTopic":    "features | pricing | compatibility | installation | app | alerts | warranty | '' — topic of this question"
}

RULES:
- specificProduct: set ONLY if user explicitly names a different product than current
- PRONOUN RESOLUTION: if the user says "it", "this", "the device", "does it", "can it", "how does it" without naming a product, they are referring to the CURRENT product in focus shown in CURRENT SESSION STATE below. Do NOT change specificProduct in this case — leave it as empty string so the orchestrator keeps the current product.
- urgency = "buying-now" if user signals purchase intent ("I'll take it", "how to order", "কিনতে চাই")
- compareProducts: set if user asks "what's the difference between X and Y"
- questionTopic: classify the user's question to help the Speaker prioritise knowledge chunks
`.trim(),

  comparison: `
FIELDS TO EXTRACT:
{
  "compareProducts":  "string[] — the two or more product IDs being compared",
  "useCase":          "string — decision criteria user mentioned | ''",
  "urgency":          "buying-now | researching | comparing | ''"
}

RULES:
- compareProducts must always contain ≥2 valid product IDs
- If user mentions a new product to add to comparison, include it in the array
- urgency = "buying-now" if user picks a winner ("I'll go with the pro one")
`.trim(),

  wrapup: `
FIELDS TO EXTRACT:
{
  "specificProduct":  "obd | vehicle-tracker | vehicle-tracker-pro | remote-socket | gas-detector | smoke-detector | cc-camera | ''",
  "urgency":          "buying-now | researching | ''",
  "sessionFeedback":  "string — any final comment or question from user | ''"
}

RULES:
- specificProduct: the product user confirmed they want, if stated
- sessionFeedback: capture any last question so Speaker can answer before closing
`.trim(),

  done: `
FIELDS TO EXTRACT:
{}

RULES:
- Session is closed. Return empty JSON object {}.
`.trim(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Conversation history formatter (last 6 messages per Skill 2)
// ─────────────────────────────────────────────────────────────────────────────

function formatRecentHistory(
  messages: AloAgentState["messages"],
  limit = 6
): string {
  if (messages.length === 0) return "(no prior messages)";

  return messages
    .slice(-limit)
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main assembler — pure function
// ─────────────────────────────────────────────────────────────────────────────

export function buildAnalyzerPrompt(state: AloAgentState): string {
  const phase = state.currentPhase;
  const schema = PHASE_EXTRACTION_SCHEMAS[phase] ?? PHASE_EXTRACTION_SCHEMAS["done"];
  const history = formatRecentHistory(state.messages, 6);
  const maxTurns = getMaxTurns(phase);

  return `You are a precise intent and entity extractor for the Grameenphone Alo IoT product chatbot.

PHASE: ${phase} | TURN: ${state.phaseTurnCount + 1} of ${maxTurns}

KNOWN ALO PRODUCTS:
- alo Vehicle Tracker OBD (id: obd): Plug-in OBD port tracker for real-time vehicle diagnostics
- alo Vehicle Tracker (id: vehicle-tracker): GPS tracker with app control, geofencing, engine cut-off
- alo Vehicle Tracker Pro (id: vehicle-tracker-pro): Advanced GPS tracker with roadside assistance
- alo Remote Socket (id: remote-socket): Smart plug for remote appliance control via app
- alo Gas Detector (id: gas-detector): IoT sensor that detects gas leaks and sends alerts
- alo Smoke Detector (id: smoke-detector): IoT smoke sensor with real-time fire alerts
- alo CC Camera (id: cc-camera): Smart CCTV camera with remote viewing

${ENTITY_NORMALISATION_MAP}

RECENT CONVERSATION (last 6 messages):
${history}

USER JUST SAID:
"${state.currentUserInput}"

CURRENT SESSION STATE:
- Products discussed: ${state.mentionedProducts.length > 0 ? state.mentionedProducts.join(", ") : "none yet"}
- Current product focus: ${state.currentDetailProduct || "none"}
- User language: ${state.userLanguage || "unknown"}

EXTRACTION TASK:
${schema}

Return ONLY valid JSON matching the schema above. No preamble, no explanation, no markdown fences.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyzer LLM configuration (exported for use in analyzer.ts)
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYZER_LLM_CONFIG = {
  model:       "gpt-4o-mini" as const,
  max_tokens:  512,
  temperature: 0,
  system:
    "You are a JSON extraction engine. " +
    "Always respond with a single valid JSON object. " +
    "Never include markdown fences, preamble, or explanation. " +
    "Only output the JSON object.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helper — max turns per phase (mirrors phase_registry.ts for prompt context)
// ─────────────────────────────────────────────────────────────────────────────

function getMaxTurns(phase: string): number {
  const limits: Record<string, number> = {
    "greeting":           2,
    "product-discovery":  6,
    "product-detail":    10,
    "comparison":         6,
    "wrapup":             3,
    "done":               0,
  };
  return limits[phase] ?? 0;
}
