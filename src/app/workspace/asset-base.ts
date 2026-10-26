/**
 * Base URL that relative asset paths (the bundled fonts, sample photos) resolve against.
 *
 * The standalone application is served from its own origin, so the document base is right. The
 * embeddable admin element lives on somebody else's page: its bundled files sit next to its
 * script, so `main.admin.ts` points this at the script's directory instead.
 */
let base: string | null = null;

export function setAssetBaseUrl(url: string | null): void {
  base = url;
}

export function assetBaseUrl(): string {
  return base ?? document.baseURI;
}
