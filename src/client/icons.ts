import type { ModelSelection, OrchestrationProjectShell, ServerProvider } from "@t3tools/contracts";
import { theme, type Color } from "./theme";

/**
 * Icons in three sets, picked by the `icons` setting. `nerd` is the Nerd Font set, written as
 * escapes so the source doesn't depend on the editor's font; the trailing comment on each is its
 * name in nerd-fonts' glyphnames.json, and it needs a Nerd Font (3.5 or newer has the OpenAI and
 * Claude logos) in the terminal that draws it, which over SSH means the machine you type on.
 * `unicode` (the default) uses single-cell symbols most fonts have, and `ascii` uses none at all;
 * in both the color still tells file types apart. Always follow a glyph with a space: terminals
 * may draw a Nerd Font glyph two cells wide.
 */
export interface Icon {
  readonly glyph: string;
  readonly color: Color;
}

export const ICON_MODES = ["nerd", "unicode", "ascii"] as const;
export type IconMode = (typeof ICON_MODES)[number];
let mode: IconMode = "unicode";
export const iconMode = () => mode;

type Role = "blue" | "cyan" | "green" | "yellow" | "red" | "pink" | "accent" | "muted" | "bright";
type Strong = Role | "strong";

// Icons are made per call so they follow the current mode and theme; `memo` keeps them identical.
const cache = new Map<string, Icon>();
const memo = (nerd: string, plain: readonly [string, string], role: Strong): Icon => {
  const glyph = mode === "nerd" ? nerd : mode === "unicode" ? plain[0] : plain[1];
  const key = `${glyph}|${String(theme[role])}`;
  let value = cache.get(key);
  if (!value) cache.set(key, (value = { glyph, color: theme[role] }));
  return value;
};
const fileLike = ["\u2022", "."] as const;
const icon =
  (glyph: string, role: Strong, plain: readonly [string, string] = fileLike) =>
  () =>
    memo(glyph, plain, role);

const claude = icon("\u{ec82}", "pink", ["\u273b", "*"]); // cod-claude
const robot = icon("\u{f06a9}", "accent", ["\u25c6", "#"]); // md-robot
const localModel = icon("\u{f061a}", "green", ["\u25aa", "="]); // md-chip

/** One entry per adapter; anything else, such as an ACP registry agent, gets the robot. */
const driverIcons: Readonly<Record<string, () => Icon>> = {
  claudeAgent: claude,
  codex: icon("\u{ec81}", "strong", ["\u25ce", "o"]), // cod-openai
  opencode: icon("\u{ea85}", "cyan", ["\u203a", ">"]), // cod-terminal
  cursor: icon("\u{ec5c}", "bright", ["\u25b2", "^"]), // cod-cursor
  grok: icon("\u{f0b1f}", "bright", ["\u2715", "x"]), // md-alpha_x_box
  antigravity: icon("\u{f0463}", "blue", ["\u2197", "^"]), // md-rocket
  pi: icon("\u{f03ff}", "yellow", ["\u03c0", "p"]), // md-pi
};

// OpenCode names a model by where it runs: ollama/qwen3.5:9b is local, opencode/beam-free is not.
const localModelSlug = /^(?:ollama|lm-?studio|llama[-.]?cpp|local[^/]*)\//i;

export function modelIcon(driver: string | undefined, model: string): Icon {
  if (localModelSlug.test(model)) return localModel();
  return ((driver && driverIcons[driver]) || robot)();
}

/** Custom instances route by id, so the driver comes from the catalog; default ids are the driver. */
export function selectionIcon(selection: ModelSelection, providers: readonly ServerProvider[]) {
  const driver = providers.find((p) => p.instanceId === selection.instanceId)?.driver;
  return modelIcon(driver ?? selection.instanceId, selection.model);
}

