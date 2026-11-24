import type { FirebaseUser } from "./firebase";
import { primeBackendSelection, resolveBackendTarget } from "./api";
import { AccountRequestError, createAuthenticatedRequest } from "./auth-request.mjs";
import { ANIME_ID_PREFIX } from "./anime-api.mjs";
import { readLikeCount } from "./like-counts.mjs";
import { parsePremiumEntry, parsePremiumPeriods, parsePremiumStatus, redeemErrorCode } from "./premium.mjs";
import { PHP_ORIGIN_OVERRIDE } from "../config/php-backend.mjs";
import { activeTarget, requestPhpUnlock } from "./php-session.mjs";

const request = createAuthenticatedRequest({
  selectBackend: primeBackendSelection,
  // A token is only ever sent to a trusted origin. The build-time allowlist covers
  // the known backends; the host the load balancer names is trusted as well when
  // it flags it as a PHP host (it cannot be known at build time).
  allowedBackends: [...new Set([...__INTIMORA_AUTH_BACKENDS__, PHP_ORIGIN_OVERRIDE].filter(Boolean))],
  trustedPhpBackend: () => activeTarget().backend,
  resolveTarget: resolveBackendTarget,
  // The host's browser check answers with HTML instead of JSON until its session
  // cookie exists; that is the one case worth the one-time unlock navigation.
  requestUnlock: requestPhpUnlock,
});
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[A-Za-z0-9_-]{1,80}$/;
export const referralsEnabled = __INTIMORA_SAFE_REFERRALS__;

// An external (anime) title the account keeps beside our own catalogue ids. The
// backend stores it in the same `likedVideos`/`savedVideos` list; its `anime-title`
// and `anime-thumbnail` metadata is all that is needed to draw its card.
export interface SavedAnime {
  id: string;
  title: string;
  thumbnail: string;
}

export interface AccountProfile {
  uid: string;
  email: string;
  name: string;
  username: string;
  referralCode: string;
  likedIds: string[];
  savedIds: string[];
  // Only the entries our own catalogue cannot draw: namespaced `anime-…` ids.
  likedAnime: SavedAnime[];
  savedAnime: SavedAnime[];
  // The trusted backend that verified and returned this account.
  backendBase?: string;
}

export interface ReferralPerson {
  name: string;
  username: string;
  referralCode: string;
  referredBy: string;
}
export interface ReferralTree { direct: ReferralPerson[]; level2: ReferralPerson[] }

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/https?:\/\/[^\s<>"']+/gi, "[link removed]")
    .replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
// A stored anime entry needs a title and an https poster to be worth drawing; the
// id must carry the prefix that says it is not one of ours.
function animeEntry(value: unknown): SavedAnime | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = text(raw["anime-title"], 140);
  const thumbnail = typeof raw["anime-thumbnail"] === "string" ? raw["anime-thumbnail"] : "";
  if (!ID.test(id) || !id.startsWith(ANIME_ID_PREFIX) || !title) return null;
  let href = "";
  try {
    const url = new URL(thumbnail);
    if (url.protocol === "https:" && !url.username && !url.password) href = url.href;
  } catch { return null; }
  if (!/\.(?:jpe?g|png|webp)(?:\?[^\s]*)?$/i.test(href)) return null;
  return { id, title, thumbnail: href };
}
function animeEntries(value: unknown): SavedAnime[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: SavedAnime[] = [];
  for (const item of value.slice(0, 5000)) {
    const entry = animeEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 5000).filter((id): id is string => typeof id === "string" && ID.test(id)))];
}
async function token(user: FirebaseUser) {
  try { return await user.getIdToken(); }
  catch { throw new AccountRequestError("unauthorized"); }
}

