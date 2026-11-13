import { expect, test } from "bun:test";
import { transcribeSpeech, speechStatus } from "./speech";

test("speech HTTP uses bearer auth, upstream PCM framing, and trims the transcript", async () => {
  let checked = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      expect(req.headers.get("authorization")).toBe("Bearer fixture-token");
      expect(new URL(req.url).pathname).toBe("/api/voice/transcribe");
      const bytes = new Uint8Array(await req.arrayBuffer());
      const length = new DataView(bytes.buffer).getUint32(0, true);
      const options = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
      expect(options.speechLanguage).toBe("en");
      expect([...bytes.subarray(4 + length)]).toEqual([0, 0, 0, 0]);
      checked = true;
      return Response.json({ text: " hello " });
    },
  });
  try {
    expect(
      await transcribeSpeech(server.url.href, "fixture-token", new Uint8Array(4), {
        speechLanguage: "en",
      }),
    ).toBe("hello");
    expect(checked).toBe(true);
  } finally {
    server.stop(true);
  }
});
test("speech reports auth, missing endpoint, busy and offline errors", async () => {
  let status = 401;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ reason: "speech_busy" }, { status }),
  });
  try {
    await expect(speechStatus(server.url.href, "fixture")).rejects.toMatchObject({ kind: "auth" });
    status = 404;
    await expect(speechStatus(server.url.href, "fixture")).rejects.toMatchObject({ kind: "setup" });
    status = 503;
    await expect(speechStatus(server.url.href, "fixture")).rejects.toMatchObject({ kind: "busy" });
  } finally {
    server.stop(true);
  }
  await expect(speechStatus(server.url.href, "fixture")).rejects.toMatchObject({ kind: "offline" });
});
