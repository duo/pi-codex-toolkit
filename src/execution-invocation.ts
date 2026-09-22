/**
 * Generic invocation seam for Toolkit execution.
 *
 * One integration point for the direct tools and the nested Code Mode
 * adapters: an embedder supplies the trusted per-call environment and the
 * applicable policy decision, and both paths apply them identically before any
 * effect. The Toolkit ships no built-in caller; `createPiCodexToolkit` is the
 * only way to install hooks, and the default extension export installs none.
 *
 * This module is deliberately generic: it derives nothing from a particular
 * orchestrator, reads no environment variable, mutates no `process.env`, and
 * never emits a Pi `tool_call` / `tool_result` event. A future permission
 * engine integrates through the same seam.
 */

/** The three effect-bearing entries a hook can see. */
export type ExecutionInvocationTool =
  | "exec_command"
  | "write_stdin"
  | "apply_patch";

/** Control identity of one invocation; never command, patch or program text. */
export interface ExecutionInvocationCall {
  tool: ExecutionInvocationTool;
  /** `direct` is an ordinary Pi dispatch; `nested` is a Code Mode adapter. */
  path: "direct" | "nested";
  /** Absolute invoking directory this call resolved. */
  cwd: string;
  /** Present for a nested call: the opaque Code Mode cell handle. */
  cellId?: string;
  /** Present when the call names one: the opaque shell session handle. */
  sessionId?: string;
}

/**
 * Trusted per-call context. `env` is an overlay merged over the manager's
 * captured environment at spawn; it never replaces that environment, never
 * mutates `process.env`, and never outlives the call that supplied it.
 */
export interface ExecutionInvocationContext {
  env?: Record<string, string>;
}

export type ExecutionInvocationDecision =
  | { allow: true }
  | { allow: false; reason: string };

export interface ExecutionInvocationHooks {
  context?(
    call: ExecutionInvocationCall,
  ):
    | ExecutionInvocationContext
    | undefined
    | Promise<ExecutionInvocationContext | undefined>;
  policy?(
    call: ExecutionInvocationCall,
  ): ExecutionInvocationDecision | Promise<ExecutionInvocationDecision>;
}

/**
 * A hook refused this call. It is raised before the executor runs, so nothing
 * was started and there is nothing to roll back or replay.
 */
export class ExecutionPolicyError extends Error {
  readonly code = "policy-denied";

  constructor(message: string) {
    super(message);
    this.name = "ExecutionPolicyError";
  }
}

/**
 * Apply the configured hooks to one call. Returns the trusted context the
 * caller passes to its executor, or throws before any effect when the policy
 * denies the call. Without hooks this is a cheap synchronous no-op, so the
 * default extension keeps its existing dispatch ordering.
 */
export async function resolveInvocation(
  hooks: ExecutionInvocationHooks | undefined,
  call: ExecutionInvocationCall,
): Promise<ExecutionInvocationContext> {
  if (!hooks?.context && !hooks?.policy) return {};
  const supplied = hooks.context ? await hooks.context(call) : undefined;
  const context = normalizeContext(supplied, call);
  if (hooks.policy) {
    const decision = await hooks.policy(call);
    if (!decision || decision.allow !== true) {
      const reason =
        decision && typeof decision.reason === "string" && decision.reason
          ? decision.reason
          : "no reason was supplied";
      throw new ExecutionPolicyError(
        `${call.tool} was denied by the Toolkit invocation policy: ${reason}. Nothing ran.`,
      );
    }
  }
  return context;
}

/** Reject a malformed overlay instead of forwarding it to a spawn. */
function normalizeContext(
  supplied: ExecutionInvocationContext | undefined,
  call: ExecutionInvocationCall,
): ExecutionInvocationContext {
  if (supplied === undefined || supplied === null) return {};
  const env = supplied.env;
  if (env === undefined) return {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new ExecutionPolicyError(
      `The invocation context hook returned an invalid environment overlay for ${call.tool}; it must be an object of string values. Nothing ran.`,
    );
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new ExecutionPolicyError(
        `The invocation context hook returned a non-string value for environment key "${key}" on ${call.tool}. Nothing ran.`,
      );
    }
  }
  return { env: { ...env } };
}
