import { expect, test } from "bun:test";
import { findT3, type T3Host } from "./t3-command";

const host = (over: Partial<T3Host> & { files?: string[]; path?: Record<string, string> }): T3Host => ({
  platform: "linux",
  env: {},
  home: "/home/u",
  which: (name) => over.path?.[name] ?? null,
  exists: (path) => !!over.files?.includes(path),
  ...over,
});

test("PATH wins over usual folders", () => {
  const found = findT3(undefined, host({ path: { t3: "/bin/t3" }, files: ["/home/u/.local/bin/t3"] }));
  expect(found).toEqual({ found: true, path: "/bin/t3", via: "PATH" });
});

test("a path setting is used when the file exists and refused when it does not", () => {
  expect(findT3("/x/t3", host({ files: ["/x/t3"] }))).toEqual({ found: true, path: "/x/t3", via: "setting" });
  const missing = findT3("/x/t3", host({}));
  expect(missing.found).toBe(false);
});

const win = { platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" };

test("finds t3.cmd in the npm folder on Windows", () => {
  const cmd = "C:\\Users\\u\\AppData\\Roaming\\npm\\t3.cmd";
  expect(findT3(undefined, host({ ...win, files: [cmd] }))).toEqual({ found: true, path: cmd, via: "usual folder" });
});

test("a missing t3 on Windows says to set server.t3Command and names t3.cmd", () => {
  const found = findT3(undefined, host(win));
  expect(found.found).toBe(false);
  if (!found.found) {
    expect(found.message).toContain("server.t3Command");
    expect(found.message).toContain("t3.cmd");
    expect(found.message).toContain("C:\\Users\\u\\AppData\\Roaming\\npm");
  }
});

test("a .ps1 shim is never picked", () => {
  const ps1 = "C:\\Users\\u\\AppData\\Roaming\\npm\\t3.ps1";
  expect(findT3(undefined, host({ ...win, files: [ps1] })).found).toBe(false);
});
