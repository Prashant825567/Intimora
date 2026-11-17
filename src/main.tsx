import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dancing-script/latin-700.css";
import "./index.css";
import App from "./App";
import { completeUnlockReturn, unlockReturnedThisLoad } from "./services/unlock.mjs";
import { installDiagnostics, recordDiagnostic } from "./services/diagnostics.mjs";

// `__intimoraDiag()` in the browser console prints what the last requests did —
// the three PHP failure shapes (check page, blocked request, error status) look
// identical on screen.
installDiagnostics();

// Coming back from the PHP host's unlock page: drop `?__unlocked` from the
// address bar and clear the splash before the app renders.
if (completeUnlockReturn()) recordDiagnostic("unlock-return", { href: globalThis.location?.pathname ?? "" });
if (unlockReturnedThisLoad()) recordDiagnostic("unlock-return-flag", {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
