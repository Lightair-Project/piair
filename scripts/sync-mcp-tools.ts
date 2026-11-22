// Copies Lightair's MCP tool table (lightair-core/crates/lightair-remote/src/mcp.rs, `TOOLS`) into
// src/tools/lightair-tools.json, so PiAir's Lightair tools are the same set MCP clients get.
// Run: bun scripts/sync-mcp-tools.ts [path/to/mcp.rs]
const path = process.argv[2] ?? new URL("../../lightair-core/crates/lightair-remote/src/mcp.rs", import.meta.url).pathname;
const src = await Bun.file(path).text();
const table = src.slice(src.indexOf("const TOOLS: &[Tool] = &["));
const body = table.slice(0, table.indexOf("\n];"));
const str = (s: string) => {
  // a Rust string literal: "..." or r#"..."#
  const raw = /^r#"([\s\S]*?)"#/.exec(s);
  if (raw) return raw[1];
  const q = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  return q ? JSON.parse(`"${q[1]}"`) : undefined;
};
const tools: any[] = [];
for (const block of body.split(/\n\s*Tool \{/).slice(1)) {
  const field = (name: string) => {
    const m = new RegExp(`\\b${name}:\\s*`).exec(block);
    return m ? str(block.slice(m.index + m[0].length)) : undefined;
  };
  const req = /required:\s*&\[([^\]]*)\]/.exec(block)?.[1] ?? "";
  tools.push({
    name: field("name"),
    method: field("method"),
    title: field("title"),
    description: field("description"),
    properties: JSON.parse(field("properties") ?? "{}"),
    required: [...req.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    readOnly: /read_only:\s*true/.test(block),
  });
}
await Bun.write(new URL("../src/tools/lightair-tools.json", import.meta.url).pathname, JSON.stringify(tools, null, 1) + "\n");
console.log(`${tools.length} tools`);
