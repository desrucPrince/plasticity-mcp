function () {
  const sh = this.shading;
  const P = Object.getPrototypeOf(sh);
  const src = k => { const d = Object.getOwnPropertyDescriptor(P, k); return d ? String(d.value ?? d.get ?? '').slice(0, 2500) + (d.set ? ' || SET: ' + String(d.set).slice(0, 800) : '') : null; };
  const out = {};
  for (const k of ['shader','setShader','setMatcap','isUsingShader','isUsingMatcap','saveToMemento','restoreFromMemento','setTheme','updateMaterialProperties','uniformMaterial','setPerObjectMode']) out[k] = src(k);
  out.ctor = String(sh.constructor).slice(0, 3000);
  return out;
}
