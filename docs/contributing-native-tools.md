# Adding a native tool

A native tool runs inside Plasticity's renderer through CDP. Follow this checklist.
Each step needs its own test.

## Code and tests

1. **Operation.** Add the method in `src/plasticity/operations.ts` (or a focused module).
   Native sources that use `nativeApi` must be tagged with `nativeFunction`.
   `src/plasticity/native-function-tagging.test.ts` enforces this.
2. **Registration.** Add the Zod schema and tool entry in `src/server.ts`.
   Give the catalog a name, summary and validation note.
3. **Executing-source test.** Run the generated native source against a fake
   renderer in `operations.test.ts`. Assert the bindings it asks for, and the exact result.
4. **Validation tests.** Cover every rejected input: wrong ids, stale revision,
   out-of-range numbers, duplicates. Reject before any native call.
5. **Server test.** Prove the tool works through `plasticity_batch` and
   `plasticity_call` (catalog name, schema, dispatch).
6. **Live script.** Add `scripts/verify-native-<name>-live.ts` and an
   `accept:native-<name>` entry in `package.json`.

## Rules for live scripts

- Force `PLASTICITY_AUTO_LAUNCH=0` and `PLASTICITY_HUD=0`.
- Refuse a missing `PLASTICITY_CDP_URL` before creating anything.
- Require `--target`, `--allow-disposable-mutations` and a new `--output` directory.
- Restore the baseline in `finally` (undo, delete fixtures, or reopen the saved file).
- Run against an isolated instance only: `npm run start:plasticity-isolated`.
  Use `-- --app /absolute/Other.app` (or `PLASTICITY_APP_PATH`) to choose a
  different bundle. Never use the window of a person who is working.
- Use Node 24.

## Rules for results

- Read tools report only what they can prove. Omit a field rather than guess it.
- Any result that says "unchanged" must be provable: compare revision, history
  and native read-back before and after.
- Record units (millimetres, degrees) and ids with the document revision.

## Background

Probe findings that justify the native bindings and their limits:

- [`discovery/probes-2026-11/FINDINGS.md`](../discovery/probes-2026-11/FINDINGS.md)
- [`discovery/probes-2026-11-pick/FINDINGS.md`](../discovery/probes-2026-11-pick/FINDINGS.md)
- `discovery/probes-2026-11*/FINDINGS.md` for later rounds.

For version compatibility see [Plasticity 26.2](plasticity-26-2-compatibility.md).
