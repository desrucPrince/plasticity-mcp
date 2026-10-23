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
]);

export function exposeDirectTool(mode: ToolCatalogMode, name: string): boolean {
  return mode === "full" || compactTools.has(name);
}
