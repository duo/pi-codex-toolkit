/**
 * Synchronous, destructive, tail-capped UTF-8 preview buffer shared by the
 * Shell and Code Mode managers, and the code-point-safe head helper every
 * bounded Toolkit text share uses. This is the preview side only: cumulative
 * capture before preview loss lives in `execution-output.ts`, and callers keep
 * their own cap validation and capture-before-append ordering.
 *
 * - `append` keeps at most `capBytes` of the newest text, dropping the oldest
 *   whole code points; any drop sets a sticky `dropped` flag.
 * - `markDropped` records producer-side loss that never reached the buffer.
 * - `drain` returns leading whole code points within `maxBytes` in FIFO order,
 *   reports `clipped` when text remains, and resets `dropped` on every call.
 * - `takeLeadingCodePoints` is that head walk on its own, for callers that
 *   bound one string rather than a stream.
 */

/**
 * The longest prefix of whole code points whose size, in UTF-8 bytes or UTF-16
 * units, fits `limit`, with that prefix's size in the same unit. A code point
 * that would straddle `limit` is left out whole, so the result never ends in a
 * lone surrogate; a caller that marks truncation counts the marker against its
 * own bound before calling.
 */
export function takeLeadingCodePoints(
  text: string,
  limit: number,
  unit: "utf8" | "utf16" = "utf8",
): { text: string; size: number } {
  let size = 0;
  let index = 0;
  for (const codePoint of text) {
    const cost =
      unit === "utf8" ? Buffer.byteLength(codePoint, "utf8") : codePoint.length;
    if (size + cost > limit) break;
    size += cost;
    index += codePoint.length;
  }
  return { text: text.slice(0, index), size };
}

export class BoundedTextBuffer {
  private text = "";
  private bytes = 0;
  private droppedFlag = false;

  constructor(private readonly capBytes: number) {}

  get hasBytes(): boolean {
    return this.bytes > 0;
  }

  get byteLength(): number {
    return this.bytes;
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.text += chunk;
    this.bytes += Buffer.byteLength(chunk, "utf8");
    if (this.bytes <= this.capBytes) return;

    this.droppedFlag = true;
    const excess = this.bytes - this.capBytes;
    let index = 0;
    let removed = 0;
    for (const codePoint of this.text) {
      if (removed >= excess) break;
      removed += Buffer.byteLength(codePoint, "utf8");
      index += codePoint.length;
    }
    this.text = this.text.slice(index);
    this.bytes -= removed;
  }

  markDropped(): void {
    this.droppedFlag = true;
  }

  drain(maxBytes: number): {
    text: string;
    clipped: boolean;
    dropped: boolean;
  } {
    const dropped = this.droppedFlag;
    this.droppedFlag = false;
    if (this.bytes === 0) return { text: "", clipped: false, dropped };
    if (this.bytes <= maxBytes) {
      const text = this.text;
      this.text = "";
      this.bytes = 0;
      return { text, clipped: false, dropped };
    }

    const taken = takeLeadingCodePoints(this.text, maxBytes);
    this.text = this.text.slice(taken.text.length);
    this.bytes -= taken.size;
    return { text: taken.text, clipped: true, dropped };
  }
}
