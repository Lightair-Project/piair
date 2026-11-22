export {};
// The director's timing: how often PiAir speaks up for each chattiness, that it answers its name
// even when quiet, and that it waits while the streamer talks. Faux model (no network).
const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");

async function scenario(name: string, chattiness: number, steps: (send: (m: object) => void, t0: number) => Promise<void>, seconds: number) {
  const dir = mkdtempSync("/tmp/piair-dir-");
  mkdirSync(`${dir}/PiAir`, { recursive: true });
  writeFileSync(`${dir}/PiAir/settings.json`, JSON.stringify({ voice: { vendor: "none" }, behaviour: { chattiness } }));
  const child = Bun.spawn(["bun", "src/main.ts"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, PIAIR_FAUX: "1" } });
  const send = (m: object) => { child.stdin.write(JSON.stringify(m) + "\n"); child.stdin.flush(); };
  const turns: number[] = [];
  let t0 = 0;
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  (async () => {
    const dec = new TextDecoder(); let buf = "";
    for await (const c of child.stdout) {
      buf += dec.decode(c, { stream: true }); let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
        if (m.t === "call") send({ t: "reply", id: m.id, result: m.method === "secret.get" ? { value: null } : {} });
        if (m.t === "ready") ready();
        if (m.t === "transcript" && m.role === "piair") turns.push(Math.round((performance.now() - t0) / 100) / 10);
      }
    }
  })();
  send({ t: "hello", data_dir: dir });
  await isReady;
  t0 = performance.now();
  await Promise.race([steps(send, t0), Bun.sleep(seconds * 1000)]);
  await Bun.sleep(Math.max(0, seconds * 1000 - (performance.now() - t0)));
  child.kill();
  console.log(`${name}: PiAir spoke at ${JSON.stringify(turns)} s`);
}

const chat = (send: (m: object) => void, i: number, text: string) =>
  send({ t: "chat", event: { kind: { type: "message" }, platform: "twitch", user: { id: `v${i}`, display_name: `viewer${i}` }, text } });
const steady = (texts: (i: number) => string) => async (send: (m: object) => void) => {
  for (let i = 0; i < 9; i++) { chat(send, i, texts(i)); await Bun.sleep(3000); }
};
const plain = (i: number) => ["this game looks fun", "lol nice jump", "what's the music", "gg", "hello everyone", "that was close", "love the colours", "first time here", "wow"][i]!;

await scenario("quiet, plain chat every 3 s", 0, steady(plain), 28);
await scenario("chatty, plain chat every 3 s", 3, steady(plain), 28);
await scenario("lively, plain chat every 3 s", 2, steady(plain), 28);
await scenario("quiet, chat says its name", 0, async (send) => { await Bun.sleep(2000); chat(send, 1, "Pi what do you think of this level?"); }, 10);
await scenario("normal, name while the streamer talks 0–6 s", 1, async (send) => {
  send({ t: "streamer", speaking: true });
  await Bun.sleep(1000);
  chat(send, 1, "Pi are you there?");
  await Bun.sleep(5000);
  send({ t: "streamer", speaking: false });
}, 12);
