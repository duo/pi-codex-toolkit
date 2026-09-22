import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The shared extension event bus Pi always supplies. Hand-rolled `ExtensionAPI`
 * mocks predate the execution-diagnostics record the factory publishes there,
 * so this completes them with the one member every real host has. Handler
 * errors are the real bus's business; this one lets them surface.
 */
export function recordingEventBus(): EventBus & {
  records: Array<{ channel: string; data: unknown }>;
} {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const records: Array<{ channel: string; data: unknown }> = [];
  return {
    records,
    emit: (channel, data) => {
      records.push({ channel, data });
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on: (channel, handler) => {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
}

/**
 * Complete a partial `ExtensionAPI` mock with that bus, in place: tests spy on
 * the same object they hand the factory, so this must not return a copy.
 */
export function withEventBus<T extends object>(
  pi: T,
  events: EventBus = recordingEventBus(),
): T {
  return Object.assign(pi, { events } as Pick<ExtensionAPI, "events">);
}
