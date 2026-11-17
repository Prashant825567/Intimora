// A tiny, privacy-free trace of what happened to the last few requests.
//
// It exists because the PHP path can fail in three ways that look identical to
// a visitor (no catalogue, no reason on screen): the host answers with its check
// page, the browser refuses to hand us the response (CORS), or the server
// returns an error status. Recording the difference lets anyone paste
// `__intimoraDiag()` from the browser console and get an answer instead of a
// screenshot. Nothing here carries tokens, cookies, headers or response bodies.
const LIMIT = 40;
const events = [];

export function recordDiagnostic(name, detail) {
  const entry = { at: Date.now(), name: String(name) };
  if (detail && typeof detail === "object") {
    for (const [key, value] of Object.entries(detail)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string") entry[key] = value.length > 120 ? value.slice(0, 120) : value;
      else if (typeof value === "number" || typeof value === "boolean") entry[key] = value;
    }
  } else if (detail !== undefined) {
    entry.detail = String(detail).slice(0, 120);
  }
  events.push(entry);
  while (events.length > LIMIT) events.shift();
  return entry;
}

export function readDiagnostics() {
  return events.map((entry) => ({ ...entry }));
}

export function clearDiagnostics() {
  events.length = 0;
}

// `window.__intimoraDiag()` prints the trace as a table and returns it, so the
// output can be copied out of a phone browser too.
export function installDiagnostics(target = globalThis) {
  if (!target || typeof target !== "object") return;
  const run = () => {
    const rows = readDiagnostics();
    try { target.console?.table?.(rows); } catch { /* A table is a nicety. */ }
    return rows;
  };
  try { target.__intimoraDiag = run; } catch { /* Host objects can refuse. */ }
}
