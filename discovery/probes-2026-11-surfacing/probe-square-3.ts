// Item 5, step 3: Square with a neighbouring surface at G1/G2 on one side. The open-box case fails with
// "XNurbs operation failed with error `30`" for G1/G2 (perpendicular walls meet at each corner, so tangency to both
// is impossible). Here: a flat neighbour Sheet (z = 0, y -20..0) gives the y = 0 edge; three control-point curves
// close the quad, and the two side curves leave the neighbour horizontally (corner-compatible).
// boundaries = [neighbour edge, right wire, top wire, left wire] (mixed); setContinuityForEdge(neighbour edge, Gx).
import { connect, save, errText, drive } from "./harness.ts";
import { startMcp, call, status, undoTo, tryCall } from "./mcp.ts";
import { rev, created, info } from "./fixtures.ts";

const client = await startMcp();
const runtime = await connect();
const start = await status(client);
const baseline = new Set((start.bodies as any[]).map((b) => b.id));
const out: any = { startUndo: start.undoDepth, trials: {} };
const ids = async () => new Set(((await status(client)).bodies as any[]).map((b) => b.id));
const newBodies = async () => ((await status(client)).bodies as any[]).filter((b) => !baseline.has(b.id));
try {
  let before = await ids();
  await call(client, "plasticity_create_polyline", { pointsMm: [[6200, 0, 0], [6240, 0, 0]], closed: false, intent: "probe neighbour line", revision: await rev(client) });
  const line = (await created(client, before))[0];
  await call(client, "plasticity_extrude_curves", { ids: [line.id], distanceMm: 20, direction: [0, -1, 0], intent: "probe neighbour sheet", revision: await rev(client) });
  const nb = (await created(client, before)).find((b) => b.type === "Sheet");
  const N = await info(client, nb.id);
  const shared = N.edges.find((e) => Math.abs(e.centerMm[1]!) < 1e-6 && Math.abs(e.centerMm[0]! - 6220) < 1e-6)!;
  const wires: number[] = [];
  // SLOPED=1: the side curves leave the neighbour rising at atan(6/13) = 24.8 degrees, so G0 shows a clear crease
  // and G1 is corner-incompatible (tests the error-30 hypothesis).
  const sloped = process.env.SLOPED === "1";
  const sides = sloped ? [
    [[6240, 0, 0], [6240, 13, 6], [6240, 27, 8], [6240, 40, 8]],
    [[6240, 40, 8], [6227, 40, 8], [6213, 40, 8], [6200, 40, 8]],
    [[6200, 40, 8], [6200, 27, 8], [6200, 13, 6], [6200, 0, 0]],
  ] : [
    [[6240, 0, 0], [6240, 13, 0], [6240, 27, 5], [6240, 40, 5]],
    [[6240, 40, 5], [6227, 40, 5], [6213, 40, 5], [6200, 40, 5]],
    [[6200, 40, 5], [6200, 27, 5], [6200, 13, 0], [6200, 0, 0]],
  ];
  out.sloped = sloped;
  for (const pts of sides) {
    before = await ids();
    await call(client, "plasticity_create_control_point_curve", { pointsMm: pts, intent: "probe square side", revision: await rev(client) });
    wires.push((await created(client, before))[0].id);
  }
  const fixtureDepth = (await status(client)).undoDepth;
  out.fixture = { neighbour: nb.id, sharedEdge: shared.id, wires, fixtureDepth };
  for (const continuity of ["G0", "G1", "G2"]) {
    const trial: any = {};
    try {
      trial.commit = await drive(runtime, {
        command: { binding: "SquareEdgeCommand" },
        factory: "SquareFactory",
        bindings: ["ContinuityType"],
        args: { nb: nb.id, edge: shared.id, wires, continuity },
        setup: `
          const sel = editor.selection.selected; sel.removeAll(); sel.add(edgeOf(args.nb, args.edge));
          const e = [...sel.edges][0]; sel.removeAll();
          factory.boundaries = [e, ...args.wires.map(id => find(id))];
          factory.setContinuityForEdge(e, B.ContinuityType[args.continuity]);
          globalThis.__probeSquareState = { edges: factory.edges.length, wires: factory.wires.length, edge2continuity: [...factory.edge2continuity.values()] };`,
        timeoutMs: 60000,
      });
      trial.state = await runtime.read(`function () { const s = globalThis.__probeSquareState; delete globalThis.__probeSquareState; return s ?? null; }`);
      trial.depthAfter = (await status(client)).undoDepth;
      const sq = (await newBodies()).find((b) => b.type === "Sheet" && b.id !== nb.id);
      trial.square = sq ? { id: sq.id, name: sq.name, faceCount: sq.faceCount, edgeCount: sq.edgeCount, boundsMm: sq.boundsMm } : null;
      if (sq) {
        const j = await tryCall(client, "plasticity_join_sheets", { ids: [nb.id, sq.id], intent: "probe join square", revision: await rev(client) });
        trial.join = j.ok ? "ok" : j.error;
        if (j.ok) {
          const joined = (await newBodies()).find((b) => b.type === "Sheet" && b.faceCount === 2)!;
          const J = await info(client, joined.id);
          const sh = J.edges.filter((e) => e.faceIds.length === 2);
          trial.continuity = (await call(client, "plasticity_analyze_surface_continuity", { edges: sh.map((e) => ({ bodyId: joined.id, edgeId: e.id })), revision: await rev(client) })).analyses
            .map((a: any) => ({ edge: a.edge.edgeId, gapMm: a.maximumPositionDeviationMm, angleDeg: a.maximumNormalAngleDeviationDeg, relG2: a.maximumRelativeCurvatureDeviation, relG2AtMm: a.maximumRelativeCurvatureDeviationAtMm, angleAtMm: a.maximumNormalAngleDeviationAtMm, achieved: a.achievedContinuity }));
        }
      }
    } catch (e) {
      trial.error = errText(e);
      try { trial.state = await runtime.read(`function () { const s = globalThis.__probeSquareState; delete globalThis.__probeSquareState; return s ?? null; }`); } catch {}
    }
    await undoTo(client, fixtureDepth);
    out.trials[continuity] = trial;
  }
} catch (e) {
  out.error = errText(e);
} finally {
  await undoTo(client, start.undoDepth);
  const end = await status(client);
  out.endUndo = end.undoDepth; out.endBodies = (end.bodies as any[]).map((b) => b.id);
  save(process.env.SLOPED === "1" ? "probe-square-3-sloped.json" : "probe-square-3.json", out);
  runtime.close(); await client.close();
}
process.exit(0);
