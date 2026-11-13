import { homedir } from "node:os";
import { targetKeys } from "./actions";
import { applyLook } from "./client/look";
import { cheatSheet, cheatSheetText, keymap } from "./client/keymap";
import { readOptional } from "./client/platform";
import { loadSettings, SettingsError, settingsDir } from "./client/settings";
import { hostActions, systemHost } from "./portable";

/** `tercet keys`: the cheat sheet for this settings file and machine, the same one `?` shows. */
export async function runKeys(env = process.env, home = homedir()) {
  try {
    const { settings } = await loadSettings(settingsDir(env, home), readOptional, home);
    applyLook(settings);
    const effects = hostActions({ settings, host: systemHost(), writeTerminal: () => {} });
    const sheet = cheatSheet(
      keymap(),
      { shell: !!effects.shell, dictation: !!effects.toggleDictation },
      targetKeys(effects),
    );
    console.log(cheatSheetText(sheet));
    return 0;
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    console.error(`tercet: ${error.message}`);
    return 1;
  }
}
