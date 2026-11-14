import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipboardChain, editorArgv, externalEditorChoice, openerChain, pickerChain, runArgs, systemHost, type Host } from "./portable";
import { defaultSettings, parseSettings } from "./client/settings";
import { EditorSession } from "./embedded-editor";
import { resolveMediaTarget } from "./client/image-open";
import { loadPreviewImage } from "./client/image-preview-source";
import { powershell, windowsOpen, windowsPicker, windowsTerminal } from "./windows";

const settings = defaultSettings();
const host: Host = { platform: "win32", env: {}, which: (name) => name === "powershell.exe" ? name : null };
const scriptOf = (argv: string[]) => Buffer.from(argv.at(-1)!, "base64").toString("utf16le");
const hostile = 'C:\\Users\\Zoë Smith\\work; $env:PATH & "quoted"\\file.txt';

test("Windows native actions are detected without Unix desktop utilities", () => {
  expect(clipboardChain(settings, host).read?.images).toBe(true);
  expect(clipboardChain(settings, host).write?.name).toBe("Windows clipboard");
  expect(openerChain(settings, host)?.name).toBe("Windows opener");
  expect(pickerChain(settings, host)?.name).toBe("Windows file dialog");
  expect(clipboardChain(settings, { ...host, env: { SSH_CONNECTION: "remote" } }).read).toBeUndefined();
});

test("Windows paths and shell characters are encoded as data, never executable source", () => {
  for (const argv of [windowsOpen(hostile), windowsPicker(hostile), windowsTerminal(hostile, ["nvim.exe", hostile])]) {
    const source = scriptOf(argv);
    expect(source).not.toContain(hostile);
    expect(argv).toContain("-EncodedCommand");
  }
  const encoded = scriptOf(windowsOpen(hostile)).match(/FromBase64String\('([^']+)'\)/)![1]!;
  expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toBe(hostile);
});

test("Windows EDITOR preserves backslashes and distinguishes GUI and terminal executables", () => {
  expect(editorArgv('"C:\\Program Files\\Neovim\\bin\\nvim.exe" --clean', "win32")).toEqual(["C:\\Program Files\\Neovim\\bin\\nvim.exe", "--clean"]);
  const configured = defaultSettings();
  configured.launchers.editor = ["C:\\Program Files\\Neovim\\bin\\nvim.exe", "--", "{path}"];
  expect(externalEditorChoice(configured, host)?.mode).toBe("windows");
  configured.launchers.editor = ["C:\\Program Files\\Microsoft VS Code\\Code.exe", "{path}"];
  expect(externalEditorChoice(configured, host)?.mode).toBe("direct");
});

test("Windows command templates reject interpolation into cmd and PowerShell source", () => {
  for (const command of [["cmd.exe", "/c", "echo {text}"], ["powershell.exe", "-Command", "Write-Output {text}"], ["C:\\Windows\\System32\\cmd.exe", "/k", "{text}"], ["pwsh", "-EncodedCommand", "{text}"], ["powershell.exe", "-Com", "{text}"], ["pwsh", "-ec", "{text}"]]) {
    expect(() => parseSettings(JSON.stringify({ commands: { run: command } }), "settings.json", { home: "C:/Users/test", dir: "C:/Users/test/.config/tercet" })).toThrow("unsafe");
  }
});

// These run on a real Windows runner. No clipboard, GUI or desktop state is touched on Linux.
test.skipIf(process.platform !== "win32")("native PowerShell passes hostile Unicode argv and text over UTF-8 stdin", async () => {
  const native = systemHost();
  const text = 'line one\r\nZoë 界 😀\r\n';
  const output = await runArgs(native, powershell("[Console]::Write($value); $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); [Console]::Write($reader.ReadToEnd())", hostile), { stdin: text, capture: true });
  expect(Buffer.from(output).toString("utf8")).toBe(hostile + text);
});

test.skipIf(process.platform !== "win32")("Windows clipboard round-trips Unicode text and PNG", async () => {
  const native = systemHost();
  const tool = clipboardChain(settings, native).write!;
  const text = 'Tercet Unicode 界 😀\r\nsecond line';
  await runArgs(native, tool.write("text/plain", {}), { stdin: text });
  expect(Buffer.from(await runArgs(native, tool.read("text/plain", {}), { capture: true })).toString("utf8")).toBe(text);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z/AfAAQAAf8iCjrwAAAAAElFTkSuQmCC", "base64");
  await runArgs(native, tool.write("image/png", {}), { stdin: png });
  const image = await runArgs(native, tool.read("image/png", {}), { capture: true });
  expect(Buffer.from(image).subarray(0, 8)).toEqual(png.subarray(0, 8));
});

test.skipIf(process.platform !== "win32")("native drive paths with spaces load attachments and previews", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tercet Windows 界 "));
  try {
    const path = join(cwd, "a b.png");
    await writeFile(path, "fixture");
    expect((await resolveMediaTarget(path, cwd, undefined, async () => "unused")).target).toBe(path);
    expect(Buffer.from(await loadPreviewImage(path, cwd, async () => "unused")).toString()).toBe("fixture");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("embedded terminal handles input, resize, Unicode paths, save and exit on the native PTY", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tercet-pty-"));
  const path = join(cwd, "saved 界.txt");
  const program = `process.stdin.setEncoding('utf8'); process.stdin.on('data', async (data) => { if (data.includes('save')) { await Bun.write(process.argv[1], 'saved 界'); console.log('SAVED'); process.exit(0); } }); console.log('READY');`;
  let session: EditorSession | undefined;
  try {
    session = new EditorSession(cwd, path, [process.execPath, "-e", program, path]);
    const deadline = Date.now() + 10_000;
    while (!Array.from({ length: session.screen.rows }, (_, i) => session!.screen.buffer.active.getLine(i)?.translateToString()).join("").includes("READY")) {
      if (Date.now() > deadline) throw new Error("PTY did not start");
      await Bun.sleep(25);
    }
    session.resize(100, 30);
    expect(session.screen.cols).toBe(100);
    session.write("save\r");
    expect(await Promise.race([session.child.exited, Bun.sleep(10_000).then(() => { throw new Error("PTY did not exit"); })])).toBe(0);
    expect(await readFile(path, "utf8")).toBe("saved 界");
  } finally { session?.dispose(); await rm(cwd, { recursive: true, force: true }); }
}, 25_000);


test.skipIf(process.platform !== "win32" && !process.env.TERCET_PWSH)("PowerShell parses every generated script and the Windows installer", async () => {
  const clipboard = clipboardChain(settings, host).write!;
  const scripts = [windowsOpen(hostile), windowsPicker(hostile), windowsTerminal(hostile, ["nvim.exe", hostile]), windowsTerminal(hostile), clipboard.write("text/plain", {}), clipboard.write("image/png", {}), clipboard.read("text/plain", {}), clipboard.read("image/png", {}), clipboard.types!].map(scriptOf);
  scripts.push(await readFile(new URL("../install.ps1", import.meta.url), "utf8"));
  const argv = powershell("foreach ($source in $value) { $tokens = $null; $errors = $null; [void][Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors); if ($errors.Count) { throw ($errors | Out-String) } }; [Console]::Write('parsed')", scripts);
  if (process.env.TERCET_PWSH) { argv[0] = process.env.TERCET_PWSH; argv.splice(argv.indexOf("-Sta"), 1); }
  expect(Buffer.from(await runArgs(systemHost(), argv, { capture: true })).toString("utf8")).toBe("parsed");
});
