// src/speaker.ts
// Node 5 in the 5-node pipeline.
// Calls the Speaker LLM (GPT-4o Mini) with the prompt from Node 4.
// Returns the reply string, or a phase-appropriate fallback on failure.

import OpenAI from "openai";
import { AloAgentState } from "../state/schema";
import {
  buildSpeakerPrompt,
  SPEAKER_LLM_CONFIG,
  FALLBACK_REPLIES,
} from "./prompts/speaker_prompt_creator";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function runSpeaker(state: AloAgentState): Promise<string> {
  const prompt = buildSpeakerPrompt(state);

  try {
    const response = await client.chat.completions.create({
      model:       SPEAKER_LLM_CONFIG.model,
      max_tokens:  SPEAKER_LLM_CONFIG.max_tokens,
      temperature: SPEAKER_LLM_CONFIG.temperature,
      messages: [
        { role: "user", content: prompt },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) {
      console.warn(`[Speaker] Empty response on turn ${state.turnCount}`);
      return getFallback(state.currentPhase);
    }

    return text;

  } catch (err) {
    // Skill 8 — graceful fallback, never crash
    console.error(
      `[Speaker] LLM failure on turn ${state.turnCount}:`,
      (err as Error).message
    );
    return getFallback(state.currentPhase);
  }
}

function getFallback(phase: string): string {
  return (
    FALLBACK_REPLIES[phase] ??
    "I encountered a brief issue. Please try again or visit grameenphone.com/business."
  );
}
