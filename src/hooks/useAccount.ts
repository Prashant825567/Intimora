import { useCallback, useEffect, useRef, useState } from "react";
import type { FirebaseUser } from "../services/firebase";
import { signInWithGoogle, signOutGoogle, watchFirebaseUser } from "../services/firebase";
import { createAccount, getMyAccount, toggleAccountVideo, verifyAccount } from "../services/account-api";
import type { AccountProfile } from "../services/account-api";
import { AccountRequestError } from "../services/auth-request.mjs";
import type { Video } from "../data/mockVideos";

type AccountStatus = "checking" | "guest" | "needs-profile" | "ready" | "error";
interface AccountState { status: AccountStatus; identity: FirebaseUser | null; profile: AccountProfile | null }

export function useAccount(enabled: boolean) {
  const [state, setState] = useState<AccountState>({ status: "checking", identity: null, profile: null });
  const [signingIn, setSigningIn] = useState(false);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const currentUser = useRef<FirebaseUser | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const pendingRef = useRef(new Set<string>());
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());

  const hydrate = useCallback(async (user: FirebaseUser, sequence: number) => {
    const current = () => mounted.current && generation.current === sequence && currentUser.current?.uid === user.uid;
    try {
      const exists = await verifyAccount(user);
      if (!current()) return;
      if (!exists) {
        setState({ status: "needs-profile", identity: user, profile: null });
        return;
      }
      const profile = await getMyAccount(user);
      if (current()) setState({ status: "ready", identity: user, profile });
    } catch {
      if (current()) setState({ status: "error", identity: user, profile: null });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    const unsubscribe = watchFirebaseUser((user) => {
      const sequence = ++generation.current;
      currentUser.current = user;
      pendingRef.current.clear();
      setPending(new Set());
      if (!user) {
        setState({ status: "guest", identity: null, profile: null });
      } else {
        setState({ status: "checking", identity: user, profile: null });
        void hydrate(user, sequence);
      }
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      unsubscribe();
    };
  }, [enabled, hydrate]);

  const login = useCallback(async () => {
    if (signingIn) return;
    setSigningIn(true);
    try { await signInWithGoogle(); }
    finally { if (mounted.current) setSigningIn(false); }
  }, [signingIn]);

  const logout = useCallback(async () => {
    await signOutGoogle();
  }, []);

  const retry = useCallback(() => {
    const user = currentUser.current;
    if (!user) return;
    const sequence = ++generation.current;
    setState({ status: "checking", identity: user, profile: null });
    void hydrate(user, sequence);
  }, [hydrate]);

  const complete = useCallback(async (input: { name: string; username: string; referralCode?: string }) => {
    const user = currentUser.current;
    const sequence = generation.current;
    if (!user || state.status !== "needs-profile") throw new AccountRequestError();
    try {
      await createAccount(user, input);
    } catch (error) {
      // A previous registration may have succeeded despite a lost response.
      if (!(error instanceof AccountRequestError) || error.code !== "already_exists") throw error;
    }
    if (!mounted.current || currentUser.current?.uid !== user.uid || generation.current !== sequence) return;
    setState({ status: "checking", identity: user, profile: null });
    await hydrate(user, sequence);
  }, [hydrate, state.status]);

  const toggle = useCallback(async (action: "like" | "save", video: Video) => {
    const user = currentUser.current;
    const sequence = generation.current;
    if (!user || state.status !== "ready" || !state.profile) throw new AccountRequestError();
    const key = `${action}:${video.id}`;
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    const stillCurrent = () => mounted.current && generation.current === sequence && currentUser.current?.uid === user.uid;
    const operation = mutationQueue.current.then(async () => {
      if (!stillCurrent()) throw new AccountRequestError();
      const result = await toggleAccountVideo(user, action, video.id, video.backendBase);
      if (!stillCurrent()) return;
      setState((previous) => {
        if (previous.status !== "ready" || previous.profile?.uid !== user.uid) return previous;
        const field = action === "like" ? "likedIds" : "savedIds";
        // Use the server's latest list, while keeping the toggled ID accurate
        // even when an unusually large response had to be capped locally.
        const next = new Set(result.ids);
        if (result.active) next.add(video.id); else next.delete(video.id);
        return { ...previous, profile: { ...previous.profile, [field]: [...next] } };
      });
    });
    mutationQueue.current = operation.catch(() => {});
    try { await operation; }
    finally {
      if (stillCurrent()) {
        pendingRef.current.delete(key);
        setPending(new Set(pendingRef.current));
      }
    }
  }, [state.profile, state.status]);

  return { ...state, signingIn, pending, login, logout, retry, complete, toggle };
}

export type AccountController = ReturnType<typeof useAccount>;
