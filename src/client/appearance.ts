import { DA1_QUERY, type TtyInput } from "./media";

/** Asks the terminal for its background color (OSC 11). Replies come in order, so DA1 ends the wait. */
export const OSC11_QUERY = "\x1b]11;?\x1b\\";

export type Appearance = "dark" | "light";

/**
 * The background color in an OSC 11 reply, as 0-255 RGB. Terminals answer `rgb:RRRR/GGGG/BBBB`
 * with 1 to 4 hex digits per channel, or `#rrggbb`.
 */
export function parseBackground(text: string): [number, number, number] | null {
  const reply = /\x1b\]11;(?:rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})|#([0-9a-f]{6}))/i.exec(
    text,
  );
  if (!reply) return null;
  if (reply[4]) {
    const n = parseInt(reply[4], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const channel = (digits: string) => Math.round((parseInt(digits, 16) / (16 ** digits.length - 1)) * 255);
  return [channel(reply[1]!), channel(reply[2]!), channel(reply[3]!)];
}

/** Dark when the background's perceived brightness is under half. */
export function appearanceOf([r, g, b]: [number, number, number]): Appearance {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5 ? "dark" : "light";
}

/**
 * COLORFGBG ("15;0": foreground;background as ANSI indexes), which rxvt-family terminals and some
 * others set. Indexes 0-6 and 8 are dark backgrounds, 7 and 9-15 light.
 */
export function appearanceFromEnv(env: Record<string, string | undefined>): Appearance | null {
  const last = (env.COLORFGBG ?? "").split(";").pop() ?? "";
  const index = /^\d{1,2}$/.test(last) ? Number(last) : -1;
  if (index < 0 || index > 15) return null;
  return index <= 6 || index === 8 ? "dark" : "light";
}

/** Sends the OSC 11 query and DA1, reads until DA1 arrives or `timeoutMs` passes. */
export function queryBackground(
  input: TtyInput,
  output: { write(bytes: string): unknown },
  timeoutMs = 300,
): Promise<[number, number, number] | null> {
  const raw = input.setRawMode?.bind(input);
  if (!input.isTTY || !raw) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = "";
    const finish = () => {
      clearTimeout(timer);
      input.off("data", onData);
      raw(false);
      input.pause();
      resolve(parseBackground(text));
    };
    const onData = (chunk: Buffer | string) => {
      text += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      if (/\x1b\[\?[\d;]*c/.test(text)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    raw(true);
    input.on("data", onData);
    input.resume();
    output.write(OSC11_QUERY + DA1_QUERY);
  });
}

/** The terminal's appearance: its OSC 11 reply, else COLORFGBG, else null (the caller picks dark). */
export async function detectAppearance(
  input: TtyInput,
  output: { write(bytes: string): unknown },
  env: Record<string, string | undefined>,
): Promise<{ appearance: Appearance | null; source: string }> {
  const background = await queryBackground(input, output);
  if (background) return { appearance: appearanceOf(background), source: "terminal background" };
  const fromEnv = appearanceFromEnv(env);
  return fromEnv
    ? { appearance: fromEnv, source: "COLORFGBG" }
    : { appearance: null, source: "no answer from the terminal" };
}
