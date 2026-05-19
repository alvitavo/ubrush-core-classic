# Layer System Plan

## Goal

Build a Photoshop-class layer system without breaking the existing brush engine.
`Canvas` remains the drawing surface for one layer, while `CanvasStack` owns layer order, selection, compositing, and layer-level state.

## Current V1

- Multiple raster layers backed by individual `Canvas` instances.
- Layer panel in `DrawingScreen`.
- Add, delete, and select layers.
- Rename layers.
- Move layers up and down.
- Lock layers.
- Alpha lock layers.
- Visibility toggle.
- Layer opacity.
- Blend modes: normal, add, screen, max.
- Drawing, fill, clear, shape assist, undo, and redo target the selected layer.
- Layer compositing is handled by `CanvasStack`.
- Opacity compositing uses a dedicated WebGPU layer composite program, leaving the shared `fillRect` path unchanged.

## Architecture

### Canvas

`Canvas` should stay focused on brush rendering, fill, dry/liquid state, fixer capture, and per-layer pixels.
It should not know about layer order, groups, thumbnails, or UI state.

### CanvasStack

`CanvasStack` is the layer document model.
It should own:

- Layer list and selected layer.
- Layer metadata: id, name, visible, opacity, blend mode.
- Routing brush settings to the selected canvas.
- Layer compositing into `outputRenderTarget`.
- Layer-aware history routing.

### DrawingScreen

`DrawingScreen` should own UI and user input.
It should keep compatibility with existing drawing flows by using `this.canvas` as an alias for `canvasStack.selectedCanvas`.

## Next Milestones

## Phase 1: Stabilize V1

- Add focused manual test cases for:
  - Draw on layer 1, add layer 2, draw, toggle visibility.
  - Opacity from 0 to 100.
  - Blend mode changes.
  - Undo/redo after switching layers.
  - Delete selected layer after painting.
- Reduce repeated full compositing in the render loop once dirty tracking is reliable.
- Add basic layer rename.

## Phase 2: Layer Ordering

- Move layer up/down. Done in V1.1.
- Drag reorder in the layer panel. Done in V1.2.
- Preserve selected layer through reorder. Done in V1.2.
- Add history entries for reorder operations. Done in V2.0.
- Add history entries for layer metadata: name, visibility, opacity, blend mode, lock, alpha lock. Done in V2.0.
- Add history entries for layer add/delete. Done in V2.2.

## Phase 3: Groups

Introduce layer tree nodes:

```ts
type LayerNode = RasterLayer | GroupLayer;
```

Group requirements:

- Expand/collapse UI.
- Group visibility.
- Group opacity.
- Group blend mode.
- Composite group children into a cached offscreen render target.
- Select policy: drawing targets a raster layer, not a group.

## Phase 4: Photoshop Blend Modes

Current WebGPU blend states cover only pipeline-supported modes.
Photoshop-style modes need shader-based compositing.

Priority:

- normal
- multiply. Done in V2.1.
- screen
- overlay. Done in V2.7.
- soft light. Done in V2.8.
- hard light. Done in V2.8.
- color dodge. Done in V2.8.
- color burn. Done in V2.8.
- difference. Done in V2.7.

Plan:

- Add a shader blend mode enum.
- For modes not expressible as fixed-function blending, composite source and destination through a shader pass.
- Keep fixed-function modes for fast paths where possible.

## Phase 5: Viewport

Viewport is separate from layer transforms.

State:

```ts
interface ViewportState {
    scale: number;
    rotation: number;
    panX: number;
    panY: number;
}
```

Requirements:

- Zoom. Done in V1.6.
- Pan. Done in V1.6.
- Rotate canvas view. Done in V1.7.
- Reset view. Done in V1.6.
- Convert pointer coordinates through inverse viewport transform before calling brush/fill APIs. Done in V1.6.
- Keyboard viewport shortcuts. Done in V1.8.
- Gray pasteboard and transformed canvas frame. Done in V1.9.

## Phase 6: Performance

The target is smooth operation with many layers.

Required strategy:

- Per-layer dirty flags.
- Stack-level dirty compositing. Done in V1.5.
- Dirty rect tracking. Done in V2.11.
- Cached group render targets.
- Composite only when layer content or layer properties change.
- Avoid per-frame full-stack recomposite.
- Render target pooling for temporary blend passes. Done in V2.9.
- Render target pooling for temporary group passes.
- Debounced thumbnail generation. Done in V2.6.
- Batched thumbnail readback. Done in V2.10.
- Dirty-rect fixer readback where possible.

## Phase 7: Document Operations

- Duplicate layer. Done in V2.3.
- Merge down. Done in V2.4.
- Flatten visible. Done in V2.5.
- Alpha lock UI. Done in V1.4.
- Layer lock. Done in V1.3.
- Export/import layer document format.
- Thumbnails. Done in V2.6.

## Risks

- Some brush modes depend on dry/liquid/smudging state and must remain isolated per layer.
- Shader blend modes may require destination texture sampling, not only fixed-function blending.
- Undo/redo must include layer id and operation type, not only fixer data.
- Full recomposite per frame is acceptable for V1 testing but not for many-layer use.

## Implementation Rule

Do not add Photoshop-level features directly into `DrawingScreen`.
Engine behavior belongs in `Canvas` or `CanvasStack`; UI controls belong in `DrawingScreen`.
