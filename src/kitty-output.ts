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
    return Buffer.from(output, "latin1");
  }
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
