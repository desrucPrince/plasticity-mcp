// Persistent Plasticity MCP client daemon. Spawns the plasticity-mcp server (stdio) against the
// isolated instance named by PLASTICITY_CDP_URL and exposes it on a loopback HTTP port.
// POST / {"tool":"plasticity_status","args":{}} -> tool result JSON.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PLASTICITY_MCP_ROOT;
const cdp = process.env.PLASTICITY_CDP_URL;
const scratch = process.env.PLD_SCRATCH;
const port = Number(process.env.PLD_PORT || 0);
if (!root || !cdp || !scratch) { console.error("need PLASTICITY_MCP_ROOT, PLASTICITY_CDP_URL, PLD_SCRATCH"); process.exit(2); }
const u = new URL(cdp);
if (u.hostname !== "127.0.0.1" || u.port === "9223" || !u.port) { console.error("refusing CDP url " + cdp); process.exit(2); }
for (const d of ["hist", "own", "strength", "thread", "ref", "refart", "cwd"]) mkdirSync(join(scratch, d), { recursive: true });
const env = {
  ...process.env, PLASTICITY_CDP_URL: cdp, PLASTICITY_AUTO_LAUNCH: "0", PLASTICITY_HUD: "0", PLASTICITY_HUD_NOTIFY: "0",
  PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(scratch, "hist"), PLASTICITY_MCP_STATE_DIR: join(scratch, "own"),
  PLASTICITY_STRENGTH_ROOT: join(scratch, "strength"), PLASTICITY_THREAD_QUALIFICATION_ROOT: join(scratch, "thread"),
  PLASTICITY_REFERENCE_ROOT: join(scratch, "ref"), PLASTICITY_REFERENCE_ARTIFACT_ROOT: join(scratch, "refart"),
  PLASTICITY_STRENGTH_ASSET_ROOT: join(scratch, "cwd"),
};
const sdk = (f) => pathToFileURL(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client", f)).href;
const { Client } = await import(sdk("index.js"));
const { StdioClientTransport } = await import(sdk("stdio.js"));
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "scripts/run-server.ts")], env, cwd: join(scratch, "cwd"), stderr: "pipe" });
transport.stderr?.on("data", (d) => process.stderr.write(d));
const client = new Client({ name: "nano-stand", version: "1" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
let busy = Promise.resolve();
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const run = async () => {
      try {
        if (req.url === "/tools") { res.end(JSON.stringify(tools)); return; }
        const { tool, args } = JSON.parse(body || "{}");
        const r = await client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: 20 * 60 * 1000 });
        res.end(JSON.stringify(r));
      } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message ?? e) })); }
    };
    busy = busy.then(run, run);
  });
});
srv.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ port: srv.address().port, tools: tools.length })));
