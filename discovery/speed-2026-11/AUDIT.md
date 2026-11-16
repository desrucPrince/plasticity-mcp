# Plasticity MCP speed audit (2026-11)

Measured 2026-11-16 on the isolated Plasticity (127.0.0.1:57147, target EDEF123A…), Untitled doc with 4 test bodies.
Server at HEAD 5e8ad51 code (src unchanged). Scripts and raw JSON are in this folder. "Mid" = mid cost model (§0).

## 0. Cost model

seconds = turns × T_turn + output_tokens × (1 + reasoning) / R_out + input_tokens / R_in + server_s
- tokens = bytes / 4 (the spec rule). Real JSON with digits and ids tokenizes denser (about 3 B/token), so these token counts are optimistic.
- Request bytes = tool-call JSON the model writes. Response bytes = tool-result text the model reads.

| set  | T_turn | R_out (tok/s) | reasoning tokens | R_in (new input tok/s) |
|------|--------|---------------|------------------|------------------------|
| low  | 2 s    | 80            | 0.5 × output     | 3000                   |
| mid  | 3 s    | 70            | 1.0 × output     | 2000                   |
| high | 4 s    | 60            | 1.5 × output     | 1000                   |

The reasoning multiplier is an assumption, not a measurement.
Rule of thumb (mid): 1 turn = 3 s. 1 KB written = 7.1 s. 1 KB read = 0.13 s.
So output bytes are the main lever. Turns come second. Server time comes third.

## 1. Baseline

### 1.1 Session fixed costs (fixed-costs.json, real stdio)

| item | value |
|---|---|
| Server start (spawn to initialize) | 334–350 ms (median 347), Codex probe disabled |
| First call (auto-connect + status) | 448–470 ms |
| Compact tools/list | 34 tools, 32,094 B (about 8.0k tokens); was 29 tools / 24.7 KB in Oct |
| Largest listed tools | find_faces 2,315 B, find_edges 2,174 B, batch 1,726 B |
| Server instructions | 4,233 B (about 1.1k tokens) |
| Session overhead total | 36.3 KB, about 9.1k tokens, once per session (cached afterwards) |
| plasticity_status on this doc | 2,034 B, 3 ms warm |
| Catalog fuzzy: boss / screw boss / countersink | 559 / 1,962 / 484 B |
| Catalog fuzzy: hole pattern (52 hits) / shell hollow / pattern | 3,603 / 4,101 / 4,011 B |
| Catalog fuzzy+schema "screw boss" | 11,046 B |
| Catalog exact-name (with schema) | 801–2,038 B (screw_boss_pattern 1,811; connector_opening 1,816; countersink_pattern 2,038; create_rib 1,202; check_interference 1,201; parallel face clearance 1,654) |
| Session start, mid (low–high) | 8.9 s (6.2–14.8 s) |

### 1.2 Reference parts as a competent agent builds them today

Each part was built in one batch where the tools allow. Verify reads were appended to the batch. Every part passed read-back.

| part | turns | calls | request B | response B | server ms | mid s (low–high) |
|---|---|---|---|---|---|---|
| a enclosure, compact tools only (1 batch, 25 steps) | 2 | 2 | 3,247 | 18,282 | 1,400 | 32.9 (22.1–47.8) |
| a enclosure, recipes (screw_boss_pattern + connector_opening) | 3 | 4 | 2,218 | 11,219 | 979 | **27.2** (18.3–38.9), today's best for (a) |
| b L-bracket | 4 | 4 | 2,439 | 15,516 | 725 | 32.1 (21.5–46.0) |
| c flange | 2 | 2 | 1,887 | 9,628 | 492 | 21.2 (14.1–30.6) |
| d lid from (a) | 3 | 6 | 3,413 | 17,941 | 1,118 | 36.7 (24.6–53.2), +about 20 s if the selection trap hits |
| e (a) at 100×60×30, 2.5 mm walls | 2 | 2 | 3,212 | 17,072 | 1,231 | 32.3 (21.7–47.0) |
| a with no batch (1 call per step, baseline) | 25 | 25 | 3,642 | 90,451 | 1,194 | 113.5 (75.8–161.7) |

