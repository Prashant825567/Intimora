import type { BrowseView } from "../types/navigation";

export const BROWSE_PATHS: Readonly<Record<BrowseView, string>>;
export function browseViewFromPath(pathname: string): BrowseView | null;
export function accountPageFromPath(pathname: string): "login" | "profile" | "referral" | "dashboard" | null;
export function watchIdFromPath(pathname: string): string | null;
export function watchPathFor(id: string): string | null;
export function isSearchPath(pathname: string): boolean;
export function searchTermFromLocation(pathname: string, search: string): string | null;
export function searchPathFor(query: string): string;
export function isAppPath(pathname: string): boolean;
