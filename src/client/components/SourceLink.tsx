// src/client/components/SourceLink.tsx
// Renders an inline citation link from the Speaker's markdown output.
// Opens in a new tab with rel="noopener noreferrer" for security.

interface Props {
  label: string;
  url:   string;
}

export function SourceLink({ label, url }: Props) {
  // Only allow grameenphone.com links — safety guard against prompt injection
  const isAllowed = url.startsWith("https://www.grameenphone.com") ||
                    url.startsWith("https://cdn01.grameenphone.com");

  if (!isAllowed) {
    return <span className="source-link source-link--blocked">{label}</span>;
  }

  return (
    <a
      href={url}
      className="source-link"
      target="_blank"
      rel="noopener noreferrer"
      title={url}
    >
      <svg
        className="source-link-icon"
        viewBox="0 0 12 12"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M5 2H2C1.45 2 1 2.45 1 3V10C1 10.55 1.45 11 2 11H9C9.55 11 10 10.55 10 10V7"
          stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
        />
        <path
          d="M7 1H11V5"
          stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
        />
        <path
          d="M11 1L5.5 6.5"
          stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
        />
      </svg>
      {label}
    </a>
  );
}
