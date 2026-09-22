import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isEagerReplacement,
  isNestedOnlyName,
  PI_BUILTIN_BASH,
  PI_BUILTIN_EDIT,
  PI_BUILTIN_READ,
  PI_BUILTIN_WRITE,
  PI_REPLACED_BUILTINS,
  resolveExecutionRoutes,
  type ExecutionAdmission,
  type ExecutionRoutes,
  type RequestedCapabilities,
} from "../src/execution-mode.ts";

/**
 * Skill catalog and `read` retention, checked against Pi's own prompt builder.
 *
 * Pi renders the skills section only when the selected tools include `read` or
 * `bash` (0.87.0 `dist/core/system-prompt.js`, the `skillFileReadTool` lookup),
 * and it tells the model to load a skill file with whichever of the two it
 * found. Every Shell or Code route hides `bash`, so the catalog — and with it
 * Pi's own text/image reader — survives a replacement only because `read` is
 * not in `PI_REPLACED_BUILTINS`. This checks that for all eight P/S/C
 * combinations against the real builder rather than a restatement of the rule.
 *
 * That builder is not in the host package's public export map, so it is loaded
 * from the installed `dist` by file URL, the way the planning probe did. The
 * host-internal import belongs to this test alone; `src/` never reaches into
 * Pi's `dist`. No session, no provider, no process, no network.
 */

const HOST_PROMPT_MODULE = pathToFileURL(
  resolve(
    import.meta.dirname,
    "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js",
  ),
).href;

interface PromptSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
  };
  disableModelInvocation: boolean;
}

/** The builder's own shape, narrowed to what this test supplies and reads. */
type BuildSystemPromptSections = (input: {
  cwd: string;
  selectedTools?: string[];
  skills?: PromptSkill[];
}) => Record<string, string | undefined>;

const { buildSystemPromptSections } = (await import(
  /* @vite-ignore */ HOST_PROMPT_MODULE
)) as { buildSystemPromptSections: BuildSystemPromptSections };

const CWD = resolve(import.meta.dirname, "..");
const SKILL_DIR = "/pct-prompt-probe/skills/pct-prompt-marker";
const SKILL: PromptSkill = {
  name: "pct-prompt-marker",
  description: "Synthetic skill; nothing loads or runs it.",
  filePath: `${SKILL_DIR}/SKILL.md`,
  baseDir: SKILL_DIR,
  sourceInfo: {
    path: SKILL_DIR,
    source: "pct-prompt-probe",
    scope: "project",
    origin: "top-level",
  },
  disableModelInvocation: false,
};
/** The instruction the catalog carries when `read` is the surviving reader. */
const READ_INSTRUCTION = "Use the read tool to load a skill's file";
const BASH_INSTRUCTION = "Use bash to load a skill's file";

const ALL_ADMITTED: ExecutionAdmission = {
  patchOwnedAdmitted: true,
  shellPairAdmitted: true,
  codePairAdmitted: true,
};

/** Pi's default selected tools, which the rules project over. */
const NATIVE_BASELINE = [
  PI_BUILTIN_READ,
  PI_BUILTIN_BASH,
  PI_BUILTIN_EDIT,
  PI_BUILTIN_WRITE,
] as const;

/**
 * Owned execution names with the route that makes each one top-level, in the
 * order `src/index.ts` projects them.
 */
const OWNED_VISIBILITY: ReadonlyArray<
  readonly [string, (routes: ExecutionRoutes) => boolean]
> = [
  ["apply_patch", (routes) => routes.directPatch],
  ["exec_command", (routes) => routes.directShell],
  ["write_stdin", (routes) => routes.directShell],
  ["exec", (routes) => routes.code],
  ["wait", (routes) => routes.code],
];

/**
 * The selected-tool list a session ends up with: the native baseline minus the
 * builtins this projection hides, plus the owned names it exposes. Same two
 * predicates as the host projection's `wantsVisible` (`src/index.ts`), with the
 * eager-replacement check asserted per combination below.
 */
function project(routes: ExecutionRoutes): string[] {
  const selected: string[] = NATIVE_BASELINE.filter((name) => {
    if (name === PI_BUILTIN_BASH) return !routes.hideBash;
    if (name === PI_BUILTIN_EDIT || name === PI_BUILTIN_WRITE) {
      return !routes.hideEditWrite;
    }
    return true;
  });
  for (const [name, visible] of OWNED_VISIBILITY) {
    if (visible(routes) && !isNestedOnlyName(name, routes)) selected.push(name);
  }
  return selected;
}

