/** Native Windows helpers. Scripts are fixed code; user data is carried as base64 JSON. */
export function powershell(script: string, data: unknown = null): string[] {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const source = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $value = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))); ${script}`;
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")];
}

const forms = "Add-Type -AssemblyName System.Windows.Forms; ";
export const windowsClipboard = {
  name: "Windows clipboard",
  images: true,
  write: (mime: string) => powershell(forms + (
    mime.startsWith("image/")
      ? "$stream = [IO.MemoryStream]::new(); [Console]::OpenStandardInput().CopyTo($stream); $stream.Position = 0; $image = [Drawing.Image]::FromStream($stream); try { [Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose(); $stream.Dispose() }"
      : "$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); $text = $reader.ReadToEnd(); if ($text.Length) { [Windows.Forms.Clipboard]::SetText($text) } else { [Windows.Forms.Clipboard]::Clear() }"
  )),
  read: (mime: string) => powershell(forms + (
    mime === "image/png"
      ? "$image = [Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 1 }; try { $stream = [IO.MemoryStream]::new(); $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); $out = [Console]::OpenStandardOutput(); $stream.Position = 0; $stream.CopyTo($out); $out.Flush() } finally { $image.Dispose(); if ($stream) { $stream.Dispose() } }"
      : "[Console]::Write([Windows.Forms.Clipboard]::GetText())"
  )),
  types: powershell(forms + "if ([Windows.Forms.Clipboard]::ContainsImage()) { [Console]::WriteLine('image/png') }; if ([Windows.Forms.Clipboard]::ContainsText()) { [Console]::WriteLine('text/plain') }"),
};

export const windowsOpen = (target: string) => powershell(
  "$info = [Diagnostics.ProcessStartInfo]::new(); $info.FileName = $value; $info.UseShellExecute = $true; [void][Diagnostics.Process]::Start($info)", target,
);

export const windowsPicker = (cwd: string) => powershell(forms +
  "$dialog = [Windows.Forms.OpenFileDialog]::new(); $dialog.Multiselect = $true; $dialog.InitialDirectory = $value; try { if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { exit 1 }; foreach ($file in $dialog.FileNames) { [Console]::WriteLine($file) } } finally { $dialog.Dispose() }", cwd,
);

/** Open a separate console without cmd.exe /c or Start-Process's lossy argv joining. */
export function windowsTerminal(cwd: string, argv?: string[]) {
  const child = powershell(argv
    ? "$argv = @($value.argv); Set-Location -LiteralPath $value.cwd; $program = $argv[0]; $rest = @($argv | Select-Object -Skip 1); & $program @rest; exit $LASTEXITCODE"
    : "Set-Location -LiteralPath $value.cwd", { cwd, argv });
  child.splice(child.indexOf("-NonInteractive"), 1);
  if (!argv) child.splice(1, 0, "-NoExit");
  // All variable arguments in ArgumentList are switches or base64 (no shell metacharacters).
  return powershell("Start-Process -FilePath $value[0] -ArgumentList @($value | Select-Object -Skip 1)", child);
}
