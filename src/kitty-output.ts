import { Writable } from "node:stream";

/** Keep tmux's virtual cursor and the outer terminal's Kitty cursor in agreement.
 * OpenTUI 0.8.3 emits CUP outside passthrough; tmux may not repaint it before
 * forwarding a placement. Repeat CUP inside the same DCS as that placement.
 */
export class KittyPlacementOutput {
  private pending = "";
  private cup = "";
  push(bytes: Uint8Array): Buffer {
    this.pending += Buffer.from(bytes).toString("latin1");
    let output = "";
    while (this.pending.length) {
      const s = this.pending;
      let end = 1;
      if (s[0] === "\x1b") {
        if (s.length < 2) break;
        if (s[1] === "[") {
          const final = /[@-~]/.exec(s.slice(2));
          if (!final) break;
          end = final.index + 3;
        } else if (s[1] === "P" || s[1] === "]") {
          const tmux = s.startsWith("\x1bPtmux;");
          end = 2;
          let complete = false;
          while (end < s.length) {
            if (s[1] === "]" && s[end] === "\x07") {
              end++;
              complete = true;
              break;
            }
            if (s[end] === "\x1b") {
              if (end + 1 >= s.length) break;
              if (tmux && s[end + 1] === "\x1b") {
                end += 2;
                continue;
              }
              if (s[end + 1] === "\\") {
                end += 2;
                complete = true;
                break;
              }
            }
            end++;
          }
          if (!complete) break;
        } else end = 2;
      } else {
        const escape = s.indexOf("\x1b");
        end = escape < 0 ? s.length : escape;
      }
      let token = s.slice(0, end);
      this.pending = s.slice(end);
      if (/^\x1b\[\d+;\d+H$/.test(token)) {
        output += this.cup;
        this.cup = token;
        continue;
      }
      if (this.cup && token.startsWith("\x1bPtmux;\x1b\x1b_Ga=p,")) {
        token = "\x1bPtmux;" + this.cup.replaceAll("\x1b", "\x1b\x1b") + token.slice(7);
      }
      output += this.cup + token;
      this.cup = "";
    }
    // CUP alone at a write boundary must remain ordered with the next placement.
    return Buffer.from(withoutReplacedDeletes(output), "latin1");
  }
}

const PASSTHROUGH_GRAPHICS =
  /\x1bPtmux;(?:\x1b\x1b\[\d+;\d+H)?\x1b\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\x1b\\\x1b\\/g;

/**
 * OpenTUI moves a placement by deleting it (`a=d,d=i`) and placing it again (`a=p`, same `i` and
 * `p`). Behind tmux the outer terminal can draw a frame between the two, so a scrolling image
 * flashes as an empty hole (the bare background, or the wallpaper on a translucent terminal).
 * Kitty replaces a placement that reuses its image and placement ids, so the delete is dropped
 * when the same write places it again. A delete with no placement after it stays.
 */
export function withoutReplacedDeletes(output: string) {
  if (!output.includes("a=d,d=i,")) return output;
  const keys = (params: string) => Object.fromEntries(params.split(",").map((kv) => kv.split("=")));
  const graphics = [...output.matchAll(PASSTHROUGH_GRAPHICS)].map((m) => ({
    index: m.index,
    length: m[0].length,
    keys: keys(m[1]!),
  }));
  let result = output;
  for (const [n, g] of [...graphics.entries()].reverse()) {
    if (g.keys.a !== "d" || g.keys.d !== "i" || !g.keys.i) continue;
    const replaced = graphics
      .slice(n + 1)
      .some(
        (later) =>
          later.keys.a === "p" &&
          later.keys.i === g.keys.i &&
          (later.keys.p ?? "") === (g.keys.p ?? ""),
      );
    if (replaced) result = result.slice(0, g.index) + result.slice(g.index + g.length);
  }
  return result;
}

export function kittyStdout(): NodeJS.WriteStream {
  const placement = new KittyPlacementOutput();
  const write = process.stdout.write.bind(process.stdout);
  const stream = new Writable({
    write(bytes: Buffer, _encoding, done) {
      const output = placement.push(bytes);
      if (output.length) write(output, done);
      else done();
    },
  });
  Object.defineProperties(stream, {
    columns: { get: () => process.stdout.columns },
    rows: { get: () => process.stdout.rows },
    isTTY: { get: () => process.stdout.isTTY },
  });
  return stream as NodeJS.WriteStream;
}

/** Kitty "delete all placements" in tmux passthrough; image data stays uploaded for the repaint. */
export const KITTY_CLEAR_PLACEMENTS = "\x1bPtmux;\x1b\x1b_Ga=d,d=a,q=2\x1b\x1b\\\x1b\\";
/** The same delete sent straight to a Kitty-graphics terminal (outside tmux). */
export const KITTY_CLEAR_DIRECT = "\x1b_Ga=d,d=a,q=2\x1b\\";

/**
 * Placements live in the outer terminal, which cannot tell that tmux switched sessions, so tercet's
 * images would stay drawn over the next session. A hidden pane's passthrough is dropped, so the
 * delete must go out before the switch. `repaint` runs when the pane regains focus (or at once if
 * the switch failed) so the images come back.
 */
export function clearKittyBeforeSwitch(
  out: { write(bytes: string, done: () => void): unknown },
  repaint: () => void,
  onFocus: (listener: () => void) => void,
) {
  let cleared = false;
  const restore = () => {
    if (!cleared) return;
    cleared = false;
    repaint();
  };
  onFocus(restore);
  return <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      await new Promise<void>((done) => out.write(KITTY_CLEAR_PLACEMENTS, () => done()));
      cleared = true;
      try {
        return await run(...args);
      } catch (error) {
        restore();
        throw error;
      }
    };
}
