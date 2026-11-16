import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpellChecker, findMisspellings } from "./spell";

const words = new Set(["the", "quick", "brown", "fox", "don't", "well", "known", "hello"]);
const known = (word: string) => words.has(word.toLowerCase());
const flagged = (text: string) => findMisspellings(text, known).map((m) => m.word);

test("flags unknown words with their offsets", () => {
  const text = "the quikc fox";
  const [only] = findMisspellings(text, known);
  expect(only).toEqual({ start: 4, end: 9, word: "quikc" });
  expect(text.slice(only!.start, only!.end)).toBe("quikc");
});

test("leaves code, paths, urls, mentions, flags and identifiers alone", () => {
  expect(
    flagged(
      "the @src/foo.ts /review https://exmple.io --verbos fooBar HTTPServer snake_case v1.2 a.b `inlin code` ```\nfenced blok\n```",
    ),
  ).toEqual([]);
});

test("an unclosed code span hides the rest, since it is still being typed", () => {
  expect(flagged("the `quikc fox")).toEqual([]);
});

test("strips punctuation around a word and checks hyphenated parts one by one", () => {
  expect(flagged('("quikc"), well-knwon, fox—brwon.')).toEqual(["quikc", "knwon", "brwon"]);
});

test("apostrophes stay inside words, curly ones too", () => {
  expect(flagged("don't don’t dont")).toEqual(["dont"]);
});

async function ready(checker: ReturnType<typeof createSpellChecker>) {
  checker.check("");
  if (!checker.ready()) await new Promise<void>((resolve) => checker.subscribe(resolve));
}
const load = async () => ({ aff: "SET UTF-8\n", dic: "5\nthe\nreceive\nreceipt\nrelieve\nQuick\n" });

test("check finds nothing until the dictionary has loaded", async () => {
  const checker = createSpellChecker({ load });
  expect(checker.ready()).toBe(false);
  expect(checker.check("wrold")).toEqual([]);
  await ready(checker);
  expect(checker.check("wrold")).toHaveLength(1);
});

test("a dictionary that fails to load just means no underlines", async () => {
  const checker = createSpellChecker({
    load: async () => {
      throw new Error("missing");
    },
  });
  expect(checker.check("wrold")).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(checker.check("wrold")).toEqual([]);
});

test("suggestions put a neighbor swap first and keep the typed capital", async () => {
  const checker = createSpellChecker({ load });
  await ready(checker);
  expect(checker.suggest("recieve")[0]).toBe("receive");
  expect(checker.suggest("Recieve")[0]).toBe("Receive");
});

test("a sentence-initial capital is not a misspelling of the lowercase word", async () => {
  const checker = createSpellChecker({ load });
  await ready(checker);
  expect(checker.check("The")).toEqual([]);
});

test("add teaches the word for good, its possessive too, and reads it back next time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-spell."));
  const personalFile = join(dir, "sub", "dictionary.txt");
  const first = createSpellChecker({ load, personalFile });
  await ready(first);
  expect(first.check("Zorvik")).toHaveLength(1);
  let heard = 0;
  first.subscribe(() => heard++);
  await first.add("Zorvik's");
  expect(heard).toBe(1);
  expect(first.check("Zorvik Zorvik's")).toEqual([]);
  expect(await readFile(personalFile, "utf8")).toBe("Zorvik\n");

  const second = createSpellChecker({ load, personalFile });
  await ready(second);
  expect(second.check("Zorvik")).toEqual([]);
});

test("ignore lasts for the session and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-spell."));
  const personalFile = join(dir, "dictionary.txt");
  await writeFile(personalFile, "");
  const checker = createSpellChecker({ load, personalFile });
  await ready(checker);
  checker.ignore("zzz");
  expect(checker.check("zzz")).toEqual([]);
  expect(await readFile(personalFile, "utf8")).toBe("");
});

test("a word typed with a curly apostrophe is ignored and added like a straight one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-spell."));
  const personalFile = join(dir, "dictionary.txt");
  const checker = createSpellChecker({ load, personalFile });
  await ready(checker);
  expect(checker.check("y’allz")).toHaveLength(1);
  checker.ignore("y’allz");
  expect(checker.check("y’allz y'allz")).toEqual([]);
  await checker.add("Zed’s");
  expect(checker.check("Zed Zed’s Zed's")).toEqual([]);
  expect(await readFile(personalFile, "utf8")).toBe("Zed\n");
});

test("add still teaches the word for the session when the file cannot be written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tercet-spell."));
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "");
  const checker = createSpellChecker({ load, personalFile: join(blocker, "dictionary.txt") });
  await ready(checker);
  await expect(checker.add("zorp")).rejects.toThrow();
  expect(checker.check("zorp")).toEqual([]);
});

test("the bundled English dictionary catches common slips", async () => {
  const checker = createSpellChecker();
  await ready(checker);
  const text = "Teh wierd definately brwon fox, recieve it. Don't worry about GitHub or camelCase.";
  expect(checker.check(text).map((m) => m.word)).toEqual(["Teh", "wierd", "definately", "brwon", "recieve"]);
  expect(checker.suggest("Teh")).toContain("The");
  expect(checker.suggest("definately")[0]).toBe("definitely");
  expect(checker.suggest("recieve")[0]).toBe("receive");
});
