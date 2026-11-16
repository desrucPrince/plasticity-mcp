// Shared harness for the 2026-11 review-followups probes. Only ever talks to the isolated test instance.
import { discoverPlasticityTargets } from "../../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../../src/plasticity/runtime.ts";
import { nativeFunction } from "../../src/plasticity/native-function.ts";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The endpoint and target come from the environment (see env.sh). Only a 127.0.0.1 endpoint is accepted.
export const CDP = process.env.PLASTICITY_CDP_URL ?? "";
export const TARGET = process.env.PLASTICITY_TARGET_ID ?? "";
export const HERE = dirname(fileURLToPath(import.meta.url));
const endpoint = (() => { try { return new URL(CDP); } catch { return undefined; } })();
if (!endpoint || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port) throw new Error(`Refusing: PLASTICITY_CDP_URL must be http://127.0.0.1:PORT (got "${CDP}")`);
if (!/^[0-9A-F]{32}$/i.test(TARGET)) throw new Error("Refusing: PLASTICITY_TARGET_ID must name the isolated window (32 hex characters)");

export async function connect() {
  const targets = await discoverPlasticityTargets(CDP);
  const target = targets.find((t: any) => t.id === TARGET || t.targetId === TARGET);
  if (!target) throw new Error(`Isolated target ${TARGET} not found`);
  if (!String((target as any).webSocketDebuggerUrl).includes(`127.0.0.1:${endpoint!.port}/`)) throw new Error("wrong ws endpoint");
  return await PlasticityRuntime.connect(target as any);
}

export function save(name: string, data: unknown) {
  const path = join(HERE, name);
  writeFileSync(path, JSON.stringify(data, null, 1));
  console.log("wrote", path);
}

export { nativeFunction };
