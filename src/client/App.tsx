// src/client/App.tsx
// Manages a single persistent session across all product queries.
// Sidebar clicks do NOT reset the session — they just send a new message
// into the ongoing conversation, preserving full scroll history.

import { useState, useEffect } from "react";
import { ChatWidget } from "./components/ChatWidget";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000";

export interface Message {
  id:        string;
  role:      "user" | "assistant";
  content:   string;
  timestamp: string;
}

export interface ChatSession {
  sessionId: string;
  phase:     string;
}

async function createSession(): Promise<ChatSession> {
  const res = await fetch(`${API_BASE}/session`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to create session");
  return res.json();
}

async function sendMessage(
  sessionId: string,
  message: string
): Promise<{ reply: string; phase: string }> {
  const res = await fetch(`${API_BASE}/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ sessionId, message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Chat request failed");
  }
  return res.json();
}

export default function App() {
  const [session, setSession]           = useState<ChatSession | null>(null);
  const [messages, setMessages]         = useState<Message[]>([]);
  const [phase, setPhase]               = useState<string>("greeting");
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [initialising, setInitialising] = useState(true);

  // Create session once on mount — never reset automatically
  useEffect(() => {
    createSession()
      .then(s => { setSession(s); setPhase(s.phase); })
      .catch(() => setError("Could not connect to the Alo assistant. Please refresh."))
      .finally(() => setInitialising(false));
  }, []);

  // Explicit new chat — user clicked "New conversation" button only
  const handleNewChat = () => {
    setMessages([]);
    setPhase("greeting");
    setError(null);
    setInitialising(true);
    createSession()
      .then(s => { setSession(s); setPhase(s.phase); })
      .catch(() => setError("Could not connect. Please refresh."))
      .finally(() => setInitialising(false));
  };

  const handleSend = async (text: string) => {
    if (!session || loading) return;

    // If session is done, auto-start a new one
    if (phase === "done") {
      handleNewChat();
      return;
    }

    const userMsg: Message = {
      id:        crypto.randomUUID(),
      role:      "user",
      content:   text,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setError(null);

    try {
      const { reply, phase: newPhase } = await sendMessage(session.sessionId, text);
      setMessages(prev => [...prev, {
        id:        crypto.randomUUID(),
        role:      "assistant",
        content:   reply,
        timestamp: new Date().toISOString(),
      }]);
      setPhase(newPhase);
    } catch (err) {
      setError((err as Error).message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Sidebar product click — sends into existing session, no reset
  const handleProductClick = (productName: string) => {
    handleSend(`Tell me about the ${productName}`);
  };

  // Suggestion chip click — same as typing
  const handleChipClick = (text: string) => {
    handleSend(text);
  };

  return (
    <ChatWidget
      messages={messages}
      phase={phase}
      loading={loading}
      error={error}
      initialising={initialising}
      onSend={handleSend}
      onNewChat={handleNewChat}
      onProductClick={handleProductClick}
      onChipClick={handleChipClick}
    />
  );
}
