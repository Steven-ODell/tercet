import type { Actions } from "../actions";

/**
 * What `--read-only` does with each host action. The mapped type makes a new action a type
 * error until it is classified here. `block` keeps the button (so the screen looks the same) but
 * fails; `drop` removes it; `allow` keeps it working (local, changes nothing).
 */
export const READ_ONLY_POLICY: { [K in keyof Required<Actions>]: "block" | "drop" | "allow" } = {
  shell: "block",
  openThread: "block",
  pasteClipboard: "block",
  pasteImage: "block",
  pickFiles: "block",
  toggleDictation: "block",
  record: "block",
  editor: "block",
  // Checks words locally; the personal dictionary is a file on this machine, not the server.
  spell: "allow",
  copy: "allow",
  targets: "allow",
  copyTo: "block",
  tmux: "block",
  run: "block",
  send: "block",
  copyImage: "block",
  copyImageTo: "block",
  openImage: "block",
  // Image bytes and media details come from the server with the token; read-only shows names.
  loadImage: "drop",
  openPage: "block",
  openUrl: "block",
  openPath: "block",
  play: "block",
  playHere: "block",
  probeMedia: "allow",
  inspectMedia: "drop",
  openMedia: "block",
};

export const READ_ONLY_ERROR = "Read-only: action blocked";

/** Applies the policy in place. Only actions that exist are blocked: no extra buttons appear. */
export function blockWrites(effects: Actions) {
  const blocked = async () => {
    throw new Error(READ_ONLY_ERROR);
  };
  const target = effects as unknown as Record<string, unknown>;
  for (const [name, rule] of Object.entries(READ_ONLY_POLICY)) {
    if (rule === "drop") target[name] = undefined;
    else if (rule === "block" && target[name]) target[name] = blocked;
  }
  return effects;
}