Read-back verification (all ok):
- **a:** bounds [2000,0,0]–[2080,50,25]. 59 faces / 144 edges. 4 pilot axes at (2004.5, 4.5), (2075.5, 4.5), (2004.5, 45.5), (2075.5, 45.5).
- **b:** bounds [2200,0,0]–[2240,30,40]. 23 faces / 63 edges. Hole axes (2226, 7.5/22.5) and (y 7.5/22.5, z 26). Cylinder radii: r5 ×2 (the gusset splits the bend fillet), r3 ×4, r2.25 ×4.
- **c:** bounds Ø60 × 6. 14 faces / 20 edges. 6 axes on the 45 mm circle, matched to 0.001 mm. 2 + 2 circular edges chamfered.
- **d:** bounds [2000,0,23.5]–[2080,50,27]. 27 faces. Lid holes coaxial with the 4 pilots. No volumetric interference. Lip-to-wall clearance 0.2000 mm (exact parallel-planar measure).
- **e:** bounds [2000,0,0]–[2100,60,30]. Pilots at (2005, 5) … (2095, 55).

Forced extra calls and their causes:

| part | extra call | cause |
|---|---|---|
| all | status at session start | Instructions say read the document first. It also finds free space. |
| a (compact) | direct find_faces (pilot axes) | Batch cut the 1,740 B read to ids only. Read results over 1,500 B are truncated. |
| a (recipes) | 2 exact-name catalog calls (1 turn) | screw_boss_pattern and connector_opening are not in the compact list. |
| a (recipes) | direct find_faces | Same truncation. The connector recipe also leaves its profile Wire as a second added body. |
| b | catalog create_rib (1 turn) | The gusset needs create_rib, which is not in the compact list. |
| b | direct find_faces (hole axes) | Truncation (1,900 B). |
| b | direct find_faces (fillet radii) | Fillet radii appear in no reply. The read is 4,644 B. |
| c | direct find_faces (bolt-circle axes) | Truncation (2,408 B). The model also computes 6 centers with trigonometry, because there is no bolt-circle helper. radial_pattern is catalog-only. |
| d | turn 1: two direct find_faces (cavity floor, pilot axes) | Lid sizes must come from (a). A batch cannot do arithmetic on read results, and in-batch reads are truncated. |
| d | turn 1 (in parallel): catalog check_interference + parallel face clearance | Not in the compact list. |
| d | direct find_faces (lid hole axes) | Truncation. |
| d | **error-and-retry (hit, attempt 1)** | The floor face is split into small fragments by the bosses. `matches[0]` was a 0.4 mm fragment, so the lid lip came out 0.4 mm wide and its fillet failed at step 5. The fix is to read the list and take the largest face. A real agent pays one more 2.7 KB batch. |
| e | direct find_faces | Truncation. The whole 3.0 KB batch is re-sent: same structure, 41 of 129 numbers changed. Nothing is reused. |

Decomposition and other hazards (handled in my runs, not counted as calls):
- Shell = box minus filleted inner box. hollow_faces is catalog-only, and chamfering the rim after a shell selects inner and outer rim edges together, because `boundsMm` matches by overlap.
- Outer rim edges need find_faces(top) → find_edges(adjacent) → chamfer, done before the boolean.
- Bosses = 4 cylinders + union + 4 cylinders + difference.
- Rounded opening = box + fillet + difference.
- Likely trap: the create_cylinder `centerMm` is the **base** center. The description does not say this.

### 1.3 Where the server milliseconds go

Batch for part (a), final run, 1,389 ms (`part-a1.json` stepOps):

| component | count | ms | share |
|---|---|---|---|
| Full state reads | 111 | 945 | 68% |
| Native mutations | 19 | 186 | 13% |
| Journal fsync writes | 19 | 142 | 10% |
| Other (zod, diff, JSON, $ref resolution) | — | ~116 | 8% |

- Each edit step does 5 full state reads: journaled-before, assertRevision, the operation's own return state, journaled-after, and batch-after. A boolean does 7. A read step does 1. Diff is 0.2–1.7 ms per step.
- The same 25 steps as direct calls (`part-a3.json` PLASTICITY_TIMING): stateBefore 3–10 ms, mutation 18–50 ms (this includes 2 more state reads; the raw CDP mutate is only 6–27 ms), stateAfter 5–14 ms, journal 5–9 ms per edit.
- The CAD work itself is about 15–20% of server time.
- **O(topology):** the state payload grows from 27.7 KB to 131.5 KB as the enclosure gains 59 faces and 144 edges. Every later read in the session carries that weight.

