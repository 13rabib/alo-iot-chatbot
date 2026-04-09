// src/client/components/MessageBubble.tsx
// Renders a single chat message.
// Assistant messages: renders markdown (bold, bullets, tables).
// Inline [source](url) links are rendered as SourceLink components.

import { Message } from "../App";
import { SourceLink } from "./SourceLink";

interface Props {
  message: Message;
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal markdown renderer
// Handles: **bold**, bullet lists (- item), tables (| col |), inline links
// Keeps it dependency-free — no external markdown library needed for this scope.
// ─────────────────────────────────────────────────────────────────────────────

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let tableBuffer: string[] = [];
  let listBuffer: string[] = [];
  let key = 0;

  function flushList() {
    if (listBuffer.length === 0) return;
    nodes.push(
      <ul key={key++} className="msg-list">
        {listBuffer.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>
    );
    listBuffer = [];
  }

  function flushTable() {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer.filter(r => !/^\|[-| :]+\|/.test(r)); // remove separator row
    const [headerRow, ...bodyRows] = rows;
    const parseCells = (row: string) =>
      row.split("|").map(c => c.trim()).filter(Boolean);

    nodes.push(
      <div key={key++} className="msg-table-wrapper">
        <table className="msg-table">
          <thead>
            <tr>{parseCells(headerRow).map((h, i) => <th key={i}>{renderInline(h)}</th>)}</tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri}>
                {parseCells(row).map((cell, ci) => <td key={ci}>{renderInline(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableBuffer = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Table row
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushList();
      tableBuffer.push(trimmed);
      continue;
    } else {
      flushTable();
    }

    // Bullet list item
    if (/^[-*] /.test(trimmed)) {
      listBuffer.push(trimmed.slice(2));
      continue;
    } else {
      flushList();
    }

    // Blank line
    if (trimmed === "") {
      nodes.push(<br key={key++} />);
      continue;
    }

    // Heading (## or ###)
    if (/^#{2,3} /.test(trimmed)) {
      const level = trimmed.startsWith("###") ? 3 : 2;
      const content = trimmed.replace(/^#{2,3} /, "");
      nodes.push(
        level === 3
          ? <h3 key={key++} className="msg-h3">{renderInline(content)}</h3>
          : <h2 key={key++} className="msg-h2">{renderInline(content)}</h2>
      );
      continue;
    }

    // Regular paragraph line
    nodes.push(<p key={key++} className="msg-para">{renderInline(trimmed)}</p>);
  }

  flushList();
  flushTable();

  return nodes;
}

// Inline: **bold**, [text](url)
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Matches **bold** and [text](url)
  const pattern = /\*\*(.+?)\*\*|\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }

    if (match[1]) {
      // Bold
      parts.push(<strong key={match.index}>{match[1]}</strong>);
    } else if (match[2] && match[3]) {
      // Link
      parts.push(<SourceLink key={match.index} label={match[2]} url={match[3]} />);
    }

    last = match.index + match[0].length;
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`msg-row ${isUser ? "msg-row--user" : "msg-row--assistant"}`}>
      {!isUser && (
        <div className="msg-avatar" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="12" fill="#00A651"/>
            <path
              d="M7 12.5C7 10.01 9.01 8 11.5 8C12.97 8 14.28 8.72 15.09 9.83H17.4C16.43 8.12 14.6 7 11.5 7C8.46 7 6 9.46 6 12.5C6 15.54 8.46 18 11.5 18V16C9.01 16 7 13.99 7 12.5Z"
              fill="white"
            />
            <circle cx="16.5" cy="15.5" r="2.5" fill="white"/>
          </svg>
        </div>
      )}

      <div className={`msg-bubble ${isUser ? "msg-bubble--user" : "msg-bubble--assistant"}`}>
        {isUser
          ? <p className="msg-para">{message.content}</p>
          : renderMarkdown(message.content)
        }
        <time
          className="msg-time"
          dateTime={message.timestamp}
          title={new Date(message.timestamp).toLocaleString()}
        >
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour:   "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
    </div>
  );
}
