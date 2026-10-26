import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { CdpClient } from "../../../src/cdp/client.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const cdp = await CdpClient.connect(target!.webSocketDebuggerUrl);
try {
  const r: any = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
    const head = [...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && /shader mode/i.test(e.textContent || ''));
    let panel = head; for (let i = 0; i < 6 && panel; i++) { if (panel.querySelectorAll('img,button,[role=button]').length >= 8) break; panel = panel.parentElement; }
    const items = panel ? [...panel.querySelectorAll('button,[role=button],img,li,div[title],div[data-tooltip]')] : [];
    return { found: !!head, n: items.length, items: items.slice(0, 30).map((e, i) => ({ i, tag: e.tagName, title: e.getAttribute('title') || e.getAttribute('aria-label') || e.getAttribute('data-tooltip') || e.getAttribute('alt') || '', cls: (e.className || '').toString().slice(0, 60), src: (e.getAttribute('src') || '').slice(-40), active: /active|selected|ring/.test((e.className || '').toString()) })) };
  })()` });
  console.log(JSON.stringify(r.result?.value ?? r, null, 0).slice(0, 4000));
} finally { cdp.close(); }
