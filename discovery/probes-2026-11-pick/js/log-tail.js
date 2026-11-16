(() => { const g = globalThis; const ed = g.__pickRun?.command?.editor; const ex = ed?.executor;
  const show = v => v?.constructor?.name ?? String(v);
  return { run: g.__pickRun && { state: g.__pickRun.state, cmdState: g.__pickRun.command.state }, ex: ex && Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, show(v)])), next: ex?.next && Object.keys(ex.next), lastCommand: ex?.lastCommand?.constructor?.name, lastState: ex?.lastCommand?.state, log: g.__pickLog.slice(-26).map(e => [e.t % 100000, e.ev, e.cls, (e.args ?? []).join(','), e.err ?? e.val ?? ''].join(' ')) }; })()