const shut = ["\u25b8", "+"] as const;
const folder = icon("\u{e5ff}", "accent", shut); // custom-folder
const folderOpen = icon("\u{e5fe}", "accent", ["\u25be", "-"]); // custom-folder_open
const specialFolders: Readonly<Record<string, () => Icon>> = {
  ".git": icon("\u{e65d}", "red", shut), // seti-git
  ".github": icon("\u{e65b}", "bright", shut), // seti-github
  node_modules: icon("\u{e616}", "red", shut), // seti-npm
};

const typescript = icon("\u{e628}", "blue"); // seti-typescript
const javascript = icon("\u{e60c}", "yellow"); // seti-javascript
const react = icon("\u{e7ba}", "cyan"); // dev-react
const json = icon("\u{e60b}", "yellow"); // seti-json
const markdown = icon("\u{e609}", "cyan"); // seti-markdown
const yaml = icon("\u{e8eb}", "accent"); // dev-yaml
const shell = icon("\u{e691}", "green"); // seti-shell
const image = icon("\u{e60d}", "accent"); // seti-image
const video = icon("\u{e69f}", "pink"); // seti-video
const audio = icon("\u{f075a}", "pink"); // md-music
const archive = icon("\u{f05c4}", "yellow"); // md-zip_box
const text = icon("\u{f09ee}", "muted"); // md-file_document_outline
const database = icon("\u{e706}", "yellow"); // dev-database
const c = icon("\u{e649}", "blue"); // seti-c
const cpp = icon("\u{e646}", "blue"); // seti-cpp
const css = icon("\u{e614}", "blue"); // seti-css
const lock = icon("\u{e672}", "muted"); // seti-lock
const secrets = icon("\u{f0306}", "yellow"); // md-key
const git = icon("\u{e65d}", "red"); // seti-git
const build = icon("\u{f08ea}", "muted"); // md-hammer

const extensions: Readonly<Record<string, () => Icon>> = {
  ts: typescript,
  mts: typescript,
  cts: typescript,
  tsx: react,
  jsx: react,
  js: javascript,
  mjs: javascript,
  cjs: javascript,
  json,
  jsonc: json,
  md: markdown,
  mdx: markdown,
  yaml,
  yml: yaml,
  toml: icon("\u{e6b2}", "muted"), // custom-toml
  py: icon("\u{e606}", "yellow"), // seti-python
  rs: icon("\u{e68b}", "red"), // seti-rust
  go: icon("\u{e627}", "cyan"), // seti-go
  c,
  h: c,
  cpp,
  cc: cpp,
  cxx: cpp,
  hpp: cpp,
  lua: icon("\u{e620}", "blue"), // seti-lua
  java: icon("\u{e66d}", "red"), // seti-java
  kt: icon("\u{e634}", "accent"), // seti-kotlin
  kts: icon("\u{e634}", "accent"),
  swift: icon("\u{e699}", "red"), // seti-swift
  rb: icon("\u{e605}", "red"), // seti-ruby
  nix: icon("\u{f1105}", "blue"), // md-nix
  html: icon("\u{e60e}", "red"), // seti-html
  css,
  scss: icon("\u{e603}", "pink"), // seti-sass
  sass: icon("\u{e603}", "pink"),
  sh: shell,
  bash: shell,
  zsh: shell,
  fish: shell,
  sql: database,
  sqlite: database,
  db: database,
  svg: icon("\u{e698}", "yellow"), // seti-svg
  png: image,
  jpg: image,
  jpeg: image,
  gif: image,
  webp: image,
  avif: image,
  ico: image,
  mp4: video,
  mov: video,
  webm: video,
  mkv: video,
  mp3: audio,
  wav: audio,
  ogg: audio,
  opus: audio,
  flac: audio,
  m4a: audio,
  pdf: icon("\u{f0226}", "red"), // md-file_pdf_box
  zip: archive,
  tar: archive,
  gz: archive,
  tgz: archive,
  xz: archive,
  lock,
  txt: text,
  log: text,
};

const fileNames: Readonly<Record<string, () => Icon>> = {
  "package.json": icon("\u{e616}", "red"), // seti-npm
  "tsconfig.json": typescript,
  dockerfile: icon("\u{e650}", "blue"), // seti-docker
  ".gitignore": git,
  ".gitattributes": git,
  ".gitmodules": git,
  "claude.md": claude,
  "agents.md": robot,
  makefile: build,
  "cmakelists.txt": build,
};