function profileFrom(input: unknown, user: FirebaseUser): AccountProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AccountRequestError();
  const raw = input as Record<string, unknown>;
  if (typeof raw.uid === "string" && raw.uid !== user.uid) throw new AccountRequestError();
  const username = text(raw.username, 80);
  const code = text(raw.referralCode, 80);
  if (!username || !CODE.test(code)) throw new AccountRequestError();
  return {
    uid: user.uid,
    email: text(user.email, 254),
    name: text(raw.name, 100) || text(user.displayName, 100) || username,
    username,
    referralCode: code,
    // An anime entry is drawn from its metadata, not from an id alone, so the two
    // lists are split here: catalogue ids stay in `likedIds`/`savedIds`.
    likedIds: ids(raw.likedVideos).filter((id) => !id.startsWith(ANIME_ID_PREFIX)),
    savedIds: ids(raw.savedVideos).filter((id) => !id.startsWith(ANIME_ID_PREFIX)),
    likedAnime: animeEntries(raw.likedAnime ?? raw.likedVideos),
    savedAnime: animeEntries(raw.savedAnime ?? raw.savedVideos),
  };
}

export async function verifyAccount(user: FirebaseUser, backend?: string) {
  const result = await request("/api/auth/verify", { method: "POST", token: await token(user), backend });
  if (typeof result.data.exists !== "boolean") throw new AccountRequestError();
  return { exists: result.data.exists, backend: result.backend };
}

export async function getMyAccount(user: FirebaseUser, backend?: string) {
  const result = await request("/api/auth/me", { token: await token(user), backend });
  return { ...profileFrom(result.data.user, user), backendBase: result.backend };
}

export async function createAccount(user: FirebaseUser, input: { name: string; username: string; referralCode?: string }) {
  // Keep the write and its confirmation on the same selected backend, even if
  // discovery expires while the user is filling in the form. The request
  // helper still validates this origin against the trusted allowlist.
  const backend = await primeBackendSelection();
  try {
    await request("/api/auth/profile", {
      method: "POST", token: await token(user), backend,
      body: { name: input.name, username: input.username, referralCode: input.referralCode?.trim() || "" },
    });
  } catch (error) {
    // A previous registration may have succeeded despite a lost response.
    if (!(error instanceof AccountRequestError) || error.code !== "already_exists") throw error;
  }
  return backend;
}

export async function toggleAccountVideo(
  user: FirebaseUser,
  action: "like" | "save",
  id: string,
  active: boolean,
  backend?: string,
  // Only for an external (anime) title: the two metadata keys the account stores
  // beside the entry, in the same `likedVideos`/`savedVideos` list.
  meta?: Record<string, string>,
) {
  if (!ID.test(id)) throw new AccountRequestError();
  // Current backends ignore the body and toggle. Upgraded backends should set
  // this desired state idempotently, so a repeated request cannot undo a like.
  const body: Record<string, unknown> = { active };
  if (meta && id.startsWith(ANIME_ID_PREFIX)) {
    for (const key of ["anime-title", "anime-thumbnail"] as const) {
      if (typeof meta[key] === "string" && meta[key]) body[key] = meta[key];
    }
  }
  const { data } = await request(`/api/videos/${id}/${action}`, { method: "POST", token: await token(user), backend, body });
  const key = action === "like" ? "liked" : "saved";
  const listKey = action === "like" ? "likedVideos" : "savedVideos";
  if (typeof data[key] !== "boolean" || (data[listKey] !== undefined && !Array.isArray(data[listKey]))) throw new AccountRequestError();
  const list = data[listKey];
  return {
    active: data[key] as boolean,
    // The list as the backend now holds it. Every id in it is kept — including an
    // `anime-…` one, which is what the caller filters on.
    ids: list === undefined ? undefined : ids(list),
    // The anime entries the same answer carries, when it sends them.
    anime: list === undefined ? undefined : animeEntries(list),
    count: action === "like" ? readLikeCount(id, data) : null,
  };
}

