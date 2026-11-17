import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dancing-script/latin-700.css";
import "./index.css";
import App from "./App";
import { completeUnlockReturn } from "./services/unlock.mjs";

// Coming back from the PHP host's unlock page: drop `?__unlocked` from the
// address bar and clear the splash before the app renders.
completeUnlockReturn();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