/** `open` only matters for directories. Paths may be nested; only the last segment is read. */
export function fileIcon(path: string, kind: "file" | "directory" = "file", open = false): Icon {
  const name = path.replace(/\/$/, "").split("/").at(-1) ?? "";
  if (kind === "directory") return (specialFolders[name] ?? (open ? folderOpen : folder))();
  const lower = name.toLowerCase();
  const named = fileNames[lower];
  if (named) return named();
  if (lower.startsWith("readme")) return icon("\u{f14f7}", "cyan")(); // md-book_open_variant
  if (lower.startsWith("license")) return icon("\u{e60a}", "yellow")(); // seti-license
  if (lower.startsWith(".env")) return secrets();
  if (lower.startsWith("docker-compose")) return fileNames.dockerfile!();
  if (lower.startsWith("vite.config")) return icon("\u{e8d6}", "accent")(); // dev-vite
  const extension = lower.includes(".") ? lower.split(".").at(-1)! : "";
  return (extensions[extension] ?? icon("\u{f0224}", "bright"))(); // md-file_outline
}

// Web's popular project icons (apps/web/src/projectIconOptions.ts). Web accepts any Lucide name;
// the rest fall back to the folder, since a Nerd Font has no complete Lucide set. The other sets
// draw a square, in the project's color.
const projectGlyphs: Readonly<Record<string, string>> = {
  "folder-code": "\u{e5ff}", // custom-folder
  "code-2": "\u{f0169}", // md-code_braces
  terminal: "\u{ea85}", // cod-terminal
  "globe-2": "\u{f059f}", // md-web
  server: "\u{eb50}", // cod-server
  database: "\u{f01bc}", // md-database
  bot: "\u{f06a9}", // md-robot
  sparkles: "\u{f0674}", // md-creation
  smartphone: "\u{f011c}", // md-cellphone
  monitor: "\u{f0379}", // md-monitor
  "cloud-cog": "\u{f015f}", // md-cloud
  package: "\u{f03d3}", // md-package
  "book-open": "\u{f14f7}", // md-book_open_variant
  "flask-conical": "\u{f0093}", // md-flask
  "shield-check": "\u{f0565}", // md-shield_check
  rocket: "\u{f0463}", // md-rocket
  "gamepad-2": "\u{f0297}", // md-gamepad_variant
  music: "\u{f075a}", // md-music
  image: "\u{f02e9}", // md-image
  "shopping-bag": "\u{f049a}", // md-shopping
  "git-branch": "\u{f062c}", // md-source_branch
  workflow: "\u{f04aa}", // md-sitemap
  wrench: "\u{f05b7}", // md-wrench
  "layers-3": "\u{f0328}", // md-layers
};

/** What web's project favicon shows: the chosen emoji or monogram, or the closest glyph. */
export function projectGlyph(project: Pick<OrchestrationProjectShell, "projectIcon">) {
  const chosen = project.projectIcon;
  if (chosen?.kind === "emoji") return mode === "ascii" ? "*" : chosen.emoji;
  if (chosen?.kind === "monogram") return chosen.text;
  if (mode !== "nerd") return mode === "unicode" ? "\u25a0" : "#";
  return (chosen && projectGlyphs[chosen.name]) ?? folder().glyph;
}

const paneSets = {
  nerd: {
    sidebar: "\u{f028c}", // md-forum
    transcript: "\u{f09ed}", // md-text_box_outline
    composer: "\u{f03eb}", // md-pencil
    files: "\u{f0645}", // md-file_tree
    diff: "\u{f08aa}", // md-file_compare
    launchers: "\u{f003b}", // md-apps
    terminal: "\u{f018d}", // md-console
    branch: "\u{e725}", // dev-git_branch
  },
  unicode: {
    sidebar: "\u2261",
    transcript: "\u00b6",
    composer: "\u00bb",
    files: "\u25a4",
    diff: "\u00b1",
    launchers: "\u25c7",
    terminal: "$",
    branch: "\u21b1",
  },
  ascii: {
    sidebar: "=",
    transcript: "#",
    composer: ">",
    files: "/",
    diff: "+",
    launchers: "*",
    terminal: "$",
    branch: "@",
  },
} as const;