function requested(flags: {
  patch: boolean;
  shell: boolean;
  code: boolean;
}): RequestedCapabilities {
  return { ...flags, source: "rules", ruleId: "combination" };
}

/** The parent design's eight-row tool matrix, with full admission. */
const COMBINATIONS: ReadonlyArray<{
  label: string;
  flags: { patch: boolean; shell: boolean; code: boolean };
  selected: string[];
}> = [
  {
    label: "none",
    flags: { patch: false, shell: false, code: false },
    selected: ["read", "bash", "edit", "write"],
  },
  {
    label: "P",
    flags: { patch: true, shell: false, code: false },
    selected: ["read", "bash", "apply_patch"],
  },
  {
    label: "S",
    flags: { patch: false, shell: true, code: false },
    selected: ["read", "edit", "write", "exec_command", "write_stdin"],
  },
  {
    label: "P+S",
    flags: { patch: true, shell: true, code: false },
    selected: ["read", "apply_patch", "exec_command", "write_stdin"],
  },
  {
    label: "C",
    flags: { patch: false, shell: false, code: true },
    selected: ["read", "edit", "write", "exec", "wait"],
  },
  {
    label: "P+C",
    flags: { patch: true, shell: false, code: true },
    selected: ["read", "exec", "wait"],
  },
  {
    label: "S+C",
    flags: { patch: false, shell: true, code: true },
    selected: [
      "read",
      "edit",
      "write",
      "exec_command",
      "write_stdin",
      "exec",
      "wait",
    ],
  },
  {
    label: "P+S+C",
    flags: { patch: true, shell: true, code: true },
    selected: ["read", "exec_command", "write_stdin", "exec", "wait"],
  },
];

describe("system prompt across the execution combinations", () => {
  it("never lets a rule hide Pi's reader", () => {
    expect([...PI_REPLACED_BUILTINS]).not.toContain(PI_BUILTIN_READ);
  });

  it.each(COMBINATIONS)(
    "keeps read and the skill catalog for $label",
    ({ flags, selected }) => {
      const routes = resolveExecutionRoutes(requested(flags), ALL_ADMITTED);
      const selectedTools = project(routes);
      expect(selectedTools).toEqual(selected);
      // The retained reader: text and images keep a native path in every row.
      expect(selectedTools).toContain(PI_BUILTIN_READ);
      // Nothing here can be deferred away by discovery, so this list is what
      // the session actually gets.
      for (const name of selectedTools) {
        if ((NATIVE_BASELINE as readonly string[]).includes(name)) continue;
        expect(isEagerReplacement(name, routes)).toBe(true);
      }

      const sections = buildSystemPromptSections({
        cwd: CWD,
        selectedTools,
        skills: [SKILL],
      });
      const catalog = sections.skills;
      expect(catalog).toBeDefined();
      expect(catalog).toContain(SKILL.name);
      expect(catalog).toContain(SKILL.filePath);
      // `read` — not a hidden `bash` — is the reader the catalog names.
      expect(catalog).toContain(READ_INSTRUCTION);
      expect(catalog).not.toContain(BASH_INSTRUCTION);
      // And the rules section never tells the model to use a hidden builtin:
      // Pi adds its bash file-operations rule from the same selected list.
      expect(sections.rules?.includes("Use bash")).toBe(
        selectedTools.includes(PI_BUILTIN_BASH),
      );
    },
  );

  it("loses the skill catalog when neither read nor bash is selected", () => {
    // The host rule the retention above depends on. A projection that also
    // replaced `read` would drop the catalog, whatever else it offered.
    const replacements = [
      "apply_patch",
      "exec_command",
      "write_stdin",
      "exec",
      "wait",
      "find",
      "grep",
    ];
    expect(
      buildSystemPromptSections({
        cwd: CWD,
        selectedTools: replacements,
        skills: [SKILL],
      }).skills,
    ).toBeUndefined();
    // Either builtin restores it, and the instruction names the one it found.
    expect(
      buildSystemPromptSections({
        cwd: CWD,
        selectedTools: [...replacements, PI_BUILTIN_BASH],
        skills: [SKILL],
      }).skills,
    ).toContain(BASH_INSTRUCTION);
    expect(
      buildSystemPromptSections({
        cwd: CWD,
        selectedTools: [...replacements, PI_BUILTIN_READ],
        skills: [SKILL],
      }).skills,
    ).toContain(READ_INSTRUCTION);
  });
});
