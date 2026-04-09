// src/analyzer.ts
// Node 2 in the 5-node pipeline.
// Calls the Analyzer LLM (GPT-4o Mini) with the prompt from Node 1.
// Returns parsed JSON or {} on any failure — never throws.

import OpenAI from "openai";
import { AloAgentState } from "../state/schema";
import {
  buildAnalyzerPrompt,
  ANALYZER_LLM_CONFIG,
} from "./prompts/analyzer_prompt_creator";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function runAnalyzer(
  state: AloAgentState
): Promise<Record<string, unknown>> {
  const prompt = buildAnalyzerPrompt(state);

  try {
    const response = await client.chat.completions.create({
      model:       ANALYZER_LLM_CONFIG.model,
      max_tokens:  ANALYZER_LLM_CONFIG.max_tokens,
      temperature: ANALYZER_LLM_CONFIG.temperature,
      messages: [
        { role: "system", content: ANALYZER_LLM_CONFIG.system },
        { role: "user",   content: prompt },
      ],
      response_format: { type: "json_object" }, // GPT-4o Mini native JSON mode
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) {
      console.warn(`[Analyzer] Empty response on turn ${state.turnCount}`);
      return {};
    }

    // Strip any accidental markdown fences (belt-and-suspenders)
    const raw = text.replace(/^```json|^```|```$/gm, "").trim();
    return JSON.parse(raw) as Record<string, unknown>;

  } catch (err) {
    console.error(
      `[Analyzer] Empty/unparseable output on turn ${state.turnCount}:`,
      (err as Error).message
    );
    return {};
  }
}
