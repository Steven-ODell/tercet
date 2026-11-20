import { homedir } from "node:os";
import { hasDictation, targetKeys } from "./actions";
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
      {
        shell: !!effects.shell,
        dictation: hasDictation(effects),
        screenshot: !!effects.captureRegion,
        attach: !!effects.pickFiles,
        spell: !!effects.spell,
      },
      targetKeys(effects),
    );
    console.log(cheatSheetText(sheet, true));
    console.log('\nRebind with the name in the last column, e.g. "keys": { "palette": "Ctrl+k" }.');
    return 0;
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    console.error(`tercet: ${error.message}`);
    return 1;
  }
}