/** Pane title glyphs (and the branch mark) for the current mode; `setIconMode` refills it. */
export const paneGlyphs: Record<keyof (typeof paneSets)["nerd"], string> = { ...paneSets.unicode };

export function setIconMode(next: IconMode = "unicode") {
  mode = next;
  Object.assign(paneGlyphs, paneSets[next]);
}

// One cell in, one cell out, so the layout is identical with and without the filter.
const asciiFallback = new Map<number, number>(
  Object.entries({
    "\u00b7": "|",
    "\u2026": ".",
    "\u2502": "|",
    "\u2503": "|",
    "\u2551": "|",
    "\u2500": "-",
    "\u2501": "-",
    "\u2550": "=",
    "\u256d": "+",
    "\u256e": "+",
    "\u2570": "+",
    "\u256f": "+",
    "\u250c": "+",
    "\u2510": "+",
    "\u2514": "+",
    "\u2518": "+",
    "\u251c": "+",
    "\u2524": "+",
    "\u252c": "+",
    "\u2534": "+",
    "\u253c": "+",
    "\u2554": "+",
    "\u2557": "+",
    "\u255a": "+",
    "\u255d": "+",
    "\u203a": ">",
    "\u2039": "<",
    "\u00bb": ">",
    "\u00ab": "<",
    "\u2713": "*",
    "\u2714": "*",
    "\u2717": "x",
    "\u2715": "x",
    "\u00d7": "x",
    "\u2191": "^",
    "\u2193": "v",
    "\u2190": "<",
    "\u2192": ">",
    "\u2014": "-",
    "\u2013": "-",
    "\u2212": "-",
    "\u25cf": "*",
    "\u2022": "*",
    "\u25cb": "o",
    "\u25cc": "o",
    "\u25d4": "o",
    "\u25d1": "o",
    "\u25d5": "o",
    "\u25f7": "o",
    "\u25be": "v",
    "\u25b8": ">",
    "\u25b6": ">",
    "\u2605": "*",
    "\u25c6": "*",
    "\u25c7": "o",
    "\u2584": "#",
    "\u2588": "#",
    "\u2581": "_",
    "\u2591": ".",
    "\u2592": ":",
    "\u2593": "#",
    "\u201c": '"',
    "\u201d": '"',
    "\u2018": "'",
    "\u2019": "'",
    // The braille spinner keeps turning: - \ | / per frame.
    "\u280b": "-",
    "\u2819": "\\",
    "\u2839": "|",
    "\u2838": "/",
    "\u283c": "-",
    "\u2834": "\\",
    "\u2826": "|",
    "\u2827": "/",
    "\u2807": "-",
    "\u280f": "\\",
  }).map(([from, to]) => [from.codePointAt(0)!, to.codePointAt(0)!]),
);

/**
 * With `icons: "ascii"`, a renderer post-process step that swaps the UI's punctuation, borders,
 * arrows and spinner for ASCII, cell by cell, just before the frame is written. Anything not in
 * the table (a thread's own text, say) is left alone.
 */
export function asciiFrame(buffer: { buffers: { char: Uint32Array } }) {
  const chars = buffer.buffers.char;
  for (let i = 0; i < chars.length; i++) {
    const to = asciiFallback.get(chars[i]!);
    if (to !== undefined) chars[i] = to;
  }
}

/** The same swap on a string, for tests and for text printed outside the renderer. */
export const asciiText = (text: string) =>
  [...text]
    .map((char) => {
      const to = asciiFallback.get(char.codePointAt(0)!);
      return to === undefined ? char : String.fromCodePoint(to);
    })
    .join("");
