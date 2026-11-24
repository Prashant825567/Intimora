import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, Sparkles } from "lucide-react";
import type { FirebaseUser } from "../services/firebase";
import { getPremiumHistory, getPremiumStatus, redeemReferrals } from "../services/account-api";
import { formatPremiumWindow, premiumSecondsLeft, redeemErrorMessage, redemptionSeconds } from "../services/premium.mjs";
import type { PremiumHistory, PremiumStatus } from "../services/premium.mjs";
import { AccountRequestError } from "../services/auth-request.mjs";

// The premium window is the backend's, not ours: this panel asks for the status,
// offers the referrals the backend says are available, and shows the answer.
// Nothing is computed locally that the server also computes.
interface Props {
  user: FirebaseUser;
  backend?: string;
  // Called after a redemption so the catalogue can be re-read: the stream links
  // in the page were issued for the window that just changed.
  onChanged?: () => void;
}

export default function PremiumPanel({ user, backend, onChanged }: Props) {
  const [status, setStatus] = useState<PremiumStatus | null>(null);
  const [history, setHistory] = useState<PremiumHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [failing, setFailing] = useState(false);
  const [busy, setBusy] = useState(0);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  // One tick per second only while a window is open: the countdown is drawn from
  // the server's `until`/`serverNow`, so it keeps moving with no extra requests.
  const [now, setNow] = useState(() => Date.now());
  const activeWindow = status?.active === true;

  useEffect(() => {
    if (!activeWindow) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeWindow]);

  // A window that was already open is re-read once a minute, quietly, so the page
  // never disagrees with the server for long — and a window the backend has since
  // closed (or extended) shows up without a reload. No spinner, no scroll jump.
  useEffect(() => {
    if (!activeWindow) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [activeWindow]);

  useEffect(() => {
    let active = true;
    // Only the first read (and an explicit retry) shows a spinner. A refresh after
    // a redemption is quiet, so the confirmation the visitor just got stays on
    // screen instead of being replaced by a loading line.
    if (!status) setLoading(true);
    setFailing(false);
    Promise.all([getPremiumStatus(user, backend), getPremiumHistory(user, backend)])
      .then(([statusResult, historyResult]) => {
        if (!active) return;
        setStatus(statusResult.status);
        setHistory(historyResult.history);
      })
      .catch(() => { if (active) setFailing(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // `status` is read only to decide about the spinner; re-running on it would
    // re-fetch on every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, backend, revision]);

  const redeem = async (count: number) => {
    setBusy(count);
    setMessage("");
    try {
      const result = await redeemReferrals(user, count, backend);
      if (result.status) setStatus(result.status);
      if (result.entry) {
        setMessage(`${formatPremiumWindow(result.entry.seconds)} premium add ho gaya. Ab full videos chalengi.`);
        onChanged?.();
      }
      setRevision((value) => value + 1);
    } catch (error) {
      const code = error instanceof AccountRequestError ? error.code : "unavailable";
      setMessage(redeemErrorMessage(code));
    } finally {
      setBusy(0);
    }
  };

  const available = status?.referrals.available ?? 0;
  const active = activeWindow;
  // What the visitor reads: the live count until the server's end date. Falls to
  // 0 (and the panel switches to "not active") the moment it runs out.
  const secondsLeft = premiumSecondsLeft(status, now);
  const open = (count: number) => redemptionSeconds(status, count);

  return (
    <section className="dashboard__section premium-panel" aria-label="Premium">
      <h2><Sparkles size={19} /> Premium</h2>
      {loading && !status ? <p className="dashboard__empty"><Loader2 className="inline w-4 h-4 animate-spin" /> Premium status load ho raha hai…</p>
        : failing ? (
          <div className="dashboard__empty">
            <p role="alert">Premium status abhi nahi aa paya.</p>
            <button type="button" className="catalog-status__retry" onClick={() => setRevision((value) => value + 1)}>Retry premium</button>
          </div>
        ) : status ? (
          <>
            {active && secondsLeft > 0 ? (
              <p className="premium-panel__state premium-panel__state--active" role="status">
                <ShieldCheck className="inline w-4 h-4" /> Premium active · {formatPremiumWindow(secondsLeft)} baaki
              </p>
            ) : active ? (
              // The countdown reached the server's end date: the window is over,
              // and the panel says so before the next status read confirms it.
              <p className="premium-panel__state" role="status">Premium window khatam ho gaya — premium videos ka sirf trailer chalega.</p>
            ) : (
              <p className="premium-panel__state" role="status">Premium active nahi hai — premium videos ka sirf trailer chalega.</p>
            )}
            <p className="account-hint">
              Referrals: {status.referrals.available} available · {status.referrals.used} used · {status.referrals.total} total
              {status.referrals.hoursEach ? ` · har referral ${status.referrals.hoursEach} ghanta` : ""}
            </p>
            {available > 0 ? (
              <div className="premium-panel__redeem">
                {[1, 2, 4].filter((count) => count <= available).map((count) => (
                  <button key={count} type="button" className="catalog-status__retry" disabled={busy > 0} onClick={() => { void redeem(count); }}>
                    {busy === count ? <Loader2 className="inline w-4 h-4 animate-spin" /> : null}
                    Use {count} referral{count > 1 ? "s" : ""}{open(count) ? ` = ${formatPremiumWindow(open(count))}` : ""}
                  </button>
                ))}
              </div>
            ) : <p className="dashboard__empty">Abhi koi referral available nahi hai. Naya referral aane par yahan redeem kar sakte hain.</p>}
            {message && <p className="account-hint" role="status">{message}</p>}
            {status.referrals.availableCodes.length > 0 && (
              <p className="account-hint">Codes: {status.referrals.availableCodes.slice(0, 4).join(", ")}</p>
            )}
          </>
        ) : null}
      {history && history.periods.length > 0 && (
        <div className="premium-panel__history">
          <h3>Premium history</h3>
          <p className="account-hint">
            Total {formatPremiumWindow(history.total.seconds)}
            {history.total.amountPaise ? ` · ₹${(history.total.amountPaise / 100).toFixed(2)}` : ""}
          </p>
          <ul>
            {history.periods.slice(0, 6).map((period) => (
              <li key={period.id || `${period.source}-${period.at}-${period.seconds}`}>
                <span>{period.source}</span>
                <span>{formatPremiumWindow(period.seconds)}</span>
                {period.amountPaise ? <span>₹{(period.amountPaise / 100).toFixed(2)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
