import { getApps, initializeApp } from "@firebase/app";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "@firebase/auth";
import type { User } from "@firebase/auth";
import { firebaseWebConfig } from "./firebase-config";

export type FirebaseUser = Pick<User, "uid" | "email" | "displayName" | "getIdToken">;

const app = getApps().find((item) => item.name === "intimora-web") ?? initializeApp(firebaseWebConfig, "intimora-web");

// Initialize Auth only after the age gate. On some browsers the SDK can
// proactively open its auth iframe, even before a popup is requested.
export function watchFirebaseUser(listener: (user: FirebaseUser | null) => void) {
  return onAuthStateChanged(getAuth(app), listener);
}

export async function signInWithGoogle() {
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  // Always show the Google account chooser, including returning visitors.
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(auth, provider);
}

export async function signOutGoogle() {
  await signOut(getAuth(app));
}
