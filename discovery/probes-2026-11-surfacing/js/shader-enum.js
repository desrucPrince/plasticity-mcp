function (ShaderMode, name2shader, RenderMode, zebraHorizontal, zebraVertical, isophotes, draft, ZebraMaterial, IsophotesMaterial, DraftMaterial, ViewportShadingMemento, ShaderModePanel) {
  const show = v => v === null || v === undefined ? String(v) : typeof v === 'object' ? (v.constructor?.name ?? 'object') : typeof v === 'function' ? 'fn:' + v.name : v;
  const own = o => { if (!o || typeof o !== 'object' && typeof o !== 'function') return show(o); const r = {}; for (const k of Object.keys(o)) r[k] = show(o[k]); return r; };
  const sh = this.shading;
  let shaderNow; try { shaderNow = show(sh.shader); } catch (e) { shaderNow = 'err ' + e.message; }
  let usingShader; try { usingShader = sh.isUsingShader; } catch (e) { usingShader = 'err'; }
  return {
    ShaderMode: own(ShaderMode), name2shader: typeof name2shader === 'function' ? 'fn len ' + name2shader.length : own(name2shader),
    RenderMode: own(RenderMode), zebraHorizontal: show(zebraHorizontal), zebraVertical: show(zebraVertical), isophotes: show(isophotes), draft: show(draft),
    zebraHorizontalOwn: own(zebraHorizontal), isophotesOwn: own(isophotes),
    memento: own(sh.saveToMemento()), shaderNow, modeTag: sh.mode.tag, modeKeys: Object.keys(sh.mode),
    isUsingShaderType: typeof usingShader, isUsingShaderVal: typeof usingShader === 'function' ? 'fn' : show(usingShader),
    panelProto: ShaderModePanel ? Object.getOwnPropertyNames(ShaderModePanel.prototype) : null,
    viewportRender: Array.from(this.viewports ?? []).map(v => ({ ctor: v.constructor.name, keys: Object.keys(v).filter(k => /shad|render|mode|zebra/i.test(k)) })),
  };
}
