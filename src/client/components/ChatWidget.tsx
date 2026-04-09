// src/client/components/ChatWidget.tsx

import { useEffect, useRef } from "react";
import { Message } from "../App";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";
import { MessageInput } from "./MessageInput";
import { PhaseLabel } from "./PhaseLabel";

interface Props {
  messages:       Message[];
  phase:          string;
  loading:        boolean;
  error:          string | null;
  initialising:   boolean;
  onSend:         (text: string) => void;
  onNewChat:      () => void;
  onProductClick: (productName: string) => void;
  onChipClick:    (text: string) => void;
}

const PRODUCTS = [
  "Vehicle Tracker OBD",
  "Vehicle Tracker",
  "Vehicle Tracker Pro",
  "Remote Socket",
  "Gas Detector",
  "Smoke Detector",
  "CC Camera",
];

const SUGGESTION_CHIPS = [
  "Tell me about the Vehicle Tracker",
  "What is the Gas Detector?",
  "Compare OBD vs Vehicle Tracker",
  "আমার গাড়ির জন্য কোন ট্র্যাকার ভালো?",
];

export function ChatWidget({
  messages, phase, loading, error, initialising,
  onSend, onNewChat, onProductClick, onChipClick
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <div className="app-root">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 12.5C4 8.36 7.36 5 11.5 5C13.89 5 16.03 6.07 17.44 7.78H20.4C18.68 4.96 15.8 3 11.5 3C6.25 3 2 7.25 2 12.5C2 17.75 6.25 22 11.5 22V20C7.36 20 4 16.64 4 12.5Z" fill="white"/>
              <circle cx="17" cy="17" r="4" fill="white"/>
            </svg>
          </div>
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-name">alo Assistant</span>
            <span className="sidebar-logo-sub">by Grameenphone</span>
          </div>
        </div>

        <button className="sidebar-new-chat" onClick={onNewChat}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          New conversation
        </button>

        <div className="sidebar-divider" />
        <div className="sidebar-label">Ask about a product</div>

        <div className="sidebar-products">
          {PRODUCTS.map(p => (
            <div
              key={p}
              className="sidebar-product-item"
              onClick={() => onProductClick(p)}
            >
              <div className="sidebar-product-dot" />
              {p}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-footer-text">
            Grameenphone Alo IoT<br />
            University Project Demo
          </div>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="chat-main">
        {/* Top bar */}
        <div className="chat-topbar">
          <div className="chat-topbar-left">
            <div className="chat-topbar-avatar">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 12.5C4 8.36 7.36 5 11.5 5C13.89 5 16.03 6.07 17.44 7.78H20.4C18.68 4.96 15.8 3 11.5 3C6.25 3 2 7.25 2 12.5C2 17.75 6.25 22 11.5 22V20C7.36 20 4 16.64 4 12.5Z" fill="white"/>
                <circle cx="17" cy="17" r="3" fill="white"/>
              </svg>
            </div>
            <div>
              <div className="chat-topbar-name">alo Assistant</div>
              <div className="chat-topbar-status">
                <span className="status-dot" />
                Online
              </div>
            </div>
          </div>
          <PhaseLabel phase={phase} />
        </div>

        {/* Messages */}
        <main className="chat-messages" role="log" aria-live="polite">
          {initialising ? (
            <div className="chat-init">
              <div className="chat-init-spinner" />
              <span>Connecting…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="chat-empty">
              <div className="chat-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 12.5C4 8.36 7.36 5 11.5 5C13.89 5 16.03 6.07 17.44 7.78H20.4C18.68 4.96 15.8 3 11.5 3C6.25 3 2 7.25 2 12.5C2 17.75 6.25 22 11.5 22V20C7.36 20 4 16.64 4 12.5Z" fill="#009BDE"/>
                  <circle cx="17" cy="17" r="4" fill="#009BDE"/>
                </svg>
              </div>
              <h2>Hi, I'm the alo Assistant</h2>
              <p>Ask me anything about Grameenphone's alo IoT products — or click a product in the sidebar to get started.</p>
              <div className="chat-empty-chips">
                {SUGGESTION_CHIPS.map(chip => (
                  <button
                    key={chip}
                    className="chat-empty-chip"
                    onClick={() => onChipClick(chip)}
                    disabled={initialising}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map(msg => <MessageBubble key={msg.id} message={msg} />)
          )}

          {loading && <TypingIndicator />}

          {error && (
            <div className="chat-error" role="alert">
              <span>⚠</span> {error}
            </div>
          )}

          <div ref={bottomRef} aria-hidden="true" />
        </main>

        {/* Input */}
        <footer className="chat-footer">
          <MessageInput
            onSend={onSend}
            disabled={loading || initialising}
            placeholder={phase === "done" ? "Click 'New conversation' to start again" : "Ask about alo products…"}
          />
          <div className="input-hint">Press Enter to send · Shift+Enter for new line</div>
        </footer>
      </div>
    </div>
  );
}
