// src/client/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/chat.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
