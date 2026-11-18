export function byteStreamUrl(backend: string, id: string): string;
export function byteStreamPath(id: string): string;
export function looksLikeMediaFile(url: URL): boolean;
export function playbackSources(
  video: { cdnUrl?: string; streamUrl?: string; bestfile?: { download_link?: string } } | null | undefined,
  backend: string,
  id: string,
): { videoUrl: string; fallbackVideoUrl?: string };
