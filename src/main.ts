// PiAir: Lightair's AI co-host (piair), and its hearing for one mixer track (`piair hear`).
// One binary, two jobs: each is imported only when it runs.
if (process.argv[2] === "hear") await import("./hear.ts");
else await import("./cohost.ts");

export {};
