import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Decoded/emitted UTF-8 text, not a binary or execution-success receipt. */
export interface ExecutionOutputRecovery {
  state: "capturing" | "complete" | "partial" | "unavailable";
  path?: string;
  /** Bytes offered by the producer, including any subsequently lost capture. */
  bytes: number;
  /** Confirmed file bytes; a timed-out write may have written more. */
  capturedBytes: number;
  reason?: ExecutionOutputFailure;
}
export type ExecutionOutputFailure =
  | "io-error"
  | "io-timeout"
  | "overload"
  | "source-error"
  | "missing"
  | "owner-closed";

/** Narrow fault-injection seam; production always exclusively creates 0600 files. */
export interface ExecutionOutputFile {
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}
export interface ExecutionOutputOwnerOptions {
  /** Trusted embedding/test option, never a tool argument. */
  temporaryRoot?: string;
  ioTimeoutMs?: number;
  openFile?: (path: string) => Promise<ExecutionOutputFile>;
}
export interface ExecutionOutputCaptureOptions {
  /** Independent cumulative prefix, not the destructively read preview. */
  memoryBytes: number;
  /** Admission bound, independent of whether the caller observes backpressure. */
  pendingBytes?: number;
  pendingChunks?: number;
}

class OutputTimeout extends Error {}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OutputTimeout()), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One explicit output lifetime. No directory exists until a capture spills or
 * is published. Close only AFTER stopping producers. Production shares this
 * owner until Pi session_shutdown, not merely until a feature is disabled.
 * No quota/TTL, cross-restart lookup, scavenging, or command/argument recording.
 */
export class ExecutionOutputOwner {
  private directory?: Promise<string>;
  private readonly paths = new Map<string, { dev: number; ino: number }>();
  private readonly captures = new Set<ExecutionOutputCapture>();
  private readonly operations = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private closed = false;
  readonly ioTimeoutMs: number;

