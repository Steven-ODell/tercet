// Private tmux capture entry: the real frame on the sidebar fixture, no server or token.
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import * as Effect from "effect/Effect";
import { createClient } from "../src/client/runtime";
import { AppFrame } from "../src/client/frame";
import { fixtureNow, flatFixture } from "../src/client/sidebar-fixture";

const client = createClient(
  {
    readToken: () => Effect.succeed("fake"),
    issueToken: () => Effect.die("no issuance"),
    wake: () => Effect.void,
    pause: () => Effect.never,
    follow: () => Effect.never,
  },
  false,
  () => Date.parse(fixtureNow),
);
client.registry.set(client.snapshot, flatFixture());
client.registry.set(client.status, "live");
createRoot(await createCliRenderer({ exitOnCtrlC: true })).render(<AppFrame client={client} />);
