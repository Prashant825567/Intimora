import { useCallback, useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";

// Grace's own mark: a four-point sparkle with a smaller star and a dot beside it.
// Drawn inline so it keeps its exact shape at any size and needs no icon package.
function GraceMark() {
  return (
    <svg className="grace__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M11.4 2.3c.55 4.05 2.1 5.6 6.15 6.15-4.05.55-5.6 2.1-6.15 6.15-.55-4.05-2.1-5.6-6.15-6.15 4.05-.55 5.6-2.1 6.15-6.15Z"
        fill="currentColor"
      />
      <path
        d="M18.05 13.7c.32 2.25 1.18 3.1 3.43 3.43-2.25.32-3.1 1.18-3.43 3.43-.32-2.25-1.18-3.1-3.43-3.43 2.25-.32 3.1-1.18 3.43-3.43Z"
        fill="currentColor"
        opacity="0.72"
      />
      <circle cx="5.9" cy="17.9" r="1.5" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

type Message = {
  id: number;
  from: "grace" | "user";
  text: string;
};

const WELCOME: Message = {
  id: 0,
  from: "grace",
  text: "Hi, I'm Grace. Ask me about premium, saving videos, search or anything that looks broken on Intimora.",
};

const SUGGESTIONS = ["What is premium?", "How do I save a video?", "Search is not working"];

function has(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

/** In-site answers. No network call, no key, no cost. */
function answer(raw: string): string {
  const text = raw.toLowerCase();

  if (has(text, ["hi", "hello", "hey", "namaste", "hii"]) && text.length < 24) {
    return "Hey! I'm Grace. Tell me what you need — premium, saved videos, search or a video that won't play.";
  }

  if (has(text, ["premium", "paid", "subscription", "unlock", "plan", "price"])) {
    return "Premium unlocks the full library and the premium row on the home page. Open Premium from the account menu and pick a plan; the unlock is applied to your account as soon as the payment is confirmed, so the premium videos appear without a reload.";
  }

  if (has(text, ["sign in", "sign up", "signin", "signup", "log in", "login", "register", "account", "password"])) {
    return "Sign in from the button at the top right. An account is what keeps your likes and saves across visits and devices, and it is required before premium can be attached to you. If you cannot get in, tell me what the screen says and I will narrow it down.";
  }

  if (has(text, ["save", "saved", "like", "liked", "favourite", "favorite", "watch later"])) {
    return "Use the save and like buttons on any card or in the player. Both live on your account, so they follow you to Saved and Liked on any device once you are signed in. Out here, signed out, they only last for this visit.";
  }

  if (has(text, ["search", "find", "look for", "filter"])) {
    return "Type in the bar at the top and press Enter. Search covers titles and tags across the whole catalog, and it also returns matching anime. If it answers with nothing, try a shorter word — two or three letters usually finds more than a full sentence.";
  }

  if (has(text, ["upload", "creator", "my video", "submit"])) {
    return "Uploads are not open from this page yet. Creator submissions are reviewed before anything is published, so they are handled through the contact route in the footer rather than a form here.";
  }

  if (has(text, ["download", "offline"])) {
    return "Videos stream only; there is no download button. Playing a video again is instant once it has buffered, so keep the tab open if you plan to come back to it.";
  }

  if (has(text, ["loading", "buffering", "stuck", "error", "broken", "not working", "blank", "play", "slow", "500", "503"])) {
    return "First try a reload and check whether other videos play: if only one fails, that video is the problem and the rest of the site is fine. If nothing plays, the media server may still be waking up — give it a few seconds and press Retry. A private network or tracker blocker can also break playback, so try without it.";
  }

  if (has(text, ["adult", "18", "age", "safe", "privacy"])) {
    return "The site is for adults only and the age gate is stored per browser. Nothing about your visit is shown on your profile, and likes or saves are only visible on your own account.";
  }

  if (has(text, ["thank", "thanks", "ok", "okay", "cool"])) {
    return "Anytime. If something still looks off, say which page and what you see.";
  }

  return "I can help with premium, signing in, saving and liking videos, search, playback problems and downloads. Could you say a little more about what you are trying to do — for example \"premium payment failed\" or \"search shows nothing\"?";
}

const GraceWidget = () => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [typing, setTyping] = useState(false);
  const nextId = useRef(1);
  const timer = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, typing, open]);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const send = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;

      setMessages((prev) => [...prev, { id: nextId.current++, from: "user", text: value }]);
      setDraft("");
      setTyping(true);

      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setMessages((prev) => [...prev, { id: nextId.current++, from: "grace", text: answer(value) }]);
        setTyping(false);
        timer.current = null;
      }, 450);
    },
    [],
  );

  return (
    <div className="grace">
      {!open && (
        <button
          type="button"
          className="grace__fab"
          onClick={() => setOpen(true)}
          aria-label="Open Grace"
        >
          <GraceMark />
          <span className="grace__fab-dot" aria-hidden="true" />
        </button>
      )}

      {open && (
        <section className="grace__panel" role="dialog" aria-label="Grace">
          <header className="grace__header">
            <div className="grace__avatar" aria-hidden="true">G</div>
            <div className="grace__heading">
              <p className="grace__title">Grace</p>
              <p className="grace__subtitle">Intimora assistant</p>
            </div>
            <button
              type="button"
              className="grace__close"
              onClick={() => setOpen(false)}
              aria-label="Close Grace"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </header>

          <div className="grace__log" ref={logRef} aria-live="polite">
            {messages.map((message) => (
              <p key={message.id} className={`grace__bubble grace__bubble--${message.from}`}>
                {message.text}
              </p>
            ))}
            {typing && (
              <p className="grace__bubble grace__bubble--grace grace__typing" aria-label="Grace is typing">
                <span />
                <span />
                <span />
              </p>
            )}
            {messages.length === 1 && !typing && (
              <div className="grace__chips">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="grace__chip"
                    onClick={() => send(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>

          <form
            className="grace__form"
            onSubmit={(event) => {
              event.preventDefault();
              send(draft);
            }}
          >
            <label className="grace__sr" htmlFor="grace-input">Message Grace</label>
            <input
              id="grace-input"
              ref={inputRef}
              className="grace__input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask Grace anything…"
              autoComplete="off"
            />
            <button type="submit" className="grace__send" disabled={!draft.trim()} aria-label="Send message">
              <Send className="w-4 h-4" aria-hidden="true" />
            </button>
          </form>
          <p className="grace__note">Automated answers about Intimora.</p>
        </section>
      )}
    </div>
  );
};

export default GraceWidget;
