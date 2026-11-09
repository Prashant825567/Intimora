import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bookmark, Check, Copy, Heart, Loader2, LogOut, ShieldCheck, Users } from "lucide-react";
import type { Video } from "../data/mockVideos";
import type { AccountController } from "../hooks/useAccount";
import { getReferralTree, referralsEnabled } from "../services/account-api";
import type { ReferralPerson, ReferralTree } from "../services/account-api";
import { AccountRequestError } from "../services/auth-request.mjs";

export type AccountPage = "login" | "profile" | "referral" | "dashboard";

interface Props {
  page: AccountPage;
  account: AccountController;
  videos: Video[];
  catalogLoading: boolean;
  catalogUnavailable: boolean;
  onRetryCatalog: () => void;
  renderVideos: (videos: Video[]) => ReactNode;
  onPage: (page: AccountPage) => void;
  onBack: () => void;
}

const validName = (value: string) => value.trim().length >= 1 && value.trim().length <= 100;
const validUsername = (value: string) => /^[A-Za-z0-9_]{3,30}$/.test(value.trim());

function Person({ person, level }: { person: ReferralPerson; level: 1 | 2 }) {
  return (
    <div className={`referral-person referral-person--level-${level}`}>
      <span className="referral-person__avatar" aria-hidden="true">{person.name.charAt(0).toUpperCase() || "U"}</span>
      <div className="min-w-0">
        <strong>{person.name}</strong>
        <span>@{person.username}</span>
      </div>
      <span className="referral-person__level">Level {level}</span>
    </div>
  );
}

