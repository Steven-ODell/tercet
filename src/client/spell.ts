import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import nspell from "nspell";

/** A word the dictionary does not know, with where it sits in the text (UTF-16 offsets). */
export interface Misspelling {
  start: number;
  end: number;
  word: string;
}

export interface SpellChecker {
  /** False until the dictionary has loaded; `check` finds nothing before that. */
  ready(): boolean;
  /** Every unknown word in `text`; code, paths, URLs, mentions and identifiers are left alone. */
  check(text: string): Misspelling[];
  /** Likely corrections, best first, in the case the word was typed in. */
  suggest(word: string): string[];
  /** Teaches the dictionary a word for good (written to the personal dictionary file). */
  add(word: string): Promise<void>;
  /** Teaches it a word until tercet exits. */
  ignore(word: string): void;
  /** Called when the dictionary loads or a word is added; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

type Speller = ReturnType<typeof nspell>;

export interface SpellOptions {
  /** One word per line; read at start and appended to by `add`. */
  personalFile?: string;
  /** Resolves the Hunspell files; defaults to the bundled English (US) dictionary. */
  load?: () => Promise<{ aff: string; dic: string }>;
}

const LETTERS = /\p{L}/u;
// Leading and trailing punctuation that belongs to the sentence, not the word.
const EDGE_OPEN = /^[("'“‘[{<*_~]+/u;
const EDGE_CLOSE = /[)"'”’\]}>.,;:!?…*_~]+$/u;
// A token holding any of these is code, a path, an address, a flag or a mention.
const NOT_PROSE = /[/\\@#$%^&=+|<>{}[\]_~\d]|:\/\/|^-|\.\p{L}/u;

/** The unknown words in `text`, asking `known(word)` about each candidate. */
export function findMisspellings(text: string, known: (word: string) => boolean): Misspelling[] {
  const found: Misspelling[] = [];
  const fences = codeRanges(text);
  const chunk = /\S+/gu;
  for (let match = chunk.exec(text); match; match = chunk.exec(text)) {
    let start = match.index;
    let token = match[0];
    const open = EDGE_OPEN.exec(token)?.[0].length ?? 0;
    start += open;
    token = token.slice(open);
    token = token.slice(0, token.length - (EDGE_CLOSE.exec(token)?.[0].length ?? 0));
    if (!token || NOT_PROSE.test(token) || insideRange(fences, start)) continue;
    // "well-known" and "one—two" are checked a part at a time.
    const part = /[\p{L}'’]+/gu;
    for (let piece = part.exec(token); piece; piece = part.exec(token)) {
      const word = piece[0].replace(/^['’]+|['’]+$/gu, "");
      const at = start + piece.index + piece[0].indexOf(word);
      if (word.length < 2 || !LETTERS.test(word) || shouldSkip(word)) continue;
      if (!known(straight(word))) found.push({ start: at, end: at + word.length, word });
    }
  }
  return found;
}

/** camelCase, ALL CAPS, HTTPServer and the like are names or acronyms, not typos. */
function shouldSkip(word: string) {
  return (word.match(/\p{Lu}/gu)?.length ?? 0) >= 2 || /\p{Ll}\p{Lu}/u.test(word);
}

/** Spans of inline code and fenced blocks, which are never prose. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const ticks = /`{3,}|`/g;
  let open: { at: number; len: number } | undefined;
  for (let match = ticks.exec(text); match; match = ticks.exec(text)) {
    if (!open) open = { at: match.index, len: match[0].length };
    else if (match[0].length === open.len) {
      ranges.push([open.at, match.index + match[0].length]);
      open = undefined;
    }
  }
  // A fence or span still being typed hides everything after it.
  if (open) ranges.push([open.at, text.length]);
  return ranges;
}
const insideRange = (ranges: [number, number][], at: number) =>
  ranges.some(([from, to]) => at >= from && at < to);

/** Matches a suggestion to how the word was typed: Teh -> The, but never shouting by accident. */
function matchCase(word: string, suggestion: string) {
  const first = word[0] ?? "";
  return first !== first.toLowerCase() && suggestion[0] === suggestion[0]?.toLowerCase()
    ? suggestion[0]!.toUpperCase() + suggestion.slice(1)
    : suggestion;
}

/** Swapping two neighbors (teh, recieve) is the commonest slip, so those suggestions go first. */
function rank(word: string, suggestions: string[], correct: (word: string) => boolean) {
  const swaps: string[] = [];
  for (let i = 0; i + 1 < word.length; i++) {
    const swapped = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    if (swapped !== word && correct(swapped)) swaps.push(swapped);
  }
  return [...new Set([...swaps, ...suggestions].map((s) => matchCase(word, s)))];
}

const straight = (word: string) => word.replace(/’/gu, "'");

async function bundled() {
  const { aff, dic } = await import("./spell-data");
  return { aff, dic };
}

export function createSpellChecker(options: SpellOptions = {}): SpellChecker {
  let speller: Speller | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const added: string[] = [];
  // Words are checked with straight apostrophes, so they are taught that way too: y’all is y'all.
  const teach = (raw: string) => {
    const word = straight(raw);
    if (speller) speller.add(word);
    else added.push(word);
  };
  // The dictionary loads on first use, so `tercet keys` and `doctor` never pay for it.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void load();
  };
  const load = async () => {
    try {
      const { aff, dic } = await (options.load ?? bundled)();
      const loaded = nspell(aff, dic);
      const personal = options.personalFile
        ? await readFile(options.personalFile, "utf8").catch(() => "")
        : "";
      for (const word of personal.split(/\r?\n/)) if (word.trim()) loaded.add(straight(word.trim()));
      for (const word of added) loaded.add(word);
      speller = loaded;
      notify();
    } catch {
      // No dictionary means no underlines; typing is never blocked on it.
    }
  };
  const stem = (word: string) => straight(word).replace(/'s$/i, "");
  const known = (word: string) =>
    !speller ||
    [word, word.toLowerCase(), stem(word)].some((form) => form.length > 0 && speller!.correct(form));
  return {
    ready: () => !!speller,
    check(text) {
      start();
      return speller ? findMisspellings(text, known) : [];
    },
    suggest: (word) =>
      speller ? rank(word, speller.suggest(word), (w) => speller!.correct(w)) : [],
    async add(raw) {
      start();
      const word = stem(raw);
      teach(word);
      notify();
      if (!options.personalFile) return;
      await mkdir(dirname(options.personalFile), { recursive: true });
      await appendFile(options.personalFile, `${word}\n`);
    },
    ignore(word) {
      teach(word);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