**40 extra bodies (44 in the document):** the same batch took 3,080 ms in run 1 and 4,421 ms in run 2.

| | 4 bodies | 44 bodies, run 1 | 44 bodies, run 2 |
|---|---|---|---|
| Batch wall time | 1,389 ms | 3,080 ms | 4,421 ms |
| Time per state read | 8.5 ms | 22 ms | 32 ms |
| State payload | 131 KB | 443 KB | 456 KB |
| Mutations | 186 ms | 205 ms | 337 ms |

- Mutations change little, so the growth is in state reads: 2.2–3.2× slower overall.
- Extrapolation (not measured): with 10 enclosure-class parts the state is about 1.1 MB, a read takes 50–80 ms, and the same batch takes about 6–9 s.
- The two recipes are leaner: screw_boss_pattern did 10 native operations with 24 state reads, against about 54 reads for the same work as plain steps.

### 1.4 Response anatomy (anatomy.json)

**Batch reply for (a): 16,542 B. The agent needs 157 B (0.9%).**

| part of the reply | bytes | share | note |
|---|---|---|---|
| `steps` (all) | 16,191 | 98% | — |
| `createdEdges` echoed for 4 booleans | 9,018 | 55% | One boolean alone echoes 64 edges (6.0 KB). |
| `addedBodies` of cutters that later steps consume | 2,396 | 14% | — |
| Read-step results | 2,322 | 14% | Truncated, so useless for positions. |
| Empty lists | 583 | — | — |
| `change` | 268 | — | The useful part. |
| Float noise digits | 1,570 | 9.5% | — |

**Direct fillet reply: 3,412 B. The agent needs 169 B (5%).**

| part of the reply | bytes | note |
|---|---|---|
| Scene `bodies` summary | 1,266 | 5 bodies here; it lists up to 20, so about 5 KB in a busy scene |
| `change` | 981 | 16 boolean flags; modified before/after 519 B |
| Construction planes | 418 | |
| Groups | 187 | |

**find_edges reply:** 291 B per match. Ids only would be 7% of that.

## 2. Opportunities (ranked by saving per effort)

Savings are mid seconds per part, from §1 numbers.

| rank | candidate | verdict | evidence → saving | effort | risk |
|---|---|---|---|---|---|
| 1 | NEW N1: read projection in batch (`fields`/`return` on find_* and verify reads, no silent truncation) | SUPPORTED | Every part paid ≥1 forced verify turn (b paid 2). 4.2 s per part, 8.7 s on b. | S | low |
| 2 | 7 compact-list tuning: add create_rib, screw_boss_pattern, connector_opening, through/countersink_pattern, check_interference, measure_parallel_planar_face_clearance (≈ +9 KB list, about 2.3k tokens/session once) | SUPPORTED | Removes lookup turns: b 3.8 s, a-recipes 5.0 s, d 1.9 s (lookups were parallel there). Nothing measured supports adding the other catalog tools. | S | low |
| 3 | 6 + NEW N4: terse batch reply (drop the createdEdges echo unless asked, drop consumed-body addedBodies and empty lists; opt-in rounding) | SUPPORTED | Batch replies 7.2–16.5 KB → about 0.6 KB: 0.8–2.0 s per part. Its main value is context budget (no-batch style reads 90 KB per part). Float rounding alone is WEAK (about 10% of bytes). | S | low (opt-in keeps tests) |
| 4 | NEW N2: robust selection (`sortBy: area`, `limit`, error on ambiguous `matches[0]`) | SUPPORTED (1 observed failure) | The d attempt-1 failure costs about 20–22 s per hit. | S | low |
| 5 | 1 part recipes: enclosure shell, lid-for-body, L-bracket, flange/disc, plus bolt-circle and grid centre generators for existing *_pattern recipes | SUPPORTED | Request 1.9–3.2 KB → 0.2–0.3 KB. Saves a 14 s, b 15.5 s, c 12 s, e 20.6 s. Existing recipes cover bosses, holes (explicit centres), countersinks, rib, connector opening and two-half lip/groove. Missing: enclosure, lid-for-body, bracket, flange, centre generators. | M each | medium (real parts drift off-template, so batch stays the fallback) |
| 6 | 10 mate/derive helpers (lid_for_body: lip with clearance, hole transfer from bosses, built-in fit checks) | SUPPORTED | d: 3 turns, 3.4 KB written, 17.9 KB read → 1 turn, about 0.3 KB. Saves about 24 s after tier 1, 31 s from today. It also removes the fragment trap. | M–L | medium (feature recognition) |
| 7 | NEW N3: say that create_cylinder `centerMm` is the base centre | SUPPORTED (estimate) | Prevents a likely retry (about 20 s). | S | none |
| 8 | 4 patterns as one step (bolt circle / grid options) | WEAK | radial_pattern and rectangular_pattern exist (catalog-only). Saves 350–430 B: c 2.5 s, a 3 s. It also removes model trigonometry. | S | low |
| 9 | 8 combined verify step (bounds, validity, holes with Ø/axis/depth, blend radii, optional clearance/interference) | SUPPORTED, overlaps N1 | Beyond N1 it saves the extra radii turn on b (3.6 s). | M | low |
| 10 | 5 part/template library (save a batch with ${params}; replay) | WEAK for these parts, SUPPORTED for custom parts | e is covered by an enclosure recipe (309 B). For a custom 3 KB batch, replay of about 120 B saves about 21 s per variant. Format: steps JSON with param expressions, project-local `.plasticity-mcp/templates/`. Needs candidate 3. | M–L | medium (expression safety) |
| 11 | 9 server: one state read per step instead of 5–7; batched journal fsync | WEAK now, SUPPORTED at scale | a: 1.39 s → about 0.47 s (−0.9 s, 3% of the part). At 44 bodies −2.6 to −3.4 s. Extrapolated −5 to −8 s per batch in a 10-part document. Caching and parallel reads are NOT SUPPORTED as separate items: the cost is redundant whole-scene reads, not their latency. | M | medium (revision-safety contract) |
| 12 | 3 named references + arithmetic in batch | WEAK alone | Only d gains (−1 turn, about 3.5 s). It is the substrate for 5 and 10. | M | medium |
| 13 | 2 selectors inside edit tools | WEAK | a has 5 find→edit pairs. Inline queries save about 60–100 B per pair: 1–3 s per part. Batch already removed the turn. | S–M | low |
| — | NEW N5: resume a failed batch from step k with patched args | Estimate | A failed batch re-sends 2.7–3.2 KB, about 20 s. | M | medium |

