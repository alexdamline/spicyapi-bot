export class TooLargeError extends Error {
  override name = "TooLargeError";
  constructor(readonly bytes: number | undefined, readonly limit: number) {
    super(`file is larger than ${limit} bytes`);
  }
}

/**
 * Downloads a file into memory, refusing anything above `maxBytes` before and while reading.
 * Never pass SpicyAPI or chat tokens in headers here: result links are self-authorising.
 */
export async function fetchBytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw new TooLargeError(declared, maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError(undefined, maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: (response.headers.get("content-type") ?? "").split(";")[0]!.trim() };
}

export const MB = 1024 * 1024;

export function formatMb(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** File name for a result, from its MIME type. */
export function resultFileName(mime: string | undefined, base: string): string {
  const extension = mime?.includes("png")
    ? "png"
    : mime?.includes("webp")
      ? "webp"
      : mime?.includes("jpeg") || mime?.includes("jpg")
        ? "jpg"
        : mime?.includes("webm")
          ? "webm"
          : mime?.startsWith("video/")
            ? "mp4"
            : mime?.startsWith("image/")
              ? "png"
              : "bin";
  return `${base}.${extension}`;
}

/** Task IDs the bot prints in captions ("task job_abc123"), so a reply can point back at a result. */
export function taskIdFromText(text: string | undefined | null): string | undefined {
  const match = /\btask ([A-Za-z0-9_-]{6,80})\b/.exec(text ?? "");
  return match?.[1];
}