  constructor(private readonly options: ExecutionOutputOwnerOptions = {}) {
    this.ioTimeoutMs = options.ioTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.ioTimeoutMs) || this.ioTimeoutMs < 1) {
      throw new Error("Output I/O timeout must be a positive integer.");
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  createCapture(
    options: ExecutionOutputCaptureOptions,
  ): ExecutionOutputCapture {
    if (this.closed) throw new Error("Execution output owner is closed.");
    return new ExecutionOutputCapture(this, options);
  }

  /** Internal ownership operations; callers use createCapture/publish/finish. */
  register(capture: ExecutionOutputCapture): void {
    if (this.closed) throw new Error("Execution output owner is closed.");
    this.captures.add(capture);
  }
  release(capture: ExecutionOutputCapture): void {
    this.captures.delete(capture);
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation
      .finally(() => this.operations.delete(operation))
      .catch(() => undefined);
    return operation;
  }
  async createFile(): Promise<{ path: string; file: ExecutionOutputFile }> {
    if (this.closed) throw new Error("Output owner closed");
    this.directory ??= mkdtemp(
      join(resolve(this.options.temporaryRoot ?? tmpdir()), "pct-output-"),
    );
    const directory = await this.directory;
    if (this.closed) throw new Error("Output owner closed");
    const path = join(directory, `${randomUUID()}.txt`);
    const file = await (this.options.openFile?.(path) ??
      open(path, "wx", 0o600));
    try {
      const identity = await lstat(path);
      this.paths.set(path, { dev: identity.dev, ino: identity.ino });
      return { path, file };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async isAvailable(path: string): Promise<boolean> {
    const identity = this.paths.get(path);
    try {
      const current = await lstat(path);
      return (
        !!identity &&
        current.isFile() &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      );
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Never unlink while an owned descriptor is still writing. A pathological
    // filesystem can outlive the bounded caller wait; retain its cleanup promise
    // and remove only our files when that operation actually settles.
    const cleanup = async () => {
      await Promise.all([...this.captures].map((capture) => capture.dispose()));
      while (this.operations.size)
        await Promise.allSettled([...this.operations]);
      await Promise.all(
        [...this.paths.keys()].map(async (path) => {
          if (await this.isAvailable(path))
            await unlink(path).catch(() => undefined);
        }),
      );
      this.paths.clear();
      const directory = await this.directory?.catch(() => undefined);
      // No recursive removal: a foreign file added to our directory is not ours.
      if (directory) await rmdir(directory).catch(() => undefined);
    };
    this.closing = bounded(cleanup(), this.ioTimeoutMs).catch(() => undefined);
    return this.closing;
  }
}

/**
 * One logical text stream across all observations. Await append() (pause a pipe
 * or withhold a worker ACK) for producer backpressure. Ignoring it is bounded:
 * overload stops capture explicitly, while execution and previews may continue.
 */
export class ExecutionOutputCapture {
  private prefix = "";
  private prefixBytes = 0;
  private totalBytes = 0;
  private writtenBytes = 0;
  private pendingBytes = 0;
  private pendingChunks = 0;
  private readonly pendingByteLimit: number;
  private readonly pendingChunkLimit: number;
  private chain: Promise<void> = Promise.resolve();
  private file?: ExecutionOutputFile;
  private path?: string;
  private failure?: ExecutionOutputFailure;
  private ending = false;
  private ended = false;
  private disposed = false;
  private published = false;
  private stalled = false;

  constructor(
    private readonly owner: ExecutionOutputOwner,
    private readonly options: ExecutionOutputCaptureOptions,
  ) {
    // Two prefix budgets accommodate one retained prefix plus normal producer
    // chunks. The count bound prevents tiny-chunk queue overhead; not a disk cap.
    this.pendingByteLimit =
      options.pendingBytes ?? Math.max(options.memoryBytes * 2, 64 * 1024);
    this.pendingChunkLimit = options.pendingChunks ?? 16;
    for (const value of [
      options.memoryBytes,
      this.pendingByteLimit,
      this.pendingChunkLimit,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Output memory bounds must be positive integers.");
    }
    owner.register(this);
  }

  get needsRecovery(): boolean {
    return (
      this.published || this.path !== undefined || this.failure !== undefined
    );
  }

  append(text: string): Promise<void> {
    const bytes = Buffer.byteLength(text, "utf8");
    this.totalBytes += bytes;
    if (!bytes) return Promise.resolve();
    if (this.owner.isClosed || this.disposed) this.fail("owner-closed");
    else if (this.ending) this.fail("source-error");
    if (this.failure) return Promise.resolve();
    if (
      bytes + this.pendingBytes > this.pendingByteLimit ||
      this.pendingChunks >= this.pendingChunkLimit
    ) {
      this.fail("overload");
      return Promise.resolve();
    }
    this.pendingBytes += bytes;
    this.pendingChunks++;
    return this.enqueue(async () => {
      if (this.failure) return;
      if (
        !this.file &&
        !this.path &&
        this.prefixBytes + bytes <= this.options.memoryBytes
      ) {
        this.prefix += text;
        this.prefixBytes += bytes;
      } else {
        await this.spill();
        await this.write(text);
      }
    }).finally(() => {
      this.pendingBytes -= bytes;
      this.pendingChunks--;
    });
  }

  fail(reason: ExecutionOutputFailure): void {
    // A missing source is unavailable, even if capture first failed partially.
    // Retain the first capture failure unless the recovery location is lost.
    if (reason === "missing" || !this.failure) this.failure = reason;
  }

  /** Publish a stable absolute recovery location, including an empty live stream. */
  async publish(): Promise<ExecutionOutputRecovery> {
    this.published = true;
    if (this.owner.isClosed || (this.disposed && !this.path))
      this.fail("owner-closed");
    await this.enqueue(async () => {
      if (!this.failure) await this.spill();
      if (this.ended) await this.closeFile();
    });
    // Availability is read-only and independent of a stalled writer. Do not
    // skip it just because a timed-out descriptor still owns late cleanup.
    if (this.path) {
      try {
        if (
          !(await bounded(
            this.owner.track(this.owner.isAvailable(this.path)),
            this.owner.ioTimeoutMs,
          ))
        )
          this.fail("missing");
      } catch (error) {
        this.fail(error instanceof OutputTimeout ? "io-timeout" : "io-error");
      }
      if (this.failure) await this.enqueue(() => this.closeFile());
    }
    return this.snapshot();
  }

  /** Producer ended. Keeps a small prefix until the terminal preview is decided. */
  async finish(): Promise<void> {
    if (this.ending) return this.chain;
    this.ending = true;
    await this.enqueue(async () => {
      await this.closeFile();
      // Only queued finalization may mark the file ended. A prior publish()
      // must not close it ahead of already admitted chunks awaiting that open.
      this.ended = true;
    });
  }

  /** Release the capture object, never the owner's published files. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.ended) this.fail("owner-closed");
    await this.enqueue(() => this.closeFile());
    this.prefix = "";
    this.prefixBytes = 0;
    this.owner.release(this);
  }

  private snapshot(): ExecutionOutputRecovery {
    if (this.ended && this.path && this.writtenBytes !== this.totalBytes) {
      this.fail("source-error");
    }
    return {
      state: this.failure
        ? this.path && this.failure !== "missing" && !this.owner.isClosed
          ? "partial"
          : "unavailable"
        : this.ended
          ? "complete"
          : "capturing",
      ...(this.path ? { path: this.path } : {}),
      bytes: this.totalBytes,
      capturedBytes: this.writtenBytes,
      ...(this.failure ? { reason: this.failure } : {}),
    };
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      // No later operation may close/reuse a descriptor while a timed-out
      // write/open is still outstanding. Its tracked finally owns late cleanup.
      if (this.stalled) return;
      const operation = this.owner.track(
        (async () => {
          try {
            await action();
          } catch (error) {
            this.fail("io-error");
            throw error;
          } finally {
            if (this.failure || this.disposed) await this.closeFile();
          }
        })(),
      );
      try {
        await bounded(operation, this.owner.ioTimeoutMs);
      } catch (error) {
        if (error instanceof OutputTimeout) this.stalled = true;
        this.fail(error instanceof OutputTimeout ? "io-timeout" : "io-error");
      }
    });
    this.chain = run;
    return run;
  }

  private async spill(): Promise<void> {
    if (this.path || this.failure) return;
    const created = await this.owner.createFile();
    this.file = created.file;
    this.path = created.path;
    // A timed-out open/owner close must never resurrect a producer.
    if (this.failure || this.owner.isClosed) {
      this.fail(this.owner.isClosed ? "owner-closed" : "io-timeout");
      return;
    }
    const prefix = this.prefix;
    this.prefix = "";
    this.prefixBytes = 0;
    await this.write(prefix);
  }

  private async write(text: string): Promise<void> {
    if (!text || this.failure || !this.file) return;
    const buffer = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < buffer.length && !this.failure) {
      const { bytesWritten } = await this.file.write(buffer.subarray(offset));
      if (bytesWritten <= 0) throw new Error("Output write made no progress");
      this.writtenBytes += bytesWritten;
      offset += bytesWritten;
    }
  }

  private async closeFile(): Promise<void> {
    const file = this.file;
    this.file = undefined;
    if (file) await file.close();
  }
}
