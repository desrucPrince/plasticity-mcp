(async () => {
  const g = globalThis; const dlg = g.__pickObjs.DDDlg.at(-1); const inp = dlg.distance; const el = inp.element; const f = dlg.params;
  const snap = (tag) => ({ tag, value: el.value, currentText: inp.state.currentText, hasChanged: inp.state.hasChanged, distance: f.distance, inputTag: inp.state.tag });
  const out = [snap('start')];
  el.value = '20.0 mm';
  for (const ch of ['3', '0']) {
    const code = 'Digit' + ch;
    const kd = new KeyboardEvent('keydown', { key: ch, code, bubbles: true, cancelable: true });
    const notPrevented = el.dispatchEvent(kd);
    if (notPrevented) el.value = el.value + ch; // emulate default action only if handler did not prevent it
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code, bubbles: true }));
    out.push({ ...snap('key ' + ch), defaultPrevented: kd.defaultPrevented });
  }
  await new Promise(r => setTimeout(r, 300));
  out.push(snap('after 300ms'));
  return out;
})()
