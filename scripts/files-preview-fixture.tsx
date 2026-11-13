// Standalone, offline Files panel on a real directory: bun scripts/files-preview-fixture.tsx [dir]. Ctrl+c exits.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useTerminalDimensions } from "@opentui/react";
import { FilesPanel, type FilesApi } from "../src/client/files";
import { loadPreviewImage } from "../src/client/image-preview-source";
import { kittyStdout } from "../src/kitty-output";

const root = NodePath.resolve(process.argv[2] ?? ".");
const api = {
  list: async ({ directoryPath = "" }: { directoryPath?: string }) => ({
    entries: (await NodeFSP.readdir(NodePath.join(root, directoryPath), { withFileTypes: true }))
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => ({
        path: NodePath.join(directoryPath, e.name),
        kind: e.isDirectory() ? "directory" : "file",
      })),
    truncated: false,
  }),
  read: async ({ relativePath }: { relativePath: string }) => {
    const contents = await NodeFSP.readFile(NodePath.join(root, relativePath), "utf8");
    if (contents.includes("\0")) throw new Error("binary");
    return { relativePath, contents: contents.slice(0, 200_000), truncated: false };
  },
  find: async () => ({ entries: [], truncated: false }),
  search: async () => ({ matches: [], truncated: false }),
} as unknown as FilesApi;
const renderer = await createCliRenderer({
  stdout: process.env.TMUX ? kittyStdout() : process.stdout,
  remote: false,
  exitOnCtrlC: true,
  useMouse: true,
  kittyImageTransport: "zlib",
});
const effects = {
  copy() {},
  loadImage: (source: string, cwd?: string) =>
    loadPreviewImage(source, cwd, async () => {
      throw new Error("offline fixture");
    }),
};
function Fixture() {
  const { width, height } = useTerminalDimensions();
  return (
    <box width={Math.min(width, 48)} height={height} border borderStyle="rounded" title="Files">
      <FilesPanel
        api={api}
        cwd={root}
        enabled
        effects={effects}
        height={height}
        width={Math.min(width, 48) - 2}
        close={() => renderer.destroy()}
      />
    </box>
  );
}
createRoot(renderer).render(<Fixture />);
