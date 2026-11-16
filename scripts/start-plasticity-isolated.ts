import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { ensurePlasticityCdp } from "../src/plasticity/launcher.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_APPLICATION_PATH = "/Applications/Plasticity.app";

async function freeLoopbackPort(excluded: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine an ephemeral loopback port"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!excluded.has(port)) return port;
  }
  throw new Error("Could not allocate distinct loopback ports for isolated Plasticity");
}

export function parseIsolatedLaunchArgs(argv: string[]): { help: boolean; applicationPath?: string } {
  const options: { help: boolean; applicationPath?: string } = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help") options.help = true;
    else if (argv[index] === "--application" || argv[index] === "--app") {
      const value = argv[++index];
      if (!value || !isAbsolute(value) || !value.endsWith(".app") || options.applicationPath) {
        throw new Error("--application/--app requires one absolute .app bundle path");
      }
      options.applicationPath = value;
    } else throw new Error("Usage: npm run start:plasticity-isolated [-- --application|--app /absolute/Plasticity.app] (or PLASTICITY_APP_PATH)");
  }
  return options;
}

/** The flag wins; otherwise PLASTICITY_APP_PATH; otherwise undefined, which keeps the launcher default. */
export function resolveApplicationPath(options: { applicationPath?: string }, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = options.applicationPath ?? (env.PLASTICITY_APP_PATH?.trim() || undefined);
  if (value !== undefined && (!isAbsolute(value) || !value.endsWith(".app"))) {
    throw new Error("PLASTICITY_APP_PATH requires one absolute .app bundle path");
  }
  return value;
}

export async function readApplicationVersion(applicationPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(applicationPath, "Contents", "Info.plist")]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseIsolatedLaunchArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Launch a separate Plasticity process with a fresh temporary user-data profile and loopback-only CDP. Use --application (or --app) /absolute/Plasticity.app, or PLASTICITY_APP_PATH, to select an already prepared experimental copy. The launcher only reads application security settings.");
    return;
  }
  const selectedApplicationPath = resolveApplicationPath(options);
  const applicationPath = selectedApplicationPath ?? DEFAULT_APPLICATION_PATH;
  const userDataDirectory = await mkdtemp(join(tmpdir(), "plasticity-mcp-isolated-profile-"));
  const rendererPort = await freeLoopbackPort(new Set());
  const inspectorPort = await freeLoopbackPort(new Set([rendererPort]));
  const targets = await ensurePlasticityCdp({ rendererPort, inspectorPort, userDataDirectory, ...(selectedApplicationPath ? { applicationPath: selectedApplicationPath } : {}) });
  console.log(JSON.stringify({
    status: "available",
    isolated: true,
    applicationPath,
    applicationVersion: await readApplicationVersion(applicationPath),
    userDataDirectory,
    rendererEndpoint: `http://127.0.0.1:${rendererPort}`,
    inspectorEndpoint: `http://127.0.0.1:${inspectorPort}`,
    targets,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