// Rebuilds a person from scratch, so private fields a backend may still send
// (email, UID, avatar, liked/saved lists, timestamps) can never reach the DOM.
function person(value: unknown, fallbackReferredBy = ""): ReferralPerson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const username = text(item.username, 80);
  const referralCode = text(item.referralCode, 80);
  // Older backends omit `referredBy` on direct descendants; their parent is
  // implied by the request itself, so fall back to the owner's own code.
  const referredBy = text(item.referredBy, 80) || fallbackReferredBy;
  if (!username || !CODE.test(referralCode) || !CODE.test(referredBy)) return null;
  return { username, referralCode, referredBy, name: text(item.name, 100) || username };
}

// Only show descendants. No parent/referrer, emails, UIDs or history are rendered.
export function sanitizeReferralTree(raw: unknown, ownCode: string): ReferralTree {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AccountRequestError();
  const tree = raw as Record<string, unknown>;
  if (tree.code !== ownCode || !Array.isArray(tree.direct)) throw new AccountRequestError();
  const level2Raw = Array.isArray(tree.level2) ? tree.level2 : [];
  const seen = new Set([ownCode]);
  const direct: ReferralPerson[] = [];
  for (const input of tree.direct.slice(0, 5000)) {
    const item = person(input, ownCode);
    if (item && item.referredBy === ownCode && !seen.has(item.referralCode)) {
      seen.add(item.referralCode);
      direct.push(item);
    }
  }
  const directCodes = new Set(direct.map((item) => item.referralCode));
  const level2: ReferralPerson[] = [];
  for (const input of level2Raw.slice(0, 5000)) {
    const item = person(input);
    if (item && directCodes.has(item.referredBy) && !seen.has(item.referralCode)) {
      seen.add(item.referralCode);
      level2.push(item);
    }
  }
  return { direct, level2 };
}

// Premium is a window the backend opens and closes. The app asks for its status
// (a GET, or a POST on a PHP host — the shared request helper picks) and shows
// exactly what came back; nothing here decides entitlement.
export async function getPremiumStatus(user: FirebaseUser, backend?: string) {
  const result = await request("/api/premium/status", { token: await token(user), backend });
  const status = parsePremiumStatus(result.data);
  if (!status) throw new AccountRequestError();
  // Stamped here, at the one place an answer arrives: the countdown needs to know
  // how long ago the server's clock was read.
  return { status: { ...status, receivedAt: Date.now() }, backend: result.backend };
}

export async function getPremiumHistory(user: FirebaseUser, backend?: string) {
  const result = await request("/api/premium/history", { token: await token(user), backend });
  return { history: parsePremiumPeriods(result.data), backend: result.backend };
}

// One referral redeems only once, and the backend refuses a count it cannot
// cover — so the refusal is passed up by code, never as the host's own sentence.
export async function redeemReferrals(user: FirebaseUser, count: number, backend?: string) {
  const n = Number.isInteger(count) && count > 0 && count <= 50 ? count : 0;
  if (!n) throw new AccountRequestError("too_few");
  try {
    const result = await request("/api/premium/redeem", { method: "POST", token: await token(user), backend, body: { count: n } });
    return { entry: parsePremiumEntry(result.data), status: parsePremiumEntry(result.data)?.status ?? null, backend: result.backend };
  } catch (error) {
    if (error instanceof AccountRequestError) throw new AccountRequestError(redeemErrorCode(error.code));
    throw error;
  }
}

export async function getReferralTree(user: FirebaseUser, ownCode: string, backend?: string): Promise<ReferralTree> {
  // The response is rebuilt field by field, so private data a backend still
  // sends can never be rendered. `INTIMORA_PUBLIC_SAFE_REFERRALS=0` turns the
  // whole request off for a backend that has not been fixed yet.
  if (!referralsEnabled) throw new AccountRequestError();
  const { data } = await request("/api/user/referrals", { token: await token(user), backend });
  return sanitizeReferralTree(data.tree, ownCode);
}
