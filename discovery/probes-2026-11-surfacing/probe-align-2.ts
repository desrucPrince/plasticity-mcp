// Item 4, step 2: Surface Align factory-direct inside AlignEdgeCommand (harness drive()).
// factory = new <AlignAndRebuildFactory|AlignEdgeFactory>(editor).resource(command); factory.pairs = [moveEdge, referenceEdge];
// continuity per reference edge (setContinuityForEdge) or global; commit. Read-back: B's edge position, then join A+B
// and run plasticity_analyze_surface_continuity on the joined edge. Each trial undoes back to the fixture.
import { connect, save, errText, drive, TRACE, TRACED_COMMIT, lastReads } from "./harness.ts";
import { startMcp, call, status, undoTo, tryCall } from "./mcp.ts";
import { rev, info } from "./fixtures.ts";
import { alignSheets } from "./fixtures-align.ts";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const out: any = { startUndo: start.undoDepth, trials: {} };
const only = process.argv[2]?.split(",");
try {
  const fx = await alignSheets(client);
  out.fixture = { sheetA: fx.sheetA, sheetB: fx.sheetB, edgeA: fx.edgeA.id, edgeB: fx.edgeB.id, edgeBcenter: fx.edgeB.centerMm };
  const fixtureDepth = (await status(client)).undoDepth;
  out.fixtureDepth = fixtureDepth;
  // Before: separate-body continuity is not measurable by the shipped tool; join is refused while there is a gap.
  out.joinBefore = await tryCall(client, "plasticity_join_sheets", { ids: [fx.sheetA, fx.sheetB], intent: "probe join before", revision: await rev(client) });
  await undoTo(client, fixtureDepth);

  const trials: Record<string, { factory: string; continuity: string; mode: "perEdge" | "global"; extra?: string }> = {
    rebuild_G0: { factory: "AlignAndRebuildFactory", continuity: "G0", mode: "perEdge" },
    rebuild_G1: { factory: "AlignAndRebuildFactory", continuity: "G1", mode: "perEdge" },
    rebuild_G2: { factory: "AlignAndRebuildFactory", continuity: "G2", mode: "perEdge" },
    plain_G1: { factory: "AlignEdgeFactory", continuity: "G1", mode: "perEdge" },
    rebuild_G2_global: { factory: "AlignAndRebuildFactory", continuity: "G2", mode: "global" },
  };
  for (const [name, t] of Object.entries(trials)) {
    if (only && !only.includes(name)) continue;
    const trial: any = { ...t };
    try {
      trial.commit = await drive(runtime, {
        command: { binding: "AlignEdgeCommand" },
        factory: t.factory,
        bindings: ["ContinuityType"],
        args: { a: { bodyId: fx.sheetA, edgeId: fx.edgeA.id }, b: { bodyId: fx.sheetB, edgeId: fx.edgeB.id }, continuity: t.continuity, mode: t.mode },
        setup: `${process.env.NO_TRACE ? "" : TRACE}
          // Edge objects as the selection hands them to the command (raw high.edges.get(i) objects fail in the pairs setter).
          const sel = editor.selection.selected;
          sel.removeAll();
          sel.add(edgeOf(args.b.bodyId, args.b.edgeId)); sel.add(edgeOf(args.a.bodyId, args.a.edgeId));
          const picked = [...sel.edges];
          sel.removeAll();
          const mov = picked.find(e => e.versionId === args.b.edgeId), ref = picked.find(e => e.versionId === args.a.edgeId);
          globalThis.__probeEdgeInfo = { same: mov === edgeOf(args.b.bodyId, args.b.edgeId), movKeys: Object.keys(mov), rawKeys: Object.keys(edgeOf(args.b.bodyId, args.b.edgeId)) };
          factory.pairs = [mov, ref];
          if (args.mode === 'global') factory.continuity = B.ContinuityType[args.continuity];
          else factory.setContinuityForEdge(ref, B.ContinuityType[args.continuity]);
          globalThis.__probeFactoryState = { edgeInfo: globalThis.__probeEdgeInfo, continuity: factory.continuity, edge2continuity: [...factory.edge2continuity.entries()].map(([k, v]) => [typeof k === 'object' ? (k.constructor?.name + ':' + (k.entityId ?? '')) : k, v]), targets: (factory.targets ?? []).length };`,
        commit: process.env.NO_TRACE ? undefined : TRACED_COMMIT,
        timeoutMs: 60000,
      });
      trial.reads = await lastReads(runtime);
      trial.factoryState = await runtime.read(`function () { const s = globalThis.__probeFactoryState; delete globalThis.__probeFactoryState; return s ?? null; }`);
      const st = await status(client);
      trial.undoAfterCommit = st.undoDepth;
      trial.bodiesAfter = (st.bodies as any[]).filter((b) => ![1, 3, 4, 5].includes(b.id)).map((b) => ({ id: b.id, type: b.type, faceCount: b.faceCount, edgeCount: b.edgeCount, boundsMm: b.boundsMm }));
      const Bi = await info(client, fx.sheetB).catch(() => null);
      trial.sheetB = Bi ? { surface: Bi.faces.map((f) => f.surfaceType), verticalEdges: Bi.edges.filter((e) => e.tangent && Math.abs(Math.abs(e.tangent[2]!) - 1) < 1e-6).map((e) => ({ id: e.id, centerMm: e.centerMm })) } : "sheet B id gone";
      const join = await tryCall(client, "plasticity_join_sheets", { ids: [fx.sheetA, fx.sheetB], intent: "probe join after align", revision: await rev(client) });
      trial.join = join.ok ? { ok: true, bodies: ((await status(client)).bodies as any[]).filter((b) => ![1, 3, 4, 5].includes(b.id)).map((b) => ({ id: b.id, type: b.type, faceCount: b.faceCount, edgeCount: b.edgeCount })) } : join;
      if (join.ok) {
        const joined = ((await status(client)).bodies as any[]).find((b) => b.type === "Sheet" && b.faceCount === 2);
        if (joined) {
          const J = await info(client, joined.id);
          const shared = J.edges.filter((e) => e.faceIds.length === 2);
          trial.continuity = await call(client, "plasticity_analyze_surface_continuity", { edges: shared.map((e) => ({ bodyId: joined.id, edgeId: e.id })), revision: await rev(client) });
        }
      }
    } catch (e) { trial.error = errText(e); try { trial.reads = await lastReads(runtime); } catch {} }
    await undoTo(client, fixtureDepth);
    out.trials[name] = trial;
  }
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save(only ? `probe-align-2-${only.join("-")}.json` : "probe-align-2.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
