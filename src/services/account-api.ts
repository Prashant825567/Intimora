import type { FirebaseUser } from "./firebase";
import { primeBackendSelection } from "./api";
import { AccountRequestError, createAuthenticatedRequest } from "./auth-request.mjs";

const request = createAuthenticatedRequest({ selectBackend: primeBackendSelection, allowedBackends: __INTIMORA_AUTH_BACKENDS__ });
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[A-Za-z0-9_-]{1,80}$/;
export const referralsEnabled = __INTIMORA_SAFE_REFERRALS__;

export interface AccountProfile {
  uid: string;
  email: string;
  name: string;
  username: string;
  referralCode: string;
  likedIds: string[];
  savedIds: string[];
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
    likedIds: ids(raw.likedVideos),
    savedIds: ids(raw.savedVideos),
  };
}

export async function verifyAccount(user: FirebaseUser, backend?: string) {
  const result = await request("/api/auth/verify", { method: "POST", token: await token(user), backend });
  if (typeof result.data.exists !== "boolean") throw new AccountRequestError();
  return { exists: result.data.exists, backend: result.backend };
}

export async function getMyAccount(user: FirebaseUser, backend?: string) {
  const { data } = await request("/api/auth/me", { token: await token(user), backend });
  return profileFrom(data.user, user);
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

export async function toggleAccountVideo(user: FirebaseUser, action: "like" | "save", id: string, backend?: string) {
  if (!ID.test(id)) throw new AccountRequestError();
  const { data } = await request(`/api/videos/${id}/${action}`, { method: "POST", token: await token(user), backend });
  const key = action === "like" ? "liked" : "saved";
  const listKey = action === "like" ? "likedVideos" : "savedVideos";
  if (typeof data[key] !== "boolean" || !Array.isArray(data[listKey])) throw new AccountRequestError();
  return { active: data[key] as boolean, ids: ids(data[listKey]) };
}

function person(value: unknown): ReferralPerson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const username = text(item.username, 80);
  const referralCode = text(item.referralCode, 80);
  const referredBy = text(item.referredBy, 80);
  if (!username || !CODE.test(referralCode) || !CODE.test(referredBy)) return null;
  return { username, referralCode, referredBy, name: text(item.name, 100) || username };
}

// Only show descendants. No parent/referrer, emails, UIDs or history are rendered.
export function sanitizeReferralTree(raw: unknown, ownCode: string): ReferralTree {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AccountRequestError();
  const tree = raw as Record<string, unknown>;
  if (tree.code !== ownCode || !Array.isArray(tree.direct) || !Array.isArray(tree.level2)) throw new AccountRequestError();
  const seen = new Set([ownCode]);
  const direct: ReferralPerson[] = [];
  for (const input of tree.direct.slice(0, 5000)) {
    const item = person(input);
    if (item && item.referredBy === ownCode && !seen.has(item.referralCode)) {
      seen.add(item.referralCode);
      direct.push(item);
    }
  }
  const directCodes = new Set(direct.map((item) => item.referralCode));
  const level2: ReferralPerson[] = [];
  for (const input of tree.level2.slice(0, 5000)) {
    const item = person(input);
    if (item && directCodes.has(item.referredBy) && !seen.has(item.referralCode)) {
      seen.add(item.referralCode);
      level2.push(item);
    }
  }
  return { direct, level2 };
}

export async function getReferralTree(user: FirebaseUser, ownCode: string): Promise<ReferralTree> {
  // The current backend returns other users' private histories here. Do not
  // make the request unless its response has been fixed server-side.
  if (!referralsEnabled) throw new AccountRequestError();
  const { data } = await request("/api/user/referrals", { token: await token(user) });
  return sanitizeReferralTree(data.tree, ownCode);
}
