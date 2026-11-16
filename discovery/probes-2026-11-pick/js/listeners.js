(() => {
  const dlg = globalThis.__pickObjs.DDDlg.at(-1); const inp = dlg.distance; const el = inp.element;
  const sum = (t) => Object.fromEntries(Object.entries(getEventListeners(t)).map(([k, v]) => [k, v.length]));
  const canvas = [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height, rect: c.getBoundingClientRect().toJSON(), parent: c.parentElement?.tagName, l: sum(c) }));
  return { el: sum(el), doc: sum(document), win: sum(window), body: sum(document.body), canvas, threeListeners: Object.keys(inp._listeners ?? {}), dlgOptions: Object.keys(dlg.state.options ?? {}), dpr: devicePixelRatio, inner: [innerWidth, innerHeight], hasFocus: document.hasFocus(), visibility: document.visibilityState, active: document.activeElement?.tagName + '.' + document.activeElement?.className?.slice?.(0, 60) };
})()
