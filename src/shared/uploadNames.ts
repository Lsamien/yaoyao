/** Recover UTF-8 upload names that older multipart parsing decoded as Latin-1. */
export function normalizeUploadName(name: string): string {
  // Leave Unicode names and ordinary Latin-1 names alone unless every byte
  // forms valid UTF-8. Fatal decoding avoids replacing data we cannot recover.
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Uint8Array.from(name, character => character.charCodeAt(0)))
  } catch {
    return name
  }
}
