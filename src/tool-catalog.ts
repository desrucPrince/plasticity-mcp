export type ToolCatalogMode = "compact" | "full";

// Keep the common connect, inspect, change-tracking, delivery and modeling path visible.
// Every other registered operation remains discoverable and callable through plasticity_call.
const compactTools = new Set([
  "plasticity_list_windows",
  "plasticity_connect",
  "plasticity_status",
  "plasticity_current_selection",
  "plasticity_list_bodies",
  "plasticity_body_info",
  "plasticity_describe_body",
  "plasticity_capture_snapshot",
  "plasticity_changes_since",
  "plasticity_reconcile",
  "plasticity_screenshot",
  // Common modeling operations, so a typical build needs no catalog lookups.
  "plasticity_create_box",
  "plasticity_create_cylinder",
  "plasticity_create_sphere",
  "plasticity_boolean",
  "plasticity_fillet",
  "plasticity_chamfer",
  "plasticity_extrude_faces",
  "plasticity_extrude_profile",
  "plasticity_move",
  "plasticity_rotate",
  "plasticity_scale",
  "plasticity_mirror",
  "plasticity_delete",
  "plasticity_undo",
  "plasticity_redo",
  "plasticity_find_edges",
  "plasticity_find_faces",
  "plasticity_create_control_point_curve",
  "plasticity_extrude_curves",
  "plasticity_fillet_curves",
  "plasticity_cut_with_curves",
  "plasticity_knife_curve",
  // Recipes, fit checks and exact resize that real builds reach for, so they need no catalog lookup.
  "plasticity_create_rib",
  "plasticity_create_screw_boss_pattern",
  "plasticity_create_connector_opening",
  "plasticity_create_board_case",
  "plasticity_create_through_hole_pattern",
  "plasticity_create_countersink_pattern",
  "plasticity_check_interference",
  "plasticity_measure_parallel_planar_face_clearance",
  "plasticity_set_driving_distance",
  // Bracket recipe and mate helpers for multi-part work.
  "plasticity_create_bracket",
  "plasticity_place_body",
  "plasticity_transfer_holes",
]);

export function exposeDirectTool(mode: ToolCatalogMode, name: string): boolean {
  return mode === "full" || compactTools.has(name);
}

// Light English stemming so query and tool words meet halfway:
// bodies/body, holes/hole, validity/validate, sheets/sheet
const SUFFIXES: Array<[string, string]> = [
  ["ations", ""], ["ation", ""], ["ities", ""], ["ity", ""], ["ates", ""], ["ate", ""],
  ["ings", ""], ["ing", ""], ["ies", "y"], ["es", ""], ["s", ""], ["ed", ""],
];

function stem(word: string): string {
  for (const [suffix, replacement] of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length) + replacement;
  }
  return word;
}

function words(text: string): string[] {
  return text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);
}

// The query word is a prefix of the tool word, or a stem left slightly longer
// by the stemming ("hole" against "hol" from "holes")
function wordMatches(term: string, word: string): boolean {
  return word.startsWith(term) || (word.length >= 3 && term.startsWith(word) && term.length - word.length <= 2);
}

// Same word up to an ending the stemming left behind ("hole" and "hol")
function sameWord(term: string, word: string): boolean {
  return wordMatches(term, word) && Math.abs(term.length - word.length) <= 1;
}

/**
 * Relevance of an operation for a catalog query. Each query word counts on its
 * own: 3 when it is a word of the tool name, 2 when it starts one ("line" in
 * "linear"), 1 when it only matches the description (or, for a word with
 * underscores, a substring of the name). One more point when the query covers
 * every word of the name, so "delete bodies" prefers plasticity_delete over
 * plasticity_delete_instances.
 */
export function catalogScore(query: string, candidate: { name: string; description: string }): number {
  const name = candidate.name.toLocaleLowerCase();
  const nameWords = words(name.replace(/^plasticity_/, ""));
  const descriptionWords = words(candidate.description);
  const covered = new Set<string>();
  const score = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).reduce((sum, raw) => {
    const term = stem(raw);
    const inName = nameWords.filter((word) => wordMatches(term, word));
    inName.forEach((word) => covered.add(word));
    if (inName.some((word) => sameWord(term, word))) return sum + 3;
    if (inName.length > 0) return sum + 2;
    if (descriptionWords.some((word) => wordMatches(term, word)) || name.includes(raw)) return sum + 1;
    return sum;
  }, 0);
  return score > 0 && nameWords.every((word) => covered.has(word)) ? score + 1 : score;
}