export default function AccountPages({ page, account, videos, catalogLoading, catalogUnavailable, onRetryCatalog, renderVideos, onPage, onBack }: Props) {
  const [name, setName] = useState(account.identity?.displayName || "");
  const [username, setUsername] = useState("");
  const [referral, setReferral] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const finishInFlight = useRef(false);
  const [copied, setCopied] = useState(false);
  const [tree, setTree] = useState<ReferralTree | null>(null);
  const [treeError, setTreeError] = useState(false);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeRevision, setTreeRevision] = useState(0);

  useEffect(() => {
    setName(account.identity?.displayName || "");
    setUsername("");
    setReferral("");
    setFormError("");
  }, [account.identity?.uid]);

  const ownCode = account.profile?.referralCode;
  const profileBackend = account.profile?.backendBase;
  const identity = account.identity;
  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setTreeError(false);
    if (page !== "dashboard" || !identity || !ownCode || !referralsEnabled) {
      setTreeLoading(false);
      return;
    }
    setTreeLoading(true);
    getReferralTree(identity, ownCode, profileBackend).then((result) => {
      if (!cancelled) setTree(result);
    }).catch(() => {
      if (!cancelled) setTreeError(true);
    }).finally(() => { if (!cancelled) setTreeLoading(false); });
    return () => { cancelled = true; };
  }, [page, identity, ownCode, profileBackend, treeRevision]);

  const submitProfile = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    if (!validName(name)) return setFormError("Please enter your name.");
    if (!validUsername(username)) return setFormError("Username must be 3–30 letters, numbers, or underscores.");
    onPage("referral");
  };

  const finishProfile = async (code: string) => {
    if (finishInFlight.current) return;
    if (!validName(name) || !validUsername(username)) {
      setFormError("Please complete your name and username first.");
      onPage("profile");
      return;
    }
    finishInFlight.current = true;
    setBusy(true);
    setFormError("");
    try {
      await account.complete({ name: name.trim(), username: username.trim(), referralCode: code.trim() });
    } catch (error) {
      if (error instanceof AccountRequestError && error.code === "username_taken") {
        setFormError("That username is already taken. Please choose another.");
        onPage("profile");
      } else if (error instanceof AccountRequestError && error.code === "invalid_referral") {
        setFormError("That referral code is invalid. Check it or skip this step.");
      } else if (error instanceof AccountRequestError && error.code === "unconfirmed") {
        setFormError("We couldn’t confirm your account was saved. Please try again. A referral code is not required.");
      } else {
        setFormError("Could not complete your profile right now. Please try again.");
      }
    } finally {
      finishInFlight.current = false;
      setBusy(false);
    }
  };

  const signIn = async () => {
    setFormError("");
    try { await account.login(); }
    catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      setFormError(code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request"
        ? "Sign-in was canceled. You can try again."
        : code === "auth/popup-blocked" ? "Please allow pop-ups and try again."
          : "Sign-in is temporarily unavailable. Please try again.");
    }
  };

  const copyCode = async () => {
    if (!ownCode) return;
    try { await navigator.clipboard.writeText(ownCode); setCopied(true); }
    catch { setCopied(false); }
  };

  if (account.status === "checking") {
    return <section className="account-loading" role="status"><Loader2 className="animate-spin w-5 h-5" /> Checking your account…</section>;
  }
  if (account.status === "error") {
    return <section className="account-shell"><div className="account-card"><h1>Account unavailable</h1><p>We couldn’t load your account. Please try again.</p><button className="account-primary" onClick={account.retry}>Try again</button><button className="account-secondary" onClick={() => { void account.logout().catch(() => setFormError("Could not sign out. Please try again.")); }}>Sign out</button><button className="account-secondary" onClick={onBack}>Back to browsing</button>{formError && <p className="account-error" role="alert">{formError}</p>}</div></section>;
  }

  if (page === "login") {
    return (
      <section className="account-shell">
        <div className="account-card account-card--auth">
          <button type="button" className="account-back" onClick={onBack}><ArrowLeft size={16} /> Back to browsing</button>
          <img src="/logo.svg" className="account-mark" alt="" />
          <p className="account-eyebrow">WELCOME TO INTIMORA</p>
          <h1>Sign in to your account</h1>
          <p>Keep your favorite videos and your referral network together, wherever you watch.</p>
          <button type="button" className="google-signin" onClick={signIn} disabled={account.signingIn}>
            {account.signingIn ? <Loader2 className="animate-spin" size={20} /> : <span className="google-signin__mark" aria-hidden="true">G</span>}
            {account.signingIn ? "Signing in…" : "Sign in with Google"}
          </button>
          {formError && <p className="account-error" role="alert">{formError}</p>}
          <p className="account-privacy"><ShieldCheck size={16} /> Your Google password is never shared with Intimora.</p>
        </div>
      </section>
    );
  }

  if (page === "profile") {
    return (
      <section className="account-shell">
        <form className="account-card" onSubmit={submitProfile}>
          <button type="button" className="account-back" onClick={() => { void account.logout().catch(() => setFormError("Could not sign out. Please try again.")); }}><ArrowLeft size={16} /> Sign out</button>
          <p className="account-eyebrow">STEP 1 OF 2</p>
          <h1>Complete your profile</h1>
          <p>Choose a name and a unique username for your account.</p>
          <label className="account-field">Name<input autoComplete="name" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" required /></label>
          <label className="account-field">Username<input autoComplete="username" maxLength={30} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="your_username" required /></label>
          <p className="account-hint">3–30 letters, numbers, or underscores. Availability is checked when you finish.</p>
          {formError && <p className="account-error" role="alert">{formError}</p>}
          <button className="account-primary" type="submit">Continue <ArrowRight size={17} /></button>
        </form>
      </section>
    );
  }

  if (page === "referral") {
    return (
      <section className="account-shell">
        <form className="account-card" onSubmit={(event) => { event.preventDefault(); void finishProfile(referral); }}>
          <button type="button" className="account-back" onClick={() => { setFormError(""); onPage("profile"); }}><ArrowLeft size={16} /> Back to profile</button>
          <p className="account-eyebrow">STEP 2 OF 2 · OPTIONAL</p>
          <h1>Have a referral code?</h1>
          <p>Enter the code from the person who invited you, or skip this step.</p>
          <label className="account-field">Referral code<input autoComplete="off" maxLength={80} value={referral} onChange={(event) => setReferral(event.target.value)} placeholder="REF-ABC123" /></label>
          {formError && <p className="account-error" role="alert">{formError}</p>}
          <button className="account-primary" type="submit" disabled={busy}>{busy ? "Creating account…" : "Finish profile"} <ArrowRight size={17} /></button>
          <button className="account-secondary" type="button" onClick={() => { void finishProfile(""); }} disabled={busy}>Skip for now</button>
        </form>
      </section>
    );
  }

  const profile = account.profile;
  if (!profile || !identity) return null;
  const videoById = new Map(videos.map((video) => [video.id, video]));
  const liked = profile.likedIds.flatMap((id) => videoById.has(id) ? [videoById.get(id)!] : []);
  const saved = profile.savedIds.flatMap((id) => videoById.has(id) ? [videoById.get(id)!] : []);
  const missingLiked = profile.likedIds.length - liked.length;
  const missingSaved = profile.savedIds.length - saved.length;

  return (
    <section className="dashboard" aria-label="Your dashboard">
      <div className="dashboard__header">
        <div className="dashboard__identity">
          <div className="dashboard__avatar" aria-hidden="true">{profile.name.charAt(0).toUpperCase()}</div>
          <div className="min-w-0"><p className="account-eyebrow">YOUR ACCOUNT</p><h1>{profile.name}</h1><p>@{profile.username}{profile.email ? ` · ${profile.email}` : ""}</p></div>
        </div>
        <button type="button" className="dashboard__logout" onClick={() => { void account.logout().catch(() => setFormError("Could not sign out. Please try again.")); }}><LogOut size={16} /> Sign out</button>
      </div>
      {formError && <p className="account-error" role="alert">{formError}</p>}
      <div className="dashboard__code">
        <div><span>Your referral code</span><strong>{profile.referralCode}</strong><small>Share this code with someone you invite.</small></div>
        <button type="button" onClick={copyCode} aria-label="Copy referral code">{copied ? <Check size={17} /> : <Copy size={17} />} {copied ? "Copied" : "Copy"}</button>
      </div>
      {catalogUnavailable && (profile.likedIds.length > 0 || profile.savedIds.length > 0) && <div className="catalog-status" role="status"><span>We could not check the full video catalog.</span><button type="button" className="catalog-status__retry" onClick={onRetryCatalog}>Retry</button></div>}
      <section className="dashboard__section" aria-label="Liked videos">
        <h2><Heart size={19} /> Liked videos <span>{profile.likedIds.length}</span></h2>
        {liked.length ? renderVideos(liked) : <p className="dashboard__empty">{!profile.likedIds.length ? "No liked videos yet." : catalogLoading ? "Loading videos…" : "Liked videos are currently unavailable."}</p>}
        {!catalogLoading && liked.length > 0 && missingLiked > 0 && <p className="account-hint">Some liked videos are currently unavailable.</p>}
      </section>
      <section className="dashboard__section" aria-label="Saved videos">
        <h2><Bookmark size={19} /> Saved videos <span>{profile.savedIds.length}</span></h2>
        {saved.length ? renderVideos(saved) : <p className="dashboard__empty">{!profile.savedIds.length ? "No saved videos yet." : catalogLoading ? "Loading videos…" : "Saved videos are currently unavailable."}</p>}
        {!catalogLoading && saved.length > 0 && missingSaved > 0 && <p className="account-hint">Some saved videos are currently unavailable.</p>}
      </section>
      <section className="dashboard__section" aria-label="Referral network">
        <h2><Users size={19} /> Your referral network</h2>
        {referralsEnabled && !treeLoading && !treeError && tree && <button type="button" className="catalog-status__retry" onClick={() => setTreeRevision((revision) => revision + 1)}>Refresh referrals</button>}
        {!referralsEnabled ? <p className="dashboard__empty">Referral details are temporarily unavailable while privacy protection is updated.</p>
          : treeLoading ? <p className="dashboard__empty">Loading referrals…</p>
            : treeError ? <div className="dashboard__empty"><p role="alert">Could not load referrals right now.</p><button type="button" className="catalog-status__retry" onClick={() => setTreeRevision((revision) => revision + 1)}>Retry referrals</button></div>
              : tree?.direct.length ? <>
                <p className="account-hint">Direct: {tree.direct.length} · Level 2: {tree.level2.length}</p>
                <div className="referral-tree">{tree.direct.map((item) => (
                  <div key={item.referralCode}>
                    <Person person={item} level={1} />
                    {tree.level2.filter((child) => child.referredBy === item.referralCode).map((child) => <Person key={child.referralCode} person={child} level={2} />)}
                  </div>
                ))}</div>
              </> : <p className="dashboard__empty">No referrals yet. Share your code to invite someone.</p>}
      </section>
    </section>
  );
}
