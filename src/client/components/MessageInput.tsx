// src/client/components/MessageInput.tsx

import { useState, useRef, useEffect } from "react";

interface Props {
  onSend:      (text: string) => void;
  disabled:    boolean;
  placeholder: string;
}

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [value, setValue]  = useState("");
  const textareaRef        = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);

  const handleSubmit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="msg-input-bar">
      <textarea
        ref={textareaRef}
        className="msg-input-textarea"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label="Type your message"
        lang="bn"
      />
      <button
        className="msg-input-send"
        onClick={handleSubmit}
        disabled={disabled || value.trim().length === 0}
        aria-label="Send message"
      >
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M17.5 10L3.5 3L6.5 10L3.5 17L17.5 10Z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  );
}
