// Shared harness for the 2026-11 review-followups probes. Only ever talks to the isolated test instance.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CDP = "http://127.0.0.1:58932";
export const TARGET = "5F15375426D6021495B912B6ABDAE45F";
export const HERE = dirname(fileURLToPath(import.meta.url));
if (process.env.PLASTICITY_CDP_URL !== CDP) throw new Error(`Refusing: PLASTICITY_CDP_URL must be ${CDP}`);

export async function connect() {
  const targets = await discoverPlasticityTargets(CDP);
  const target = targets.find((t: any) => t.id === TARGET || t.targetId === TARGET);
  if (!target) throw new Error(`Isolated target ${TARGET} not found`);
  if (!String((target as any).webSocketDebuggerUrl).includes("127.0.0.1:58932")) throw new Error("wrong ws endpoint");
  return await PlasticityRuntime.connect(target as any);
}

export function save(name: string, data: unknown) {
  const path = join(HERE, name);
  writeFileSync(path, JSON.stringify(data, null, 1));
  console.log("wrote", path);
}

export { nativeFunction };
