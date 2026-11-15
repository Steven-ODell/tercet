import { setIconMode } from "./icons";
import { resolveKeymap, setKeymap } from "./keymap";
import { settingsTargetKeys, type Settings } from "./settings";
import type { Appearance } from "./appearance";
import { setTheme } from "./theme";

/**
 * Applies the settings file's theme, icons and keys. Call once, before the first render.
 * `appearance` is the terminal's light or dark, which only `theme.preset: "auto"` reads.
 */
export function applyLook(
  settings: Pick<Settings, "theme" | "icons" | "keys" | "targets">,
  appearance?: Appearance | null,
) {
  setTheme(settings.theme, appearance);
  setIconMode(settings.icons);
  setKeymap(resolveKeymap(settings.keys, settingsTargetKeys(settings)));
}
