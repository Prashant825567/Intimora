export const VAST_TAG_HOSTS: readonly string[];

export function vastTagUrl(value: string, options?: { hosts?: readonly string[] }): string | null;
