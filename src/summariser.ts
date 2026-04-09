// src/summariser.ts
// Generates conversation summaries at the Skill 7 thresholds:
//   - First generation: turn 15
//   - Refresh: every 10 turns after that
//
// Uses GPT-4o Mini (fast + cheap) — summary is factual, not creative.
// Called by the Orchestrator, never directly by the server.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildSummaryPrompt(
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>
): string {
  const formatted = messages
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  return `You are a helpful assistant summarising a conversation about Grameenphone Alo IoT products.
Summarise the following conversation for your own reference.

Focus on:
- Which Alo products the user asked about
- The user's stated use case or problem
- Any specific features or prices discussed
- Whether the user showed buying intent
- Anything the user was confused about or repeated

Keep the summary under 150 words. Be factual — do not add information not in the conversation.

CONVERSATION:
${formatted}`;
}

export async function generateConversationSummary(
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>
): Promise<string> {
  try {
    const response = await client.chat.completions.create({
      model:       "gpt-4o-mini",
      max_tokens:  300,
      temperature: 0,
      messages: [
        {
          role:    "system",
          content: "You are a factual summariser. Output only the summary — no preamble, no labels.",
        },
        {
          role:    "user",
          content: buildSummaryPrompt(messages),
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("[Summariser] Failed to generate summary:", err);
    return ""; // graceful degradation — Speaker will use raw history fallback
  }
}
