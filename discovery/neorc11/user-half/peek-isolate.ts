// Read-only: visible vs hidden bodies, groups, selection, Plasticity's isolate state, and a raw window capture.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
import { openSession } from "../../mcp-client.ts";
const s = await openSession();
try {
  const all: any[] = [];
  const first = await s.raw("plasticity_status", { bodyLimit: 200 }); all.push(...first.bodies);
  for (let n = first.bodyPagination?.nextOffset; n != null;) { const p = await s.raw("plasticity_status", { bodyLimit: 200, bodyOffset: n, expectedRevision: first.revision }); all.push(...p.bodies); n = p.bodyPagination?.nextOffset; }
  const vis = all.filter((b) => b.visible !== false);
  console.log("doc", first.title, "undo", first.undoDepth, "bodies", all.length, "visible", vis.length, "hidden", all.length - vis.length);
  for (const b of vis.slice(0, 40)) console.log("  VIS", b.id, b.name, b.type, b.boundsMm.min.map(Math.round).join(","), "→", b.boundsMm.max.map(Math.round).join(","));
  const sel = await s.raw("plasticity_current_selection");
  console.log("selection", JSON.stringify({ bodies: sel.bodyIds, faces: (sel.faces ?? []).length, edges: (sel.edges ?? []).length, curves: sel.curveIds }).slice(0, 400));
} finally { await s.close(); }
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const rt = await PlasticityRuntime.connect(target!);
try {
  console.log("isolate", JSON.stringify(await rt.read(`async function () {
    const keys = Object.keys(this).filter(k => /isolat|hidden|visib/i.test(k));
    const out = { editorKeys: keys };
    for (const k of ['isolated', 'isolation', 'isolate']) if (this[k] !== undefined) out[k] = String(this[k]?.constructor?.name ?? this[k]);
    const db = this.db;
    out.dbKeys = Object.keys(db ?? {}).filter(k => /isolat|hidden|visib/i.test(k));
    const scene = db?.scene ?? this.scene;
    out.sceneKeys = scene ? Object.keys(scene).filter(k => /isolat|hidden|visib/i.test(k)) : [];
    return out;
  }`)).slice(0, 1200));
} finally { rt.close(); }
const cdp = await CdpClient.connect(target!.webSocketDebuggerUrl);
try { await writeFile(resolve("discovery/neorc11/user-half/review-v5/isolated-as-found.png"), Buffer.from(await cdp.captureScreenshot(), "base64")); } finally { cdp.close(); }
