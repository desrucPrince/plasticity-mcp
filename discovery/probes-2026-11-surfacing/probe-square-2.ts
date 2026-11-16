// Item 5, step 2: SquareFactory factory-direct (harness drive() inside SquareEdgeCommand).
// The command route (probe-square-router.json) opens the dialog with an empty factory: SquareEdgeCommand does not
// read the selection, so the boundary must be set on the factory. Variants of factory.boundaries are tried.
// usage: node probe-square-2.ts [variant,variant]
import { connect, save, errText, drive, TRACE, TRACED_COMMIT, lastReads } from "./harness.ts";
import { startMcp, call, status, undoTo, tryCall } from "./mcp.ts";
import { rev, created, info, faceNormal } from "./fixtures.ts";

const only = process.argv[2]?.split(",");
const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const baseline = new Set((start.bodies as any[]).map((b) => b.id));
const out: any = { startUndo: start.undoDepth, trials: {} };
const ids = async () => new Set(((await status(client)).bodies as any[]).map((b) => b.id));
const newBodies = async () => ((await status(client)).bodies as any[]).filter((b) => !baseline.has(b.id));

try {
  // Fixtures: four boundary curves (x 6000..6040) and an open box (x 6100..6140, top removed).
  const curves = [
    [[6000, 0, 0], [6013, 0, 5], [6027, 0, 5], [6040, 0, 0]],
    [[6040, 0, 0], [6040, 13, -4], [6040, 27, -4], [6040, 40, 0]],
    [[6040, 40, 0], [6027, 40, 6], [6013, 40, 6], [6000, 40, 0]],
    [[6000, 40, 0], [6000, 27, 3], [6000, 13, 3], [6000, 0, 0]],
  ];
  const wires: number[] = [];
  for (const pts of curves) {
    const before = await ids();
    await call(client, "plasticity_create_control_point_curve", { pointsMm: pts, intent: "probe square boundary", revision: await rev(client) });
    wires.push((await created(client, before))[0].id);
  }
  let before = await ids();
  await call(client, "plasticity_create_box", { originMm: [6100, 0, 0], sizeMm: [40, 40, 20], intent: "probe open box", revision: await rev(client) });
  const box = (await created(client, before))[0];
  const top = (await info(client, box.id)).faces.find(faceNormal([0, 0, 1]))!;
  await call(client, "plasticity_delete_faces", { faces: [{ bodyId: box.id, faceId: top.id }], intent: "probe open top", revision: await rev(client) });
  const laminar = (await info(client, box.id)).edges.filter((e) => e.faceIds.length === 1).map((e) => e.id);
  const fixtureDepth = (await status(client)).undoDepth;
  out.fixture = { wires, box: box.id, laminar, fixtureDepth };

  const variants: Record<string, { input: "edges" | "wires"; shape: string; continuity?: string }> = {
    edgesFlat: { input: "edges", shape: "flat" },
    edgesNested: { input: "edges", shape: "nested" },
    wiresFlat: { input: "wires", shape: "flat" },
    wiresNested: { input: "wires", shape: "nested" },
    edgesG0: { input: "edges", shape: "flat", continuity: "G0" },
    edgesG1: { input: "edges", shape: "flat", continuity: "G1" },
    edgesG2: { input: "edges", shape: "flat", continuity: "G2" },
    edgesG1global: { input: "edges", shape: "flat", continuity: "G1global" },
  };
  for (const [name, v] of Object.entries(variants)) {
    if (only && !only.includes(name)) continue;
    const trial: any = { ...v };
    try {
      trial.commit = await drive(runtime, {
        command: { binding: "SquareEdgeCommand" },
        factory: "SquareFactory",
        bindings: ["ContinuityType"],
        args: { v, box: box.id, laminar, wires },
        setup: `${TRACE}
          let items;
          if (args.v.input === 'edges') {
            const sel = editor.selection.selected; sel.removeAll();
            for (const id of args.laminar) sel.add(edgeOf(args.box, id));
            items = [...sel.edges]; sel.removeAll();
          } else items = args.wires.map(id => find(id));
          factory.boundaries = args.v.shape === 'nested' ? items.map(x => [x]) : items;
          if (args.v.continuity === 'G1global') factory.continuity = B.ContinuityType.G1;
          else if (args.v.continuity) for (const e of items) factory.setContinuityForEdge(e, B.ContinuityType[args.v.continuity]);
          globalThis.__probeSquareState = { boundaries: show(factory.boundaries), edges: (() => { try { return show(factory.edges); } catch (e) { return 'err ' + e.message; } })(), wires: (() => { try { return show(factory.wires); } catch (e) { return 'err ' + e.message; } })(), edge2continuity: factory.edge2continuity.size };`,
        commit: TRACED_COMMIT,
        timeoutMs: 60000,
      });
      trial.state = await runtime.read(`function () { const s = globalThis.__probeSquareState; delete globalThis.__probeSquareState; return s ?? null; }`);
      trial.reads = await lastReads(runtime);
      trial.depthAfter = (await status(client)).undoDepth;
      const created2 = (await newBodies()).filter((b) => !wires.includes(b.id) && b.id !== box.id);
      trial.created = [];
      for (const b of created2) { const bi = await info(client, b.id); trial.created.push({ id: b.id, type: b.type, name: b.name, faces: bi.faces.map((f) => f.surfaceType), edges: bi.edges.length, boundsMm: b.boundsMm }); }
      const sq = created2.find((b) => b.type === "Sheet");
      if (v.input === "edges" && sq) {
        const j = await tryCall(client, "plasticity_join_sheets", { ids: [box.id, sq.id], intent: "probe join square", revision: await rev(client) });
        trial.join = j.ok ? "ok" : j.error;
        if (j.ok) {
          const joined = (await newBodies()).find((b) => b.id === box.id || b.id === sq.id) ?? (await newBodies()).find((b) => !wires.includes(b.id));
          const J = await info(client, joined.id);
          trial.joinedType = J.type;
          const sqFaces = J.faces.filter((f) => !f.planar).map((f) => f.id);
          const shared = J.edges.filter((e) => e.faceIds.length === 2 && e.faceIds.some((id) => sqFaces.includes(id)));
          trial.continuity = (await call(client, "plasticity_analyze_surface_continuity", { edges: shared.map((e) => ({ bodyId: joined.id, edgeId: e.id })), revision: await rev(client) })).analyses
            .map((a: any) => ({ edge: a.edge.edgeId, gapMm: a.maximumPositionDeviationMm, angleDeg: a.maximumNormalAngleDeviationDeg, relG2: a.maximumRelativeCurvatureDeviation, achieved: a.achievedContinuity }));
        }
      }
    } catch (e) {
      trial.error = errText(e);
      try { trial.state = await runtime.read(`function () { const s = globalThis.__probeSquareState; delete globalThis.__probeSquareState; return s ?? null; }`); } catch {}
      try { trial.reads = await lastReads(runtime); } catch {}
    }
    await undoTo(client, fixtureDepth);
    out.trials[name] = trial;
  }
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save(only ? `probe-square-2-${only.join("-")}.json` : "probe-square-2.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
