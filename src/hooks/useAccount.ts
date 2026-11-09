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
  // Pending intent is visual feedback only; the stored profile stays confirmed
  // until the server responds and is restored automatically on failure.
  const [optimistic, setOptimistic] = useState<Map<string, boolean>>(() => new Map());
  const currentUser = useRef<FirebaseUser | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const pendingRef = useRef(new Set<string>());
  const optimisticRef = useRef(new Map<string, boolean>());
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());

  const hydrate = useCallback(async (user: FirebaseUser, sequence: number) => {
    const current = () => mounted.current && generation.current === sequence && currentUser.current?.uid === user.uid;
    try {
      const { exists, backend } = await verifyAccount(user);
      if (!current()) return;
      if (!exists) {
        setState({ status: "needs-profile", identity: user, profile: null });
        return;
      }
      const profile = await getMyAccount(user, backend);
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
      optimisticRef.current.clear();
      setPending(new Set());
      setOptimistic(new Map());
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
    const current = () => mounted.current && generation.current === sequence && currentUser.current?.uid === user.uid;
    const backend = await createAccount(user, input);
    if (!current()) return;
    setState({ status: "checking", identity: user, profile: null });
    try {
      // Account storage may take a moment to become readable. Retry only a
      // missing record, on the same backend, without submitting another write.
      const delays = [250, 750];
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        const { exists } = await verifyAccount(user, backend);
        if (!current()) return;
        if (exists) {
          const profile = await getMyAccount(user, backend);
          if (current()) setState({ status: "ready", identity: user, profile });
          return;
        }
        if (attempt < delays.length) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          if (!current()) return;
        }
      }
      throw new AccountRequestError("unconfirmed");
    } catch {
      if (!current()) return;
      // Do not pretend a successful POST means the account was persisted.
      // Preserve the onboarding form and show an actionable error instead of
      // silently returning to the referral step.
      setState({ status: "needs-profile", identity: user, profile: null });
      throw new AccountRequestError("unconfirmed");
    }
  }, [state.status]);

  const toggle = useCallback(async (action: "like" | "save", video: Video) => {
    const user = currentUser.current;
    const sequence = generation.current;
    if (!user || state.status !== "ready" || !state.profile) throw new AccountRequestError();
    const key = `${action}:${video.id}`;
    if (pendingRef.current.has(key)) return;
    const field = action === "like" ? "likedIds" : "savedIds";
    const desired = !state.profile[field].includes(video.id);
    pendingRef.current.add(key);
    optimisticRef.current.set(key, desired);
    setPending(new Set(pendingRef.current));
    setOptimistic(new Map(optimisticRef.current));
    const stillCurrent = () => mounted.current && generation.current === sequence && currentUser.current?.uid === user.uid;
    // The legacy backend rewrites one whole user record. Keep this tab's writes
    // serialized until the backend has atomic per-user/video operations.
    const operation = mutationQueue.current.then(async () => {
      if (!stillCurrent()) return;
      const result = await toggleAccountVideo(user, action, video.id, desired, video.backendBase);
      if (!stillCurrent()) return;
      setState((previous) => {
        if (previous.status !== "ready" || previous.profile?.uid !== user.uid) return previous;
        // A newer backend can return just the changed state; older backends
        // return the complete list. Keep this ID correct in either format.
        const next = new Set(result.ids ?? previous.profile[field]);
        if (result.active) next.add(video.id); else next.delete(video.id);
        return { ...previous, profile: { ...previous.profile, [field]: [...next] } };
      });
      return result;
    });
    mutationQueue.current = operation.then(() => {}, () => {});
    try { return await operation; }
    catch (error) {
      if (stillCurrent()) throw error;
    } finally {
      if (stillCurrent()) {
        pendingRef.current.delete(key);
        optimisticRef.current.delete(key);
        setPending(new Set(pendingRef.current));
        setOptimistic(new Map(optimisticRef.current));
      }
    }
  }, [state.profile, state.status]);

  const isLiked = (id: string) => optimistic.get(`like:${id}`) ?? (state.profile?.likedIds.includes(id) ?? false);
  const isSaved = (id: string) => optimistic.get(`save:${id}`) ?? (state.profile?.savedIds.includes(id) ?? false);
  return { ...state, signingIn, pending, isLiked, isSaved, login, logout, retry, complete, toggle };
}

export type AccountController = ReturnType<typeof useAccount>;
