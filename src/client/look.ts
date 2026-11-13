import { setIconMode } from "./icons";
import { resolveKeymap, setKeymap } from "./keymap";
import { settingsTargetKeys, type Settings } from "./settings";
import { setTheme } from "./theme";

/** Applies the settings file's theme, icons and keys. Call once, before the first render. */
export function applyLook(settings: Pick<Settings, "theme" | "icons" | "keys" | "targets">) {
  setTheme(settings.theme);
  setIconMode(settings.icons);
  setKeymap(resolveKeymap(settings.keys, settingsTargetKeys(settings)));
}
