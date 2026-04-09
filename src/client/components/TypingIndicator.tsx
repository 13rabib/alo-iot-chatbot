// src/client/components/TypingIndicator.tsx

export function TypingIndicator() {
  return (
    <div className="msg-row msg-row--assistant" aria-label="alo assistant is typing">
      <div className="msg-avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 12.5C4 8.36 7.36 5 11.5 5C13.89 5 16.03 6.07 17.44 7.78H20.4C18.68 4.96 15.8 3 11.5 3C6.25 3 2 7.25 2 12.5C2 17.75 6.25 22 11.5 22V20C7.36 20 4 16.64 4 12.5Z" fill="white"/>
          <circle cx="17" cy="17" r="3" fill="white"/>
        </svg>
      </div>
      <div className="msg-bubble msg-bubble--assistant msg-bubble--typing">
        <span className="typing-dot" style={{ animationDelay: "0ms"   }} />
        <span className="typing-dot" style={{ animationDelay: "160ms" }} />
        <span className="typing-dot" style={{ animationDelay: "320ms" }} />
      </div>
    </div>
  );
}
