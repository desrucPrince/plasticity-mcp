import { discoverPlasticityTargets } from "../../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../../src/plasticity/runtime.ts";
const [target] = await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223");
const runtime = await PlasticityRuntime.connect(target!);
try {
  console.log(JSON.stringify(await runtime.read(`async function () {
    const vps = this.viewports ? [...this.viewports] : [];
    const v = vps[0];
    if (!v) return { keys: Object.keys(this).filter(k => /view/i.test(k)) };
    const cam = v.camera;
    return { n: vps.length, vkeys: Object.keys(v).slice(0, 60), camType: cam?.constructor?.name, pos: cam?.position?.toArray?.(), up: cam?.up?.toArray?.(),
      nav: Object.keys(v.navigationControls ?? {}).slice(0, 30), target: v.navigationControls?.target?.toArray?.(), isOrtho: cam?.isOrthographicCamera, zoom: cam?.zoom };
  }`), null, 0).slice(0, 3000));
} finally { runtime.close(); }
