function (pk_default, args) {
  const kernel = pk_default.a;
  let item;
  for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === args.id) { item = candidate; break; }
  if (!item) throw new Error('Unknown body ID: ' + args.id);
  const view = item.view;
  const read = v => [Number(v.x), Number(v.y), Number(v.z)];
  const mm = v => read(v).map(x => x * 1000);
  const unit = a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? a.map(x => x / l) : null; };
  const faceIdByEntity = new Map(), edgeIdByEntity = new Map();
  for (let i = 0; i < view.high.faces.versionIds.length; i += 1) faceIdByEntity.set(Number(view.high.faces.get(i).entityId), String(view.high.faces.versionIds[i]));
  for (let i = 0; i < view.high.edges.versionIds.length; i += 1) edgeIdByEntity.set(Number(view.high.edges.get(i).entityId), String(view.high.edges.versionIds[i]));
  const kernelEdges = item.model.GetEdges().GetEdges();
  const kernelFaces = item.model.GetFaces().GetFaces ? item.model.GetFaces().GetFaces() : (() => { const c = item.model.GetFaces(); const out = []; for (let i = 0; i < c.Size(); i += 1) out.push(c.Get(i)); return out; })();
  const edgeByEntity = new Map(kernelEdges.map(e => [Number(e.Id()), e]));
  const faceByEntity = new Map(kernelFaces.map(f => [Number(f.Id()), f]));
  const entityOfEdge = id => { const i = view.high.edges.versionIds.indexOf(id); if (i < 0) throw new Error('Stale or unknown edge: ' + id); return Number(view.high.edges.get(i).entityId); };
  const KernelVector = kernelEdges[0].GetPointAndTangent(0.5).position.constructor;
  const evaluator = kernel.Eval && kernel.Context?.Get ? new kernel.Eval(kernel.Context.Get()) : null;
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const edgeEnds = edge => {
    const s = edge.GetPointAndTangent(0), e = edge.GetPointAndTangent(1);
    const verts = edge.GetVertices();
    const vs = [verts.left, verts.right].filter(Boolean).map(v => ({ id: Number(v.Id()), p: mm(v.GetPoint()) }));
    // The kernel tangent follows the curve, which can run against the edge: orient each end's tangent by a step inside the edge.
    const away = (end, inner) => {
      const t = unit(read(end.tangent)); if (!t) return null;
      const a = read(end.position), b = read(edge.GetPointAndTangent(inner).position);
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      return (t[0] * d[0] + t[1] * d[1] + t[2] * d[2]) < 0 ? t.map(x => -x) : t;
    };
    const ends = [{ t: 0, pointMm: mm(s.position), tangentAway: away(s, 1e-3) }, { t: 1, pointMm: mm(e.position), tangentAway: away(e, 1 - 1e-3) }];
    for (const end of ends) { const v = vs.find(c => dist3(c.p, end.pointMm) < 1e-3); end.vertexId = v ? v.id : null; }
    return ends;
  };
  const faceNormalAt = (face, pMm) => {
    const near = face.FindPointNear(new KernelVector(pMm[0] / 1000, pMm[1] / 1000, pMm[2] / 1000));
    const ev = face.EvalNormal(near.u, near.v);
    return unit(read(ev.normal));
  };
  const insideDistance = (faceEntity, pMm) => {
    if (!evaluator) return null;
    if (args.project) {
      const face = faceByEntity.get(faceEntity);
      const near = face.FindPointNear(new KernelVector(pMm[0] / 1000, pMm[1] / 1000, pMm[2] / 1000));
      pMm = mm(face.EvalNormal(near.u, near.v).position);
    }
    const r = evaluator.DistancesToPoints(Int32Array.from([faceEntity]), Float64Array.from(pMm.map(x => x / 1000)), Int32Array.from([0, 1]));
    const d = Number(r.distances?.[0]);
    return Number(r.errors?.[0] ?? 0) === 0 && Number.isFinite(d) ? d * 1000 : null;
  };
  const edges = args.edgeIds.map(edgeId => {
    const entity = entityOfEdge(edgeId);
    const edge = edgeByEntity.get(entity);
    const faces = edge.GetFaces().GetFaces ? edge.GetFaces().GetFaces() : [];
    return { edgeId, faceIds: faces.map(f => faceIdByEntity.get(Number(f.Id()))), lengthMm: Number(edge.FindLength().length) * 1000, ends: edgeEnds(edge) };
  });
  const wires = (args.curveIds ?? []).map(wireId => {
    let w; for (const [versionId, candidate] of nativeApi.geo.geometryModel) if (nativeApi.db.lookupStableId(versionId) === wireId) { w = candidate; break; }
    if (!w) throw new Error('Unknown wire: ' + wireId);
    const segs = w.model.GetEdges().GetEdges();
    const all = segs.flatMap(edgeEnds);
    const free = all.filter(p => all.filter(q => dist3(p.pointMm, q.pointMm) <= 1e-6).length % 2 === 1).map(p => ({ pointMm: p.pointMm, tangentAway: p.tangentAway }));
    return { wireId, ends: free };
  });
  const vertexIds = [...new Set(edges.flatMap(e => e.ends.map(end => end.vertexId)).filter(v => v !== null))];
  const vertexById = new Map();
  for (const e of kernelEdges) { const vv = e.GetVertices(); for (const v of [vv.left, vv.right]) if (v) vertexById.set(Number(v.Id()), v); }
  const vertices = vertexIds.map(vertexId => {
    const vertex = vertexById.get(vertexId);
    const pMm = mm(vertex.GetPoint());
    // every edge end at this vertex, by face
    const atV = [];
    for (const e of kernelEdges) {
      const ends = edgeEnds(e).filter(end => end.vertexId === vertexId);
      if (ends.length === 0) continue;
      const fs = e.GetFaces().GetFaces ? e.GetFaces().GetFaces() : [];
      for (const end of ends) atV.push({ edgeId: edgeIdByEntity.get(Number(e.Id())), faceEntities: fs.map(f => Number(f.Id())), tangentAway: end.tangentAway });
    }
    const faceEntities = [...new Set(atV.flatMap(a => a.faceEntities))];
    const faces = faceEntities.map(fe => {
      const face = faceByEntity.get(fe);
      const ends = atV.filter(a => a.faceEntities.includes(fe));
      const normal = faceNormalAt(face, pMm);
      let angleDeg = null, inward = null, probe = null, normalInside = null;
      if (ends.length === 2 && ends[0].tangentAway && ends[1].tangentAway && normal) {
        const [t1, t2] = [ends[0].tangentAway, ends[1].tangentAway];
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const dotp = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        // Inside side: step a little along an edge of the face at V, then a tiny step either way across it; the side whose point
        // lies on the trimmed face is inside. Tried on the first edge, then on the second when the first is ambiguous.
        const attempts = [];
        for (const k of [0, 1]) {
          const tk = k === 0 ? t1 : t2, tOther = k === 0 ? t2 : t1;
          const ek = edgeByEntity.get([...edgeIdByEntity].find(([, id]) => id === ends[k].edgeId)[0]);
          const len = Number(ek.FindLength().length) * 1000;
          const s0 = ek.GetPointAndTangent(0), s1 = ek.GetPointAndTangent(1);
          const atStart = dist3(mm(s0.position), pMm) <= dist3(mm(s1.position), pMm);
          const f = Math.min(0.05, 0.5 / len);
          const q = ek.GetPointAndTangent(atStart ? f : 1 - f);
          const qMm = mm(q.position);
          const nq = faceNormalAt(face, qMm);
          const tq = unit(read(q.tangent));
          const w = nq && tq ? unit(cross(nq, tq)) : null;
          if (!w) continue;
          const eps = Math.min(0.01, 0.02 * len);
          const plus = insideDistance(fe, qMm.map((x, i) => x + eps * w[i]));
          const minus = insideDistance(fe, qMm.map((x, i) => x - eps * w[i]));
          attempts.push({ edge: k, eps, plus, minus });
          if (plus === null || minus === null || Math.abs(plus - minus) <= 0.2 * eps) continue;
          const wIn = plus < minus ? w : w.map(x => -x);
          inward = wIn;
          normalInside = faceNormalAt(face, qMm.map((x, i) => x + 0.25 * f * len * wIn[i]));
          const sigma = Math.sign(dotp(cross(tk, wIn), normal)) || 1;
          let phi = Math.atan2(dotp(cross(tk, tOther), normal), dotp(tk, tOther)) * 180 / Math.PI * sigma;
          if (phi < 0) phi += 360;
          angleDeg = phi;
          // inward is reported relative to the first edge's side
          if (k === 1) inward = null;
          break;
        }
        probe = attempts;
      }
      return { faceId: faceIdByEntity.get(fe), normal, normalInside, edgeIds: ends.map(a => a.edgeId), tangents: ends.map(a => a.tangentAway), angleDeg, inward, probe };
    });
    return { vertexId, positionMm: pMm, faces, boundaryEdgeIds: atV.filter(a => a.faceEntities.length === 1).map(a => a.edgeId) };
  });
  return { edges, wires, vertices };
}
