export {};
// Prototype 2a: Gemini TTS, streamed. Time to first audio and total, for one sentence.
const key = process.env.GEMINI_API_KEY!;
const model = process.argv[2] ?? "gemini-3.8-flash-lite-tts";
const text = process.argv[3] || "Ooh, how about something cozy, like a farming game? Chat, vote with one or two!";
const out = process.argv[4];
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } } },
    }),
  });
  if (r.status !== 200) { console.log((await r.text()).slice(0, 400)); continue; }
  let first = 0, bytes = 0, chunks = 0, mime = "";
  const pcm: Uint8Array[] = [];
  const dec = new TextDecoder();
  let buf = "";
  for await (const part of r.body!) {
    buf += dec.decode(part, { stream: true }).replace(/\r/g, "");
    let k;
    while ((k = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, k); buf = buf.slice(k + 2);
      const line = ev.split("\n").find(l => l.startsWith("data: "));
      if (!line) continue;
      const j = JSON.parse(line.slice(6));
      if (j.error) { console.log(JSON.stringify(j.error).slice(0, 300)); continue; }
      for (const p of j.candidates?.[0]?.content?.parts ?? []) {
        if (p.inlineData) {
          if (!first) first = performance.now() - t0;
          mime = p.inlineData.mimeType; chunks++;
          const b = Buffer.from(p.inlineData.data, "base64"); bytes += b.length; pcm.push(b);
        }
      }
    }
  }
  console.log(JSON.stringify({ model, status: r.status, firstAudio: Math.round(first), total: Math.round(performance.now() - t0), chunks, bytes, mime, seconds: bytes / 48000 }));
  if (out && i === 0) await Bun.write(out, Buffer.concat(pcm));
}
