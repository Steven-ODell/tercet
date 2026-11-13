// Private tmux proof of the production transcript selection -> Actions -> OSC 52 path.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { terminalActions } from "../actions";
import { TranscriptViewport } from "../client/transcript-viewport";
const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true });
createRoot(renderer).render(
  <TranscriptViewport
    items={[{ id: "copy", kind: "assistant", text: "Drag this text to copy" }]}
    width={120}
    height={40}
    effects={terminalActions((bytes) => process.stdout.write(bytes))}
  />,
);
