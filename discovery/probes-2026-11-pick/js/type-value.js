(async () => {
  const g = globalThis; const dlg = g.__pickObjs.DDDlg.at(-1); const inp = dlg.distance; const el = inp.element; const f = dlg.params;
  const snap = (tag) => ({ tag, value: el.value, currentText: inp.state.currentText, hasChanged: inp.state.hasChanged, distance: f.distance, inputTag: inp.state.tag });
  const out = [snap('start')];
  el.value = '30';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  out.push(snap('after input event'));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: '0', code: 'Digit0', bubbles: true }));
  out.push(snap('after keyup'));
  await new Promise(r => setTimeout(r, 300));
  out.push(snap('after 300ms'));
  return out;
})()
