import React from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { MetaGate } from "@/lib/meta";
import "@/index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MetaGate>
      <App />
    </MetaGate>
  </React.StrictMode>,
);
