// Read-only: records the isolated document's starting state (undo depth, bodies) before any scenario.
import { openInProcess, save, status } from "./lib.ts";
const h = await openInProcess();
try {
  const st = await status(h);
  const info = await h.client.callTool({ name: "plasticity_body_info", arguments: { id: st.bodies[0]!.id } });
  const text = (info.content as Array<{ text: string }>)[0]!.text;
  save(process.argv[2] ?? "start-state.json", { measuredAt: new Date().toISOString(), title: st.title, targetId: st.targetId, undoDepth: st.undoDepth, redoDepth: st.redoDepth, bodies: st.bodies, bodyInfoSampleBytes: Buffer.byteLength(text), bodyInfoSample: JSON.parse(text) });
  console.log(JSON.stringify({ title: st.title, undoDepth: st.undoDepth, redoDepth: st.redoDepth, bodies: st.bodies.map((b) => [b.id, b.name, b.boundsMm]) }));
} finally {
  await h.close();
}