**Not supported by the data:** adding more catalog tools wholesale, response caching, and float rounding as a main lever.

## 3. Hand comparison (estimates)

**Hand times are my estimates, not observations.** Basis: an expert direct-modelling Plasticity user (no parametric history) with keyboard dimension entry and snapping. Count the operations per part, at about 15–30 s per operation.
- **Agent today:** the best measured path.
- **Tier 1:** fixes N1, N2, N3, N4, 6 and 7, plus the state-read dedupe.
- **Tier 2:** Tier 1 plus part recipes, lid-for-body and template replay.
- Projected request bytes are from byte-counted example calls (cost-model.json). The reply is assumed to be 600 B (900 B for d).

| part | hand (est.) | agent today, mid (low–high) | Tier 1, mid | Tier 2, mid |
|---|---|---|---|---|
| a enclosure | 4–7 min (≈14 ops) | 27.2 s (18.3–38.9) | 17.3 s | 5.8 s |
| b L-bracket | 3–5 min (≈10 ops) | 32.1 s (21.5–46.0) | 20.1 s | 5.2 s |
| c flange | 2–3 min (≈6 ops) | 21.2 s (14.1–30.6) | 16.3 s | 4.8 s |
| d lid from a | 3–6 min (snap to existing geometry) | 36.7 s (24.6–53.2), +about 20 s per selection error | 29.9 s | 5.7 s |
| e variation | 2–4 min push/pull, 4–6 min rebuild | 32.3 s (21.7–47.0) | 17.3 s | 4.4 s |
| session start (once) | — | 8.9 s (6.2–14.8) | about 9.4 s | about 9.4 s |

- Even today the agent is about 5–15× faster than the hand estimates for the CAD work itself.
- The model excludes the time a person spends writing the prompt and reviewing the part.
- It also excludes agent errors. My runs are best case, because I read the server source. Each error costs about 20 s.

**What the owner should time:**
1. Each of the five parts by hand in Plasticity, from a blank document to a verified part (measured).
2. The same five as prompts to the agent, with wall clock from send to final answer. This calibrates T_turn, R_out and the reasoning multiplier.
3. The time spent writing each prompt and checking each result.
4. How often the agent retries a batch.
