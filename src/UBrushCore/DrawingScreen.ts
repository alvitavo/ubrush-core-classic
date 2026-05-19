import { getFavoritesSync, isFavorite, setFavorite } from './favorites/FavoritesManager';
import { WGPUContext } from '../UBrushCore/gpu/webgpu/WGPUContext';
import { bootstrapWebGPU } from '../UBrushCore/gpu/webgpu/bootstrap';
import { Canvas, CanvasDelegate, CanvasFloodFillResult } from '../UBrushCore/canvas/Canvas';
import { CanvasLayer, CanvasStack, LayerBlendMode, RemovedLayerEntry } from '../UBrushCore/canvas/CanvasStack';
import { IBrush } from '../UBrushCore/common/IBrush';
import { Size } from '../UBrushCore/common/Size';
import { Point } from '../UBrushCore/common/Point';
import { Stylus } from '../UBrushCore/common/Stylus';
import { WGPUProgramManager } from '../UBrushCore/program/webgpu/WGPUProgramManager';
import { Color } from '../UBrushCore/common/Color';
import { AffineTransform } from '../UBrushCore/common/AffineTransform';
import { RenderObjectBlend } from '../UBrushCore/gpu/RenderObject';
import { Common } from '../UBrushCore/common/Common';
import { Rect } from '../UBrushCore/common/Rect';
import { Fixer } from '../UBrushCore/common/Fixer';
import { FixerGroup } from '../UBrushCore/common/FixerGroup';
import { BrushCategory } from './App';
import { FloodFillTuningMode } from '../UBrushCore/program/webgpu/WGPUFloodFillProgram';

const SIDEBAR_W = 220;
const LAYER_THUMB_W = 44;
const LAYER_THUMB_H = 34;
const STRAIGHTEN_MORPH_MS = 180;
const SHAPE_ASSIST_EDIT_MORPH_MS = 90;
const SHAPE_ASSIST_HOLD_MS = 1200;

interface StrokeSample {
    point: Point;
    stylus: Stylus;
}

type ShapeAssistMode = 'line' | 'bezier' | 'fit' | 'polyline' | 'ellipse' | 'circle';

interface ShapeAssistHandles {
    start: Point;
    control1: Point;
    control2: Point;
    end: Point;
    anchors: Point[];
}

type ShapeAssistHandleKey = 'start' | 'control1' | 'control2' | 'end' | 'ellipseCenter' | `anchor:${number}`;

interface ShapeAssistSnapshot {
    mode: ShapeAssistMode;
    handles: ShapeAssistHandles;
    size: number;
    opacity: number;
    randomSeed: number;
}

interface FloodFillSnapshot {
    tolerance: number;
    edgeSensitivity: number;
}

interface LayerThumbnailCacheEntry {
    age: number;
    dataUrl: string;
}

interface DrawingHistoryEntry {
    kind: 'drawing';
    layerId: string;
    fixerGroup: FixerGroup;
}

type LayerHistoryProperty = 'name' | 'visible' | 'opacity' | 'blendMode' | 'locked' | 'alphaLock';

interface LayerPropertyHistoryEntry {
    kind: 'layer-property';
    layerId: string;
    property: LayerHistoryProperty;
    before: string | number | boolean;
    after: string | number | boolean;
}

interface LayerOrderHistoryEntry {
    kind: 'layer-order';
    before: string[];
    after: string[];
}

interface LayerAddDeleteHistoryEntry {
    kind: 'layer-add' | 'layer-delete';
    layer: CanvasLayer;
    index: number;
    selectedLayerIdBefore?: string;
    selectedLayerIdAfter?: string;
}

interface LayerMergeDownHistoryEntry {
    kind: 'layer-merge-down';
    sourceLayer: CanvasLayer;
    sourceIndex: number;
    targetLayerId: string;
    targetFixerGroup: FixerGroup;
    selectedLayerIdBefore?: string;
    selectedLayerIdAfter?: string;
}

interface LayerFlattenVisibleHistoryEntry {
    kind: 'layer-flatten-visible';
    targetLayerId: string;
    targetNameBefore: string;
    targetNameAfter: string;
    removedLayers: RemovedLayerEntry[];
    targetFixerGroup: FixerGroup;
    selectedLayerIdBefore?: string;
    selectedLayerIdAfter?: string;
}

type HistoryEntry = DrawingHistoryEntry | LayerPropertyHistoryEntry | LayerOrderHistoryEntry | LayerAddDeleteHistoryEntry | LayerMergeDownHistoryEntry | LayerFlattenVisibleHistoryEntry;

export class DrawingScreen implements CanvasDelegate {
    readonly element: HTMLElement;

    private glCanvas!: HTMLCanvasElement;
    private canvasContainer!: HTMLElement;
    private canvasFrameEl!: HTMLElement;
    private canvas?: Canvas;
    private canvasStack?: CanvasStack;
    private glContext?: WGPUContext;
    private canvasWidth = 0;
    private canvasHeight = 0;
    private viewportScale = 1;
    private viewportRotation = 0;
    private viewportPanX = 0;
    private viewportPanY = 0;
    private viewportValueEl!: HTMLElement;
    private spaceKeyDown = false;
    private isViewportPanning = false;
    private viewportPanStartClient = new Point();
    private viewportPanStartOffset = new Point();

    private lastPos: Point = new Point();
    private lastStylus: Stylus = new Stylus();
    private stylusEventCount: number = 0;
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];
    private layerOpacityHistoryStart: Map<string, number> = new Map();
    private layerThumbnailCache: Map<string, LayerThumbnailCacheEntry> = new Map();
    private layerThumbnailPendingAges: Map<string, number> = new Map();
    private layerThumbnailRefreshTimers: Map<string, number> = new Map();
    private pendingFillHistoryCount = 0;
    private loopPaused = false;
    private straightLineTimer: number | null = null;
    private straightLineToken = 0;
    private straightLineStartPos: Point | null = null;
    private straightLineStartStylus: Stylus | null = null;
    private straightLineSamples: StrokeSample[] = [];
    private shapeAssistCurveSamples: StrokeSample[] = [];
    private shapeAssistMode: ShapeAssistMode = 'line';
    private shapeAssistHandles: ShapeAssistHandles | null = null;
    private shapeAssistEditingContext = false;
    private shapeAssistRibbonEl: HTMLElement | null = null;
    private shapeAssistHandlesEl: HTMLElement | null = null;
    private shapeAssistDragKey: ShapeAssistHandleKey | null = null;
    private shapeAssistDragStartSnapshot: ShapeAssistSnapshot | null = null;
    private shapeAssistPreviewAnimationToken = 0;
    private shapeAssistRenderedSamples: StrokeSample[] = [];
    private shapeAssistUndoStack: ShapeAssistSnapshot[] = [];
    private shapeAssistRedoStack: ShapeAssistSnapshot[] = [];
    private shapeAssistRandomSeed = 0;
    private straightLineStrokeGroup: FixerGroup | null = null;
    private straightLineUndoGroup: FixerGroup | null = null;
    private straightLinePreviewActive = false;
    private straightLineActivating = false;
    private straightLineActivationPromise: Promise<void> | null = null;

    private categories: BrushCategory[] = [];
    private currentCategoryIndex = 0;
    private currentBrushIndex = 0;
    private currentColor = new Color(0, 0, 0, 1);
    private currentSize = 0.1;
    private currentOpacity = 1.0;
    private currentTool: 'brush' | 'fill' = 'brush';
    private fillTolerance = 24;
    private fillEdgeSensitivity = 72;
    private fillTuningMode: FloodFillTuningMode = 'auto';
    private fillInProgress = false;
    private floodFillEditingContext = false;
    private floodFillRibbonEl: HTMLElement | null = null;
    private floodFillToleranceInputEl: HTMLInputElement | null = null;
    private floodFillEdgeInputEl: HTMLInputElement | null = null;
    private floodFillSeed: Point | null = null;
    private floodFillBaselineFixer: Fixer | null = null;
    private floodFillPreviewResult: CanvasFloodFillResult | null = null;
    private floodFillPreviewToken = 0;
    private floodFillPreviewQueued = false;
    private floodFillPreviewPromise: Promise<void> | null = null;
    private floodFillUndoStack: FloodFillSnapshot[] = [];
    private floodFillRedoStack: FloodFillSnapshot[] = [];

    private savedBrush: IBrush | null = null;
    private isInitialRestore = false;
    private static readonly STORAGE_KEY = 'ubrush_state';

    private categorySelectEl!: HTMLSelectElement;
    private brushSelectEl!: HTMLSelectElement;
    private favStarBtn!: HTMLButtonElement;
    private undoBtnEl!: HTMLButtonElement;
    private redoBtnEl!: HTMLButtonElement;
    private colorInputEl!: HTMLInputElement;
    private sizeSliderEl!: HTMLInputElement;
    private sizeValueEl!: HTMLElement;
    private sizeSliderWrapEl!: HTMLElement;
    private opacitySliderEl!: HTMLInputElement;
    private opacityValueEl!: HTMLElement;
    private opacitySliderWrapEl!: HTMLElement;
    private brushToolBtn!: HTMLButtonElement;
    private fillToolBtn!: HTMLButtonElement;
    private webGPUStatsEl!: HTMLElement;
    private layerListEl!: HTMLElement;
    private addLayerBtnEl!: HTMLButtonElement;
    private duplicateLayerBtnEl!: HTMLButtonElement;
    private mergeDownLayerBtnEl!: HTMLButtonElement;
    private flattenVisibleLayerBtnEl!: HTMLButtonElement;
    private deleteLayerBtnEl!: HTMLButtonElement;
    private selectedSwatch: HTMLButtonElement | null = null;

    private onEditBrush: () => void;

    constructor(categories: BrushCategory[], onEditBrush: () => void) {
        this.categories = categories;
        this.onEditBrush = onEditBrush;
        this.loadPersistedState();
        this.element = this.buildLayout();
        // initWebGL is async (WebGPU device init) — fire-and-forget; render
        // loop checks for `glContext` before drawing.
        void this.initWebGPU();
    }

    private loadPersistedState(): void {
        try {
            const raw = localStorage.getItem(DrawingScreen.STORAGE_KEY);
            if (!raw) return;
            const s = JSON.parse(raw);
            // Restore by key (robust against list reordering)
            if (typeof s.categoryKey === 'string') {
                const idx = this.categories.findIndex(c => c.key === s.categoryKey);
                this.currentCategoryIndex = idx >= 0 ? idx : 0;
            }
            if (typeof s.brushIndex === 'number') this.currentBrushIndex = s.brushIndex;
            if (typeof s.size === 'number') this.currentSize = s.size;
            if (typeof s.opacity === 'number') this.currentOpacity = s.opacity;
            if (s.brush && typeof s.brush === 'object') {
                this.savedBrush = s.brush as IBrush;
                this.isInitialRestore = true;
            }
        } catch {}
    }

    private saveState(): void {
        try {
            const cat = this.categories[this.currentCategoryIndex];
            const brush = cat?.brushes?.[this.currentBrushIndex] ?? this.savedBrush;
            localStorage.setItem(DrawingScreen.STORAGE_KEY, JSON.stringify({
                categoryKey: cat?.key,
                brushIndex: this.currentBrushIndex,
                size: this.currentSize,
                opacity: this.currentOpacity,
                brush,
            }));
        } catch {}
    }

    show(): void { this.element.style.display = 'flex'; this.loopPaused = false; }
    hide(): void { this.element.style.display = 'none'; this.loopPaused = true; }

    /** Called by App after the brush editor applies changes */
    applyBrush(brush: IBrush): void {
        const cloned = JSON.parse(JSON.stringify(brush));
        const cat = this.categories[this.currentCategoryIndex];
        if (cat?.brushes) {
            cat.brushes[this.currentBrushIndex] = cloned;
        }
        this.canvasStack?.setBrush(JSON.parse(JSON.stringify(cloned)));
        this.saveState();
    }

    /** Rebuilds the 즐겨찾기 category; refreshes brush list if it is currently selected. */
    refreshFavoritesCategory(): void {
        const idx = this.categories.findIndex(c => c.key === '__favorites__');
        if (idx === -1) return;

        const favEntries = getFavoritesSync();
        const favBrushes: IBrush[] = [];
        for (const fav of favEntries) {
            const cat = this.categories.find(c => c.file === fav.file && c.key !== '__favorites__');
            const brush = cat?.brushes?.find(b => b.name === fav.name);
            if (brush) favBrushes.push(JSON.parse(JSON.stringify(brush)));
        }
        this.categories[idx].brushes = favBrushes;

        if (this.currentCategoryIndex === idx) {
            this.currentBrushIndex = 0;
            this.refreshBrushList();
        }
        this.updateFavoriteStar();
    }

    getCurrentBrush(): IBrush | undefined {
        return this.categories[this.currentCategoryIndex]?.brushes?.[this.currentBrushIndex];
    }

    getCurrentBrushInfo(): { brush: IBrush; categoryFile: string } | undefined {
        for (let ci = this.currentCategoryIndex; ci < this.categories.length; ci++) {
            const cat = this.categories[ci];
            const bi = ci === this.currentCategoryIndex ? this.currentBrushIndex : 0;
            const brush = cat?.brushes?.[bi];
            if (!brush) continue;
            // For demo category, resolve the original categoryFile from tags
            if (cat.key === '__favorites__') {
                const fav = getFavoritesSync().find(f => f.name === brush.name);
                return { brush, categoryFile: fav?.file ?? cat.file };
            }
            return { brush, categoryFile: cat.file };
        }
        return undefined;
    }

    // ---- CanvasDelegate ----

    changeRect(_source: Canvas | CanvasStack, _rect: Rect): void {}

    didReleaseDrawingWithFixerGroup(_canvas: Canvas, fixerGroup: FixerGroup): void {
        this.pushCanvasHistory(_canvas, fixerGroup);
    }

    didDryCanvas(_canvas: Canvas): void {}

    didReleaseDrawing(_canvasStack: CanvasStack, fixerGroup: FixerGroup, canvasIndex: number): void {
        const layer = this.canvasStack?.layerArray[canvasIndex];
        if (!layer) return;
        this.pushHistory(layer.id, fixerGroup);
    }

    didChangeLayers(_canvasStack: CanvasStack, _layers: CanvasLayer[]): void {
        this.canvas = this.canvasStack?.selectedCanvas;
        this.refreshLayerPanel();
    }

    // ---- Layout ----

    private buildLayout(): HTMLElement {
        const screen = document.createElement('div');
        screen.style.cssText = `
            display: flex;
            width: 100vw;
            height: 100vh;
            overflow: hidden;
            font-family: sans-serif;
        `;

        screen.appendChild(this.buildSidebar());

        this.canvasContainer = document.createElement('div');
        this.canvasContainer.style.cssText = `
            flex: 1;
            position: relative;
            overflow: hidden;
            background: #f0f0f0;
        `;

        this.glCanvas = document.createElement('canvas');
        this.glCanvas.style.cssText = `display: block; width: 100%; height: 100%; cursor: crosshair;`;
        this.canvasContainer.appendChild(this.glCanvas);

        this.canvasFrameEl = document.createElement('div');
        this.canvasFrameEl.style.cssText = `
            position:absolute; left:0; top:0; width:100%; height:100%;
            border:1px solid rgba(0,0,0,.35); box-shadow:0 2px 12px rgba(0,0,0,.18);
            box-sizing:border-box; pointer-events:none; transform-origin:center center; z-index:2;
        `;
        this.canvasContainer.appendChild(this.canvasFrameEl);

        screen.appendChild(this.canvasContainer);
        return screen;
    }

    private buildSidebar(): HTMLElement {
        const sidebar = document.createElement('div');
        sidebar.style.cssText = `
            width: ${SIDEBAR_W}px;
            min-width: ${SIDEBAR_W}px;
            background: #2a2a2a;
            display: flex;
            flex-direction: column;
            padding: 14px 12px;
            gap: 12px;
            overflow-y: auto;
            border-right: 1px solid #3a3a3a;
        `;

        // Title
        const title = document.createElement('div');
        title.textContent = 'UBrush Demo';
        title.style.cssText = `font-size:14px; font-weight:700; color:#4a90d9; padding-bottom:8px; border-bottom:1px solid #3a3a3a;`;
        sidebar.appendChild(title);

        // Category selector
        sidebar.appendChild(row('Category', () => {
            this.categorySelectEl = document.createElement('select');
            this.categorySelectEl.style.cssText = inputCSS;
            this.categories.forEach((cat, i) => {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = cat.displayName;
                this.categorySelectEl.appendChild(opt);
            });
            this.categorySelectEl.value = String(this.currentCategoryIndex);
            this.categorySelectEl.addEventListener('change', () => {
                this.currentCategoryIndex = parseInt(this.categorySelectEl.value);
                this.currentBrushIndex = 0;
                this.loadCategoryAndRefreshBrushList();
                this.saveState();
                this.updateFavoriteStar();
            });
            return this.categorySelectEl;
        }));

        // Brush selector + favorite star button
        const brushWrap = document.createElement('div');
        const brushLbl = document.createElement('label');
        brushLbl.textContent = 'Brush';
        brushLbl.style.cssText = `display:block; font-size:11px; color:#9a9a9a; margin-bottom:4px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        brushWrap.appendChild(brushLbl);
        const brushRow = document.createElement('div');
        brushRow.style.cssText = `display:flex; gap:5px; align-items:center;`;
        this.brushSelectEl = document.createElement('select');
        this.brushSelectEl.style.cssText = `
            flex:1; min-width:0; background:#3a3a3a; border:1px solid #555;
            border-radius:4px; color:#e0e0e0; padding:5px 8px; font-size:13px; outline:none;
        `;
        this.brushSelectEl.addEventListener('change', () => {
            this.currentBrushIndex = parseInt(this.brushSelectEl.value);
            const cat = this.categories[this.currentCategoryIndex];
            const brush = cat?.brushes?.[this.currentBrushIndex];
            if (brush && this.canvasStack) {
                this.savedBrush = JSON.parse(JSON.stringify(brush));
                this.canvasStack.setBrush(JSON.parse(JSON.stringify(brush)));
            }
            this.saveState();
            this.updateFavoriteStar();
        });
        this.refreshBrushList();
        this.favStarBtn = document.createElement('button');
        this.favStarBtn.title = '즐겨찾기';
        this.favStarBtn.style.cssText = `
            flex-shrink:0; width:30px; height:30px; padding:0; line-height:1;
            background:#3a3a3a; border:1px solid #555; border-radius:4px;
            font-size:17px; cursor:pointer; transition:background .15s;
        `;
        this.favStarBtn.addEventListener('click', () => this.toggleFavorite());
        brushRow.appendChild(this.brushSelectEl);
        brushRow.appendChild(this.favStarBtn);
        brushWrap.appendChild(brushRow);
        sidebar.appendChild(brushWrap);

        // Color section (palette + picker)
        sidebar.appendChild(this.buildColorSection());

        sidebar.appendChild(this.buildToolSection());

        sidebar.appendChild(this.buildBrushSizeSlider());
        sidebar.appendChild(this.buildBrushOpacitySlider());

        // Divider
        sidebar.appendChild(divider());

        sidebar.appendChild(this.buildViewportSection());

        // Divider
        sidebar.appendChild(divider());

        sidebar.appendChild(this.buildLayerSection());

        // Divider
        sidebar.appendChild(divider());

        // Clear button
        sidebar.appendChild(actionBtn('Clear', '#4a4a4a', () => this.clearWithHistory()));

        // Dry button
        sidebar.appendChild(actionBtn('Dry', '#4a4a4a', () => this.canvas?.dry()));

        // Undo button
        this.undoBtnEl = actionBtn('Undo', '#4a4a4a', () => this.undo());
        this.undoBtnEl.disabled = true;
        sidebar.appendChild(this.undoBtnEl);

        // Redo button
        this.redoBtnEl = actionBtn('Redo', '#4a4a4a', () => this.redo());
        this.redoBtnEl.disabled = true;
        sidebar.appendChild(this.redoBtnEl);

        // Divider
        sidebar.appendChild(divider());

        // Edit Brush button
        sidebar.appendChild(actionBtn('Edit Brush', '#2a5aa0', () => this.onEditBrush()));

        sidebar.appendChild(this.buildWebGPUStatsSection());

        // Divider
        sidebar.appendChild(divider());

        // PWA guide button
        sidebar.appendChild(actionBtn('홈 화면에 추가', '#4a4a4a', () => showPWAGuideModal()));

        // Refresh button
        sidebar.appendChild(actionBtn('새로고침', '#4a4a4a', () => window.location.reload()));

        // Restore non-first category brush list after DOM settles
        if (this.currentCategoryIndex > 0) {
            requestAnimationFrame(() => this.loadCategoryAndRefreshBrushList());
        }

        return sidebar;
    }

    /** Repopulates the brush <select> from the current category's brushes (must already be loaded). */
    private refreshBrushList(): void {
        const cat = this.categories[this.currentCategoryIndex];
        const brushes = cat?.brushes ?? [];

        while (this.brushSelectEl.firstChild) {
            this.brushSelectEl.removeChild(this.brushSelectEl.firstChild);
        }
        brushes.forEach((b, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = b.name ?? `Brush ${i + 1}`;
            this.brushSelectEl.appendChild(opt);
        });

        const targetIndex = Math.min(this.currentBrushIndex, Math.max(0, brushes.length - 1));
        this.brushSelectEl.value = String(targetIndex);

        // Skip canvas.setBrush during initial restore — initWebGL applies savedBrush instead
        if (brushes.length > 0 && this.canvasStack && !this.isInitialRestore) {
            this.savedBrush = JSON.parse(JSON.stringify(brushes[targetIndex]));
            this.canvasStack.setBrush(JSON.parse(JSON.stringify(brushes[targetIndex])));
        }
        this.updateFavoriteStar();
    }

    /** Lazy-loads the category if needed, then refreshes the brush list. */
    private loadCategoryAndRefreshBrushList(): void {
        const cat = this.categories[this.currentCategoryIndex];
        if (!cat) return;

        if (cat.key === '__favorites__' || cat.brushes) {
            this.refreshBrushList();
        } else {
            fetch(cat.file)
                .then(r => r.json())
                .then((data: IBrush[]) => {
                    cat.brushes = Array.isArray(data) ? data : [];
                    this.refreshBrushList();
                })
                .catch(e => console.warn(`Could not load ${cat.file}`, e));
        }
    }

    // ---- WebGPU initialization ----

    private async initWebGPU(): Promise<void> {
        this.updateWebGPUStats({
            status: 'initializing',
        });

        const w = window.innerWidth - SIDEBAR_W;
        const h = window.innerHeight;
        this.canvasWidth = w * 2;
        this.canvasHeight = h * 2;

        this.glCanvas.width = w * 2;
        this.glCanvas.height = h * 2;

        let bootstrap;
        try {
            bootstrap = await bootstrapWebGPU(this.glCanvas);
        } catch (e) {
            console.error('WebGPU init failed', e);
            this.updateWebGPUStats({
                status: 'failed',
                error: e instanceof Error ? e.message : String(e),
            });
            return;
        }

        this.updateWebGPUStats({
            status: 'ready',
            adapter: bootstrap.adapter,
            device: bootstrap.device,
            format: bootstrap.presentationFormat,
        });

        const size = new Size(w * 2, h * 2);
        const context = new WGPUContext(bootstrap.device, bootstrap.presentationContext, bootstrap.presentationFormat, size);
        this.glContext = context;

        WGPUProgramManager.init(context);

        const canvasStack = new CanvasStack(context, size);
        canvasStack.delegate = this;
        this.canvasStack = canvasStack;
        const firstLayer = canvasStack.createLayer('Layer 1');
        this.canvas = firstLayer.canvas;

        // Apply saved brush or fall back to first available brush across all categories
        const firstAvailable = this.categories.reduce<IBrush | undefined>(
            (found, cat) => found ?? cat.brushes?.[0], undefined
        );
        const brushToApply = this.savedBrush ?? this.getCurrentBrush() ?? firstAvailable;
        if (brushToApply) {
            canvasStack.setBrush(JSON.parse(JSON.stringify(brushToApply)));
            this.savedBrush = JSON.parse(JSON.stringify(brushToApply));
        }
        this.isInitialRestore = false;

        canvasStack.color = this.currentColor.clone();
        canvasStack.brushSize = this.currentSize;
        canvasStack.brushOpacity = this.currentOpacity;
        this.refreshLayerPanel();

        this.attachInputEvents();
        this.loop();
    }

    // ---- Render loop ----

    private loop(): void {
        if (!this.loopPaused) this.render();
        requestAnimationFrame(this.loop.bind(this));
    }

    private render(): void {
        if (!this.canvasStack || !this.glContext) return;

        this.glContext.clearRenderTarget(null, new Color(0.72, 0.72, 0.72, 1));
        this.canvasStack.compositeIfNeeded();
        this.updateCanvasFrame();

        WGPUProgramManager.getInstance().fillRectProgram.fill(
            null,
            {
                targetRect: Common.stageRect(),
                source: this.canvasStack.outputRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: this.viewportTransform(),
                blend: RenderObjectBlend.Normal
            }
        );
    }

    // ---- Input events ----

    private attachInputEvents(): void {
        this.glCanvas.addEventListener('mousedown', this.onPointerDown);
        this.glCanvas.addEventListener('touchstart', this.onPointerDown, { passive: false });
        this.glCanvas.addEventListener('wheel', this.onCanvasWheel, { passive: false });
        document.addEventListener('keydown', this.onDocumentKeyDown);
        document.addEventListener('keyup', this.onDocumentKeyUp);
    }

    private onPointerDown = async (e: MouseEvent | TouchEvent): Promise<void> => {
        e.preventDefault();
        if (e instanceof MouseEvent && (e.button === 1 || this.spaceKeyDown)) {
            this.beginViewportPan(e);
            return;
        }
        if (this.selectedLayerIsLocked()) return;
        if (this.shapeAssistEditingContext) {
            await this.commitShapeAssistContext();
        }
        if (this.floodFillEditingContext) {
            await this.commitFloodFillContext();
        }

        this.stylusEventCount = 0;
        this.lastPos = this.eventPoint(e);
        this.clearStraightLineTimer();
        this.straightLinePreviewActive = false;
        this.straightLineActivating = false;
        this.straightLineActivationPromise = null;
        this.straightLineSamples = [];
        this.shapeAssistRenderedSamples = [];
        this.shapeAssistCurveSamples = [];
        this.shapeAssistRandomSeed = 0;
        this.shapeAssistMode = 'line';
        this.shapeAssistHandles = null;
        this.shapeAssistEditingContext = false;
        this.hideShapeAssistUI();
        this.straightLineStrokeGroup = null;
        this.straightLineUndoGroup = null;

        if (this.currentTool === 'fill') {
            await this.startFloodFillContext(this.lastPos);
            return;
        }

        this.lastStylus = this.eventStylus(e);
        this.straightLineStartPos = this.lastPos.clone();
        this.straightLineStartStylus = new Stylus(
            this.lastStylus.pressure,
            this.lastStylus.altitudeAngle,
            this.lastStylus.azimuthAngle
        );
        this.straightLineSamples = [{
            point: this.lastPos.clone(),
            stylus: this.cloneStylus(this.lastStylus)
        }];
        this.ensureSelectedCanvasBrush();
        this.straightLineStrokeGroup = (await this.canvas?.captureLineStartForStraightening()) ?? null;
        this.canvas?.moveTo(this.lastPos, this.lastStylus);
        this.startStraightLineTimer();

        if (e instanceof MouseEvent) {
            document.addEventListener('mousemove', this.onPointerMove);
            document.addEventListener('mouseup', this.onPointerUp);
        } else {
            document.addEventListener('touchmove', this.onPointerMove);
            document.addEventListener('touchend', this.onPointerUp);
        }
    };

    private beginViewportPan(e: MouseEvent): void {
        this.isViewportPanning = true;
        this.viewportPanStartClient = new Point(e.clientX, e.clientY);
        this.viewportPanStartOffset = new Point(this.viewportPanX, this.viewportPanY);
        this.glCanvas.style.cursor = 'grabbing';
        document.addEventListener('mousemove', this.onViewportPanMove);
        document.addEventListener('mouseup', this.onViewportPanUp);
    }

    private onViewportPanMove = (e: MouseEvent): void => {
        if (!this.isViewportPanning) return;
        e.preventDefault();
        const rect = this.glCanvas.getBoundingClientRect();
        const dx = ((e.clientX - this.viewportPanStartClient.x) / rect.width) * 2;
        const dy = -((e.clientY - this.viewportPanStartClient.y) / rect.height) * 2;
        this.viewportPanX = this.viewportPanStartOffset.x + dx;
        this.viewportPanY = this.viewportPanStartOffset.y + dy;
        this.updateViewportUI();
        this.updateShapeAssistHandles();
    };

    private onViewportPanUp = (): void => {
        this.isViewportPanning = false;
        this.glCanvas.style.cursor = this.spaceKeyDown ? 'grab' : 'crosshair';
        document.removeEventListener('mousemove', this.onViewportPanMove);
        document.removeEventListener('mouseup', this.onViewportPanUp);
    };

    private onPointerMove = (e: MouseEvent | TouchEvent): void => {
        e.preventDefault();
        this.lastPos = this.eventPoint(e);
        this.lastStylus = this.eventStylus(e);
        if (this.straightLinePreviewActive && this.straightLineStartPos && this.straightLineStartStylus) {
            if (!this.shapeAssistEditingContext) {
                this.updateShapeAssistEnd(this.lastPos, this.lastStylus);
            }
            this.renderShapeAssistPreview();
            return;
        }

        if (!this.straightLineActivating) {
            this.straightLineSamples.push({
                point: this.lastPos.clone(),
                stylus: this.cloneStylus(this.lastStylus)
            });
            this.canvas?.lineTo(this.lastPos, this.lastStylus);
            this.restartStraightLineTimer();
        }
    };

    private onPointerUp = async (e: MouseEvent | TouchEvent): Promise<void> => {
        e.preventDefault();
        this.clearStraightLineTimer();

        if (this.straightLineActivationPromise) {
            await this.straightLineActivationPromise;
        }

        if (this.straightLinePreviewActive && this.straightLineUndoGroup && this.straightLineStartPos && this.straightLineStartStylus && this.canvas) {
            this.renderShapeAssistPreview();
            this.shapeAssistEditingContext = true;
            this.showShapeAssistUI();
            this.updateShapeAssistHandles();
        } else {
            await this.canvas?.endLine(this.lastPos, this.lastStylus);
            this.resetShapeAssistState();
        }

        this.straightLineActivating = false;
        this.straightLineActivationPromise = null;
        document.removeEventListener('mousemove', this.onPointerMove);
        document.removeEventListener('mouseup', this.onPointerUp);
        document.removeEventListener('touchmove', this.onPointerMove);
        document.removeEventListener('touchend', this.onPointerUp);
    };

    private startStraightLineTimer(): void {
        const token = ++this.straightLineToken;
        this.straightLineTimer = window.setTimeout(() => {
            this.straightLineActivationPromise = this.activateStraightLinePreview(token);
        }, SHAPE_ASSIST_HOLD_MS);
    }

    private restartStraightLineTimer(): void {
        this.clearStraightLineTimer();
        this.startStraightLineTimer();
    }

    private clearStraightLineTimer(): void {
        if (this.straightLineTimer === null) return;
        window.clearTimeout(this.straightLineTimer);
        this.straightLineTimer = null;
    }

    private async activateStraightLinePreview(token: number): Promise<void> {
        if (!this.canvas || !this.straightLineStartPos || !this.straightLineStartStylus) return;
        if (token !== this.straightLineToken || this.currentTool !== 'brush') return;
        if (this.straightLinePreviewActive || this.straightLineActivating) return;

        this.straightLineActivating = true;
        try {
            const curveSamples = this.cloneStrokeSamples(this.straightLineSamples);
            this.shapeAssistCurveSamples = curveSamples;
            this.shapeAssistRandomSeed = Common.nextRandomSeed();
            this.shapeAssistMode = this.chooseShapeAssistMode(curveSamples);
            this.shapeAssistHandles = this.createShapeAssistHandles(this.shapeAssistMode);
            const strokeGroup = this.straightLineStrokeGroup ?? await this.canvas.captureLineStartForStraightening();
            const undoGroup = await this.canvas.prepareActiveLineForStraightening(strokeGroup);
            this.straightLineStrokeGroup = strokeGroup;
            if (token !== this.straightLineToken || !this.straightLineStartPos || !this.straightLineStartStylus) return;

            this.straightLineUndoGroup = undoGroup;
            await this.animateStraightLineMorph(
                token,
                curveSamples,
                this.shapeAssistMode
            );
            if (token !== this.straightLineToken || !this.straightLineStartPos || !this.straightLineStartStylus) return;

            this.straightLinePreviewActive = true;
            this.renderShapeAssistPreview();
        } catch (error) {
            console.error('Straight line preview failed', error);
        } finally {
            this.straightLineActivating = false;
        }
    }

    private async animateStraightLineMorph(token: number, curveSamples: StrokeSample[], mode: ShapeAssistMode): Promise<void> {
        if (!this.canvas || curveSamples.length < 2) return;

        const disableSmudging = this.canvas.brushUsesSmudging();
        const startedAt = performance.now();

        await new Promise<void>((resolve) => {
            const frame = (now: number) => {
                if (token !== this.straightLineToken || !this.canvas) {
                    resolve();
                    return;
                }

                const rawT = Math.min(1, (now - startedAt) / STRAIGHTEN_MORPH_MS);
                const t = rawT * rawT * (3 - 2 * rawT);
                const targetSamples = this.buildShapeAssistSamples(mode, curveSamples.length);
                const samples = this.buildMorphSamples(curveSamples, targetSamples, t);
                this.canvas.replaceActiveLineWithPath(samples, {
                    disableSmudging,
                    followAcceleration: 1,
                    randomSeed: this.shapeAssistRandomSeed
                });

                if (rawT >= 1) {
                    resolve();
                } else {
                    requestAnimationFrame(frame);
                }
            };

            requestAnimationFrame(frame);
        });
    }

    private renderShapeAssistPreview(animated: boolean = false): void {
        if (!this.canvas || !this.shapeAssistHandles) return;
        const targetSamples = this.buildShapeAssistSamples(this.shapeAssistMode, Math.max(2, this.shapeAssistCurveSamples.length));
        this.updateShapeAssistHandles();

        if (!animated || this.shapeAssistRenderedSamples.length < 2) {
            this.shapeAssistPreviewAnimationToken++;
            this.applyShapeAssistPreviewSamples(targetSamples);
            return;
        }

        this.animateShapeAssistPreview(targetSamples);
    }

    private applyShapeAssistPreviewSamples(samples: StrokeSample[]): void {
        if (!this.canvas) return;
        this.canvas.replaceActiveLineWithPath(samples, {
            disableSmudging: this.canvas.brushUsesSmudging(),
            followAcceleration: 1,
            randomSeed: this.shapeAssistRandomSeed
        });
        this.shapeAssistRenderedSamples = this.cloneStrokeSamples(samples);
    }

    private animateShapeAssistPreview(targetSamples: StrokeSample[]): void {
        if (!this.canvas) return;
        const token = ++this.shapeAssistPreviewAnimationToken;
        const sourceSamples = this.cloneStrokeSamples(this.shapeAssistRenderedSamples);
        const startedAt = performance.now();

        const frame = (now: number) => {
            if (token !== this.shapeAssistPreviewAnimationToken || !this.canvas) return;

            const rawT = Math.min(1, (now - startedAt) / SHAPE_ASSIST_EDIT_MORPH_MS);
            const t = rawT * rawT * (3 - 2 * rawT);
            const samples = this.buildMorphSamples(sourceSamples, targetSamples, t);
            this.applyShapeAssistPreviewSamples(samples);

            if (rawT >= 1) {
                this.applyShapeAssistPreviewSamples(targetSamples);
            } else {
                requestAnimationFrame(frame);
            }
        };

        requestAnimationFrame(frame);
    }

    private buildMorphSamples(curveSamples: StrokeSample[], targetSamples: StrokeSample[], t: number): StrokeSample[] {
        const maxIndex = Math.max(1, curveSamples.length - 1);
        const targetMaxIndex = Math.max(1, targetSamples.length - 1);
        return curveSamples.map((sample, index) => {
            const target = targetSamples[Math.min(targetSamples.length - 1, Math.round((index / maxIndex) * targetMaxIndex))];
            return {
                point: Common.interpolatePoint(sample.point, target.point, t),
                stylus: this.interpolateStylus(sample.stylus, target.stylus, t)
            };
        });
    }

    private buildShapeAssistSamples(mode: ShapeAssistMode, count: number): StrokeSample[] {
        if (!this.shapeAssistHandles || !this.straightLineStartStylus) return [];
        if (mode === 'ellipse' || mode === 'circle') return this.buildEllipseSamples(count);
        if (mode === 'polyline') return this.buildPolylineSamples(count);
        if (mode === 'fit') return this.buildFitSamples(count);
        if (mode === 'bezier') return this.buildBezierSamples(count);
        return this.buildLineSamples(count);
    }

    private buildLineSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const start = handles.start;
        const startStylus = this.straightLineStartStylus!;
        const end = handles.end;
        const endStylus = this.lastStylus;
        const lastIndex = Math.max(1, count - 1);

        return Array.from({ length: Math.max(2, count) }, (_, index) => {
            const t = index / lastIndex;
            return {
                point: Common.interpolatePoint(start, end, t),
                stylus: this.interpolateStylus(startStylus, endStylus, t)
            };
        });
    }

    private buildBezierSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const start = handles.start;
        const startStylus = this.straightLineStartStylus!;
        const end = handles.end;
        const endStylus = this.lastStylus;
        const lastIndex = Math.max(1, count - 1);

        return Array.from({ length: Math.max(2, count) }, (_, index) => {
            const t = index / lastIndex;
            return {
                point: this.cubicBezierPoint(start, handles.control1, handles.control2, end, t),
                stylus: this.interpolateStylus(startStylus, endStylus, t)
            };
        });
    }

    private buildFitSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const points = [handles.start, ...handles.anchors, handles.end];
        const startStylus = this.straightLineStartStylus!;
        const endStylus = this.lastStylus;
        const sampleCount = Math.max(2, count);
        const lastIndex = sampleCount - 1;

        if (points.length <= 2) return this.buildLineSamples(sampleCount);

        return Array.from({ length: sampleCount }, (_, index) => {
            const t = index / lastIndex;
            return {
                point: this.catmullRomPoint(points, t),
                stylus: this.interpolateStylus(startStylus, endStylus, t)
            };
        });
    }

    private buildPolylineSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const points = [handles.start, ...handles.anchors, handles.end];
        const startStylus = this.straightLineStartStylus!;
        const endStylus = this.lastStylus;
        const sampleCount = Math.max(points.length, count);
        const lastIndex = sampleCount - 1;

        if (points.length <= 2) return this.buildLineSamples(sampleCount);

        const lengths: number[] = [];
        let totalLength = 0;
        for (let i = 1; i < points.length; i++) {
            totalLength += Common.distance(points[i - 1], points[i]);
            lengths.push(totalLength);
        }
        if (totalLength <= 0.001) return this.buildLineSamples(sampleCount);

        return Array.from({ length: sampleCount }, (_, index) => {
            const t = index / lastIndex;
            const targetLength = totalLength * t;
            let segmentIndex = lengths.findIndex((length) => length >= targetLength);
            if (segmentIndex < 0) segmentIndex = lengths.length - 1;
            const segmentStartLength = segmentIndex === 0 ? 0 : lengths[segmentIndex - 1];
            const segmentLength = Math.max(0.0001, lengths[segmentIndex] - segmentStartLength);
            const localT = Math.max(0, Math.min(1, (targetLength - segmentStartLength) / segmentLength));
            return {
                point: Common.interpolatePoint(points[segmentIndex], points[segmentIndex + 1], localT),
                stylus: this.interpolateStylus(startStylus, endStylus, t)
            };
        });
    }

    private buildEllipseSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const anchors = handles.anchors.length >= 4
            ? handles.anchors
            : this.createEllipseAnchorsFromSamples(this.shapeAssistCurveSamples);
        const axis = this.ellipseAxesFromAnchors(anchors);
        const sampleCount = Math.max(48, count);
        const startStylus = this.straightLineStartStylus!;
        const endStylus = this.lastStylus;

        return Array.from({ length: sampleCount + 1 }, (_, index) => {
            const t = index / sampleCount;
            const a = t * Math.PI * 2;
            return {
                point: new Point(
                    axis.center.x + Math.cos(a) * axis.axisA.x + Math.sin(a) * axis.axisB.x,
                    axis.center.y + Math.cos(a) * axis.axisA.y + Math.sin(a) * axis.axisB.y
                ),
                stylus: this.interpolateStylus(startStylus, endStylus, t)
            };
        });
    }

    private createShapeAssistHandles(mode: ShapeAssistMode): ShapeAssistHandles {
        const polylinePoints = mode === 'polyline' ? this.extractPolylinePoints(this.shapeAssistCurveSamples) : null;
        const start = polylinePoints?.[0].clone() ?? this.straightLineStartPos!.clone();
        const end = polylinePoints?.[polylinePoints.length - 1].clone() ?? this.lastPos.clone();
        const bounds = this.pointsBounds(this.shapeAssistCurveSamples.map((sample) => sample.point));
        const chord = Math.max(1, Common.distance(start, end));
        const startTangent = mode === 'bezier' ? this.strokeTangent(this.shapeAssistCurveSamples, true) : this.unitPoint(start, end);
        const endTangent = mode === 'bezier' ? this.strokeTangent(this.shapeAssistCurveSamples, false) : this.unitPoint(start, end);

        return {
            start,
            control1: new Point(start.x + startTangent.x * chord * 0.35, start.y + startTangent.y * chord * 0.35),
            control2: new Point(end.x - endTangent.x * chord * 0.35, end.y - endTangent.y * chord * 0.35),
            end,
            anchors: mode === 'fit'
                ? this.extractFitAnchors(this.shapeAssistCurveSamples)
                : mode === 'polyline' && polylinePoints
                    ? polylinePoints.slice(1, -1).map((point) => point.clone())
                : mode === 'ellipse'
                    ? this.createEllipseAnchorsFromSamples(this.shapeAssistCurveSamples)
                    : mode === 'circle'
                        ? this.createCircleAnchorsFromBounds(bounds)
                    : []
        };
    }

    private updateShapeAssistEnd(point: Point, stylus: Stylus): void {
        if (!this.shapeAssistHandles) {
            this.shapeAssistHandles = this.createShapeAssistHandles(this.shapeAssistMode);
        }

        const handles = this.shapeAssistHandles;
        const previousEnd = handles.end;
        const dx = point.x - previousEnd.x;
        const dy = point.y - previousEnd.y;
        handles.end = point.clone();
        handles.control2 = new Point(handles.control2.x + dx, handles.control2.y + dy);
        this.lastStylus = this.cloneStylus(stylus);
    }

    private selectShapeAssistMode(mode: ShapeAssistMode): void {
        if (this.shapeAssistMode === mode) return;
        const previousMode = this.shapeAssistMode;
        const previousHandles = this.shapeAssistHandles ? this.cloneShapeAssistHandles(this.shapeAssistHandles) : null;
        this.shapeAssistMode = mode;
        this.shapeAssistHandles = this.createShapeAssistHandles(mode);
        this.reuseEllipseGeometryForMode(previousMode, previousHandles, mode);
        this.updateShapeAssistRibbon();
        this.renderShapeAssistPreview(true);
        this.pushShapeAssistSnapshot();
    }

    private reuseEllipseGeometryForMode(previousMode: ShapeAssistMode, previousHandles: ShapeAssistHandles | null, mode: ShapeAssistMode): void {
        if (!previousHandles || previousHandles.anchors.length < 4 || !this.shapeAssistHandles) return;
        if ((previousMode !== 'ellipse' && previousMode !== 'circle') || (mode !== 'ellipse' && mode !== 'circle')) return;
        if (previousMode === 'circle' && mode === 'ellipse') return;

        const { center, axisA, axisB } = this.ellipseAxesFromAnchors(previousHandles.anchors);
        if (mode === 'ellipse') {
            this.shapeAssistHandles.anchors = previousHandles.anchors.map((anchor) => anchor.clone());
            return;
        }

        const radius = Math.max(1, (this.pointLength(axisA) + this.pointLength(axisB)) * 0.5);
        const nextAxisA = this.pointWithLength(axisA, radius);
        const nextAxisB = this.orientedPerpendicular(nextAxisA, axisB, radius);
        this.setEllipseAnchors(center, nextAxisA, nextAxisB);
    }

    private chooseShapeAssistMode(samples: StrokeSample[]): ShapeAssistMode {
        if (samples.length < 3) return 'line';
        const pathLength = this.strokePathLength(samples);
        if (pathLength <= 0) return 'line';
        const chord = Common.distance(samples[0].point, samples[samples.length - 1].point);
        if (chord / pathLength > 0.94) return 'line';
        if (this.extractPolylinePoints(samples)) return 'polyline';
        if (this.isClosedStroke(samples, pathLength)) return 'ellipse';
        return 'fit';
    }

    private isClosedStroke(samples: StrokeSample[], pathLength: number): boolean {
        if (samples.length < 8) return false;
        const points = samples.map((sample) => sample.point);
        const bounds = this.pointsBounds(points);
        const diagonal = Math.hypot(bounds.size.width, bounds.size.height);
        if (diagonal <= 1) return false;
        const closeDistance = Common.distance(samples[0].point, samples[samples.length - 1].point);
        return closeDistance <= diagonal * 0.2 && pathLength >= diagonal * 1.8;
    }

    private strokePathLength(samples: StrokeSample[]): number {
        let length = 0;
        for (let i = 1; i < samples.length; i++) {
            length += Common.distance(samples[i - 1].point, samples[i].point);
        }
        return length;
    }

    private extractPolylinePoints(samples: StrokeSample[]): Point[] | null {
        if (samples.length < 4) return null;

        const points = samples.map((sample) => sample.point);
        const bounds = this.pointsBounds(points);
        const diagonal = Math.hypot(bounds.size.width, bounds.size.height);
        if (diagonal <= 1) return null;

        const pathLength = this.strokePathLength(samples);
        const closed = this.isClosedStroke(samples, pathLength);
        const tolerance = Math.max(6, diagonal * 0.035);
        const simplified = closed
            ? this.simplifyClosedPoints(points, tolerance)
            : this.simplifyPoints(points, tolerance);
        const segmentCount = Math.max(0, simplified.length - 1);

        if (closed && segmentCount < 3) return null;
        if (!closed && segmentCount < 2) return null;
        if (segmentCount > 6) return null;
        if (this.polylineCornerCount(simplified, closed) < (closed ? 3 : 1)) return null;

        const error = this.polylineFitError(points, simplified);
        if (error.max > tolerance * 2.2 || error.average > tolerance * 0.85) return null;

        return simplified.map((point) => point.clone());
    }

    private simplifyClosedPoints(points: Point[], tolerance: number): Point[] {
        if (points.length <= 3) return points.map((point) => point.clone());

        const openPoints = points.slice();
        if (Common.distance(openPoints[0], openPoints[openPoints.length - 1]) <= tolerance * 2) {
            openPoints.pop();
        }
        if (openPoints.length <= 3) return [...openPoints.map((point) => point.clone()), openPoints[0].clone()];

        const first = openPoints[0];
        let splitIndex = 1;
        let splitDistance = -1;
        for (let i = 1; i < openPoints.length; i++) {
            const distance = Common.distance(first, openPoints[i]);
            if (distance > splitDistance) {
                splitDistance = distance;
                splitIndex = i;
            }
        }

        const loop = [...openPoints, first];
        const firstArc = this.simplifyPoints(loop.slice(0, splitIndex + 1), tolerance);
        const secondArc = this.simplifyPoints(loop.slice(splitIndex), tolerance);
        return firstArc.concat(secondArc.slice(1));
    }

    private polylineFitError(points: Point[], polyline: Point[]): { max: number; average: number } {
        let max = 0;
        let total = 0;
        for (const point of points) {
            const distance = this.pointPolylineDistance(point, polyline);
            max = Math.max(max, distance);
            total += distance;
        }
        return { max, average: total / Math.max(1, points.length) };
    }

    private pointPolylineDistance(point: Point, polyline: Point[]): number {
        let best = Infinity;
        for (let i = 1; i < polyline.length; i++) {
            best = Math.min(best, this.pointSegmentDistance(point, polyline[i - 1], polyline[i]));
        }
        return best;
    }

    private polylineCornerCount(points: Point[], closed: boolean): number {
        const end = closed ? points.length - 1 : points.length;
        let count = 0;
        for (let i = closed ? 0 : 1; i < (closed ? end : points.length - 1); i++) {
            const prev = points[(i - 1 + end) % end];
            const current = points[i];
            const next = points[(i + 1) % end];
            const angle = this.turnAngle(prev, current, next);
            if (angle > 0.38) count++;
        }
        return count;
    }

    private turnAngle(prev: Point, current: Point, next: Point): number {
        const ax = current.x - prev.x;
        const ay = current.y - prev.y;
        const bx = next.x - current.x;
        const by = next.y - current.y;
        const al = Math.hypot(ax, ay);
        const bl = Math.hypot(bx, by);
        if (al <= 0.001 || bl <= 0.001) return 0;
        const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)));
        return Math.acos(dot);
    }

    private extractFitAnchors(samples: StrokeSample[]): Point[] {
        if (samples.length < 3) return [];
        const points = samples.map((sample) => sample.point);
        const bbox = this.pointsBounds(points);
        const tolerance = Math.max(6, Math.hypot(bbox.size.width, bbox.size.height) * 0.045);
        const simplified = this.simplifyPoints(points, tolerance);
        const interior = simplified.slice(1, -1);
        const maxAnchors = 4;

        if (interior.length <= maxAnchors) return interior.map((point) => point.clone());

        return Array.from({ length: maxAnchors }, (_, index) => {
            const sourceIndex = Math.round(((index + 1) / (maxAnchors + 1)) * (interior.length - 1));
            return interior[sourceIndex].clone();
        });
    }

    private simplifyPoints(points: Point[], tolerance: number): Point[] {
        if (points.length <= 2) return points.map((point) => point.clone());

        let bestIndex = -1;
        let bestDistance = -1;
        const first = points[0];
        const last = points[points.length - 1];

        for (let i = 1; i < points.length - 1; i++) {
            const distance = this.pointLineDistance(points[i], first, last);
            if (distance > bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }

        if (bestDistance <= tolerance || bestIndex < 0) {
            return [first.clone(), last.clone()];
        }

        const left = this.simplifyPoints(points.slice(0, bestIndex + 1), tolerance);
        const right = this.simplifyPoints(points.slice(bestIndex), tolerance);
        return left.slice(0, -1).concat(right);
    }

    private pointLineDistance(point: Point, start: Point, end: Point): number {
        return this.pointSegmentDistance(point, start, end);
    }

    private pointSegmentDistance(point: Point, start: Point, end: Point): number {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq <= 0.0001) return Common.distance(point, start);
        const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
        const projection = new Point(start.x + dx * t, start.y + dy * t);
        return Common.distance(point, projection);
    }

    private pointsBounds(points: Point[]): Rect {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of points) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
        return new Rect(minX, minY, maxX - minX, maxY - minY);
    }

    private createEllipseAnchorsFromBounds(bounds: Rect): Point[] {
        const cx = bounds.origin.x + bounds.size.width * 0.5;
        const cy = bounds.origin.y + bounds.size.height * 0.5;
        return [
            new Point(bounds.origin.x, cy),
            new Point(bounds.origin.x + bounds.size.width, cy),
            new Point(cx, bounds.origin.y + bounds.size.height),
            new Point(cx, bounds.origin.y)
        ];
    }

    private createEllipseAnchorsFromSamples(samples: StrokeSample[]): Point[] {
        const points = samples.map((sample) => sample.point);
        if (points.length < 2) return this.createEllipseAnchorsFromBounds(this.pointsBounds(points));

        let meanX = 0;
        let meanY = 0;
        for (const point of points) {
            meanX += point.x;
            meanY += point.y;
        }
        meanX /= points.length;
        meanY /= points.length;

        let xx = 0;
        let xy = 0;
        let yy = 0;
        for (const point of points) {
            const dx = point.x - meanX;
            const dy = point.y - meanY;
            xx += dx * dx;
            xy += dx * dy;
            yy += dy * dy;
        }

        const axisConfidence = Math.hypot(xx - yy, 2 * xy) / Math.max(0.0001, xx + yy);
        if (axisConfidence < 0.18) {
            return this.createEllipseAnchorsFromBounds(this.pointsBounds(points));
        }

        const angle = Math.abs(xy) <= 0.0001 && Math.abs(xx - yy) <= 0.0001
            ? 0
            : 0.5 * Math.atan2(2 * xy, xx - yy);
        let axisAUnit = new Point(Math.cos(angle), Math.sin(angle));
        let axisBUnit = new Point(-axisAUnit.y, axisAUnit.x);
        let minA = Infinity;
        let maxA = -Infinity;
        let minB = Infinity;
        let maxB = -Infinity;
        for (const point of points) {
            const dx = point.x - meanX;
            const dy = point.y - meanY;
            const a = dx * axisAUnit.x + dy * axisAUnit.y;
            const b = dx * axisBUnit.x + dy * axisBUnit.y;
            minA = Math.min(minA, a);
            maxA = Math.max(maxA, a);
            minB = Math.min(minB, b);
            maxB = Math.max(maxB, b);
        }

        let radiusA = Math.max(1, (maxA - minA) * 0.5);
        let radiusB = Math.max(1, (maxB - minB) * 0.5);
        const centerOffsetA = (minA + maxA) * 0.5;
        const centerOffsetB = (minB + maxB) * 0.5;
        const center = new Point(
            meanX + axisAUnit.x * centerOffsetA + axisBUnit.x * centerOffsetB,
            meanY + axisAUnit.y * centerOffsetA + axisBUnit.y * centerOffsetB
        );

        if (radiusB > radiusA) {
            [radiusA, radiusB] = [radiusB, radiusA];
            [axisAUnit, axisBUnit] = [axisBUnit, new Point(-axisAUnit.x, -axisAUnit.y)];
        }

        const axisA = new Point(axisAUnit.x * radiusA, axisAUnit.y * radiusA);
        const axisB = new Point(axisBUnit.x * radiusB, axisBUnit.y * radiusB);
        return [
            new Point(center.x - axisA.x, center.y - axisA.y),
            new Point(center.x + axisA.x, center.y + axisA.y),
            new Point(center.x + axisB.x, center.y + axisB.y),
            new Point(center.x - axisB.x, center.y - axisB.y)
        ];
    }

    private createCircleAnchorsFromBounds(bounds: Rect): Point[] {
        const cx = bounds.origin.x + bounds.size.width * 0.5;
        const cy = bounds.origin.y + bounds.size.height * 0.5;
        const radius = Math.max(1, Math.max(bounds.size.width, bounds.size.height) * 0.5);
        return [
            new Point(cx - radius, cy),
            new Point(cx + radius, cy),
            new Point(cx, cy + radius),
            new Point(cx, cy - radius)
        ];
    }

    private ellipseAxesFromAnchors(anchors: Point[]): { center: Point; axisA: Point; axisB: Point } {
        const a0 = anchors[0];
        const a1 = anchors[1];
        const b0 = anchors[2];
        const b1 = anchors[3];
        const center = new Point(
            (a0.x + a1.x + b0.x + b1.x) * 0.25,
            (a0.y + a1.y + b0.y + b1.y) * 0.25
        );

        let axisA = new Point((a1.x - a0.x) * 0.5, (a1.y - a0.y) * 0.5);
        let axisB = new Point((b0.x - b1.x) * 0.5, (b0.y - b1.y) * 0.5);
        if (Math.hypot(axisA.x, axisA.y) < 1) axisA = new Point(1, 0);
        if (Math.hypot(axisB.x, axisB.y) < 1) axisB = this.perpendicularPoint(axisA, 1);

        return { center, axisA, axisB };
    }

    private updateEllipseAnchor(index: number, point: Point): void {
        const handles = this.shapeAssistHandles!;
        if (handles.anchors.length < 4) {
            handles.anchors = this.createEllipseAnchorsFromBounds(this.pointsBounds(this.shapeAssistCurveSamples.map((sample) => sample.point)));
        }

        const anchors = handles.anchors;
        const { center, axisA, axisB } = this.ellipseAxesFromAnchors(anchors);
        const radiusA = Math.max(1, Math.hypot(axisA.x, axisA.y));
        const radiusB = Math.max(1, Math.hypot(axisB.x, axisB.y));

        if (index === 0 || index === 1) {
            const sign = index === 0 ? -1 : 1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const nextAxisA = this.pointLength(dragged) >= 1 ? dragged : this.pointWithLength(axisA, radiusA);
            const nextAxisB = this.orientedPerpendicular(nextAxisA, axisB, radiusB);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        if (index === 2 || index === 3) {
            const sign = index === 2 ? 1 : -1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const nextAxisB = this.pointLength(dragged) >= 1 ? dragged : this.pointWithLength(axisB, radiusB);
            const nextAxisA = this.orientedPerpendicular(nextAxisB, axisA, radiusA, true);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        anchors[index] = point;
    }

    private updateCircleAnchor(index: number, point: Point): void {
        const handles = this.shapeAssistHandles!;
        if (handles.anchors.length < 4) {
            handles.anchors = this.createCircleAnchorsFromBounds(this.pointsBounds(this.shapeAssistCurveSamples.map((sample) => sample.point)));
        }

        const anchors = handles.anchors;
        const { center, axisA, axisB } = this.ellipseAxesFromAnchors(anchors);
        const fallbackRadius = Math.max(1, (this.pointLength(axisA) + this.pointLength(axisB)) * 0.5);

        if (index === 0 || index === 1) {
            const sign = index === 0 ? -1 : 1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const radius = Math.max(1, this.pointLength(dragged));
            const nextAxisA = radius > 1 ? this.pointWithLength(dragged, radius) : this.pointWithLength(axisA, fallbackRadius);
            const nextAxisB = this.orientedPerpendicular(nextAxisA, axisB, radius);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        if (index === 2 || index === 3) {
            const sign = index === 2 ? 1 : -1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const radius = Math.max(1, this.pointLength(dragged));
            const nextAxisB = radius > 1 ? this.pointWithLength(dragged, radius) : this.pointWithLength(axisB, fallbackRadius);
            const nextAxisA = this.orientedPerpendicular(nextAxisB, axisA, radius, true);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        anchors[index] = point;
    }

    private setEllipseAnchors(center: Point, axisA: Point, axisB: Point): void {
        const handles = this.shapeAssistHandles!;
        handles.anchors = [
            new Point(center.x - axisA.x, center.y - axisA.y),
            new Point(center.x + axisA.x, center.y + axisA.y),
            new Point(center.x + axisB.x, center.y + axisB.y),
            new Point(center.x - axisB.x, center.y - axisB.y)
        ];
    }

    private orientedPerpendicular(axis: Point, previousAxis: Point, length: number, clockwise = false): Point {
        let perpendicular = this.perpendicularPoint(axis, length);
        if (clockwise) perpendicular = new Point(-perpendicular.x, -perpendicular.y);
        if (perpendicular.x * previousAxis.x + perpendicular.y * previousAxis.y < 0) {
            perpendicular = new Point(-perpendicular.x, -perpendicular.y);
        }
        return perpendicular;
    }

    private perpendicularPoint(point: Point, length: number): Point {
        const currentLength = Math.max(0.0001, this.pointLength(point));
        return new Point((-point.y / currentLength) * length, (point.x / currentLength) * length);
    }

    private pointWithLength(point: Point, length: number): Point {
        const currentLength = Math.max(0.0001, this.pointLength(point));
        return new Point((point.x / currentLength) * length, (point.y / currentLength) * length);
    }

    private pointLength(point: Point): number {
        return Math.hypot(point.x, point.y);
    }

    private strokeTangent(samples: StrokeSample[], fromStart: boolean): Point {
        if (samples.length < 2) return new Point(1, 0);
        const baseIndex = fromStart ? 0 : samples.length - 1;
        const direction = fromStart ? 1 : -1;
        const base = samples[baseIndex].point;

        for (let offset = 1; offset < samples.length; offset++) {
            const sample = samples[baseIndex + offset * direction]?.point;
            if (!sample) break;
            const dx = fromStart ? sample.x - base.x : base.x - sample.x;
            const dy = fromStart ? sample.y - base.y : base.y - sample.y;
            const length = Math.hypot(dx, dy);
            if (length > 0.001) return new Point(dx / length, dy / length);
        }

        return new Point(1, 0);
    }

    private unitPoint(from: Point, to: Point): Point {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        if (length <= 0.001) return new Point(1, 0);
        return new Point(dx / length, dy / length);
    }

    private cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
        const s = 1 - t;
        const ss = s * s;
        const tt = t * t;
        const sss = ss * s;
        const ttt = tt * t;

        return new Point(
            p0.x * sss + p1.x * 3 * ss * t + p2.x * 3 * s * tt + p3.x * ttt,
            p0.y * sss + p1.y * 3 * ss * t + p2.y * 3 * s * tt + p3.y * ttt
        );
    }

    private catmullRomPoint(points: Point[], t: number): Point {
        const segmentCount = Math.max(1, points.length - 1);
        const scaled = Math.min(segmentCount - 0.000001, Math.max(0, t) * segmentCount);
        const i = Math.floor(scaled);
        const localT = scaled - i;
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[Math.min(points.length - 1, i + 1)];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        const tt = localT * localT;
        const ttt = tt * localT;

        return new Point(
            0.5 * ((2 * p1.x) + (-p0.x + p2.x) * localT + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * ttt),
            0.5 * ((2 * p1.y) + (-p0.y + p2.y) * localT + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * ttt)
        );
    }

    private cloneStrokeSamples(samples: StrokeSample[]): StrokeSample[] {
        return samples.map((sample) => ({
            point: sample.point.clone(),
            stylus: this.cloneStylus(sample.stylus)
        }));
    }

    private cloneStylus(stylus: Stylus): Stylus {
        return new Stylus(stylus.pressure, stylus.altitudeAngle, stylus.azimuthAngle);
    }

    private interpolateStylus(a: Stylus, b: Stylus, t: number): Stylus {
        const interpolate = (start: number, end: number): number => {
            if (!Number.isFinite(start) || !Number.isFinite(end)) return end;
            return start + (end - start) * t;
        };

        return new Stylus(
            interpolate(a.pressure, b.pressure),
            interpolate(a.altitudeAngle, b.altitudeAngle),
            interpolate(a.azimuthAngle, b.azimuthAngle)
        );
    }

    private showShapeAssistUI(): void {
        this.hideShapeAssistUI();

        const ribbon = document.createElement('div');
        ribbon.style.cssText = `
            position:absolute; left:50%; top:14px; transform:translateX(-50%);
            display:flex; align-items:center; gap:6px; padding:6px;
            background:rgba(32,34,38,.94); border:1px solid rgba(255,255,255,.16);
            border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.22); z-index:20;
            pointer-events:auto;
        `;
        ribbon.addEventListener('mousedown', (e) => e.stopPropagation());

        const lineBtn = this.shapeAssistButton('Line', () => this.selectShapeAssistMode('line'));
        lineBtn.dataset.mode = 'line';
        const smoothBtn = this.shapeAssistButton('Smooth', () => this.selectShapeAssistMode('bezier'));
        smoothBtn.dataset.mode = 'bezier';
        const fitBtn = this.shapeAssistButton('Fit', () => this.selectShapeAssistMode('fit'));
        fitBtn.dataset.mode = 'fit';
        const polylineBtn = this.shapeAssistButton('Polyline', () => this.selectShapeAssistMode('polyline'));
        polylineBtn.dataset.mode = 'polyline';
        const ellipseBtn = this.shapeAssistButton('Ellipse', () => this.selectShapeAssistMode('ellipse'));
        ellipseBtn.dataset.mode = 'ellipse';
        const circleBtn = this.shapeAssistButton('Circle', () => this.selectShapeAssistMode('circle'));
        circleBtn.dataset.mode = 'circle';
        const doneBtn = this.shapeAssistButton('Done', () => void this.commitShapeAssistContext());
        doneBtn.style.marginLeft = '6px';
        ribbon.appendChild(lineBtn);
        ribbon.appendChild(smoothBtn);
        ribbon.appendChild(fitBtn);
        ribbon.appendChild(polylineBtn);
        ribbon.appendChild(ellipseBtn);
        ribbon.appendChild(circleBtn);
        ribbon.appendChild(doneBtn);
        this.canvasContainer.appendChild(ribbon);
        this.shapeAssistRibbonEl = ribbon;

        const handles = document.createElement('div');
        handles.style.cssText = `position:absolute; inset:0; pointer-events:none; z-index:19;`;
        this.canvasContainer.appendChild(handles);
        this.shapeAssistHandlesEl = handles;

        this.updateShapeAssistRibbon();
        this.updateShapeAssistHandles();
        this.resetShapeAssistEditHistory();
        document.addEventListener('mousedown', this.onShapeAssistDocumentMouseDown, true);
    }

    private hideShapeAssistUI(): void {
        document.removeEventListener('mousedown', this.onShapeAssistDocumentMouseDown, true);
        this.shapeAssistRibbonEl?.remove();
        this.shapeAssistHandlesEl?.remove();
        this.shapeAssistRibbonEl = null;
        this.shapeAssistHandlesEl = null;
        this.shapeAssistDragKey = null;
        this.shapeAssistDragStartSnapshot = null;
    }

    private shapeAssistButton(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.textContent = label;
        button.style.cssText = `
            height:28px; padding:0 10px; border-radius:6px; border:1px solid rgba(255,255,255,.16);
            background:#3a3d42; color:#e9edf2; font-size:12px; font-weight:600; cursor:pointer;
        `;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return button;
    }

    private updateShapeAssistRibbon(): void {
        if (!this.shapeAssistRibbonEl) return;
        for (const button of Array.from(this.shapeAssistRibbonEl.querySelectorAll<HTMLButtonElement>('button[data-mode]'))) {
            const active = button.dataset.mode === this.shapeAssistMode;
            button.style.background = active ? '#4a90d9' : '#3a3d42';
            button.style.borderColor = active ? '#75b7f1' : 'rgba(255,255,255,.16)';
        }
    }

    private updateShapeAssistHandles(): void {
        if (!this.shapeAssistHandlesEl || !this.shapeAssistHandles) return;
        this.shapeAssistHandlesEl.replaceChildren();
        const keys: ShapeAssistHandleKey[] = this.shapeAssistMode === 'line'
            ? ['start', 'end']
            : this.shapeAssistMode === 'bezier'
                ? ['start', 'control1', 'control2', 'end']
                : this.shapeAssistMode === 'ellipse' || this.shapeAssistMode === 'circle'
                    ? ['ellipseCenter', ...this.shapeAssistHandles.anchors.map((_, index) => `anchor:${index}` as ShapeAssistHandleKey)]
                    : this.shapeAssistMode === 'polyline' && this.polylineHandlesAreClosed()
                        ? ['start', ...this.shapeAssistHandles.anchors.map((_, index) => `anchor:${index}` as ShapeAssistHandleKey)]
                    : ['start', ...this.shapeAssistHandles.anchors.map((_, index) => `anchor:${index}` as ShapeAssistHandleKey), 'end'];

        for (const key of keys) {
            const point = this.shapeAssistPointForHandle(key);
            const pos = this.canvasPointToContainer(point);
            const handle = document.createElement('div');
            const isControl = key === 'control1' || key === 'control2';
            const isAnchor = key.startsWith('anchor:');
            const isCenter = key === 'ellipseCenter';
            handle.style.cssText = `
                position:absolute; left:${pos.x}px; top:${pos.y}px; width:${isCenter ? 15 : 13}px; height:${isCenter ? 15 : 13}px;
                margin-left:${isCenter ? -7.5 : -6.5}px; margin-top:${isCenter ? -7.5 : -6.5}px; border-radius:50%;
                background:${isCenter ? '#f05a7e' : isControl ? '#f1b84a' : isAnchor ? '#5ad18d' : '#4a90d9'};
                border:2px solid #fff; box-shadow:0 2px 8px rgba(0,0,0,.3);
                pointer-events:auto; cursor:grab;
            `;
            handle.addEventListener('mousedown', (e) => this.beginShapeAssistHandleDrag(e, key));
            this.shapeAssistHandlesEl.appendChild(handle);
        }
    }

    private beginShapeAssistHandleDrag(e: MouseEvent, key: ShapeAssistHandleKey): void {
        e.preventDefault();
        e.stopPropagation();
        this.shapeAssistDragKey = key;
        this.shapeAssistDragStartSnapshot = this.currentShapeAssistSnapshot();
        document.addEventListener('mousemove', this.onShapeAssistHandleMove);
        document.addEventListener('mouseup', this.onShapeAssistHandleUp);
    }

    private onShapeAssistHandleMove = (e: MouseEvent): void => {
        if (!this.shapeAssistDragKey || !this.shapeAssistHandles) return;
        e.preventDefault();
        const point = this.clientPointToCanvasPoint(e.clientX, e.clientY);
        this.setShapeAssistHandlePoint(this.shapeAssistDragKey, point);
        if (this.shapeAssistDragKey === 'end') this.lastPos = point.clone();
        if (this.shapeAssistDragKey === 'start') this.straightLineStartPos = point.clone();
        this.renderShapeAssistPreview();
    };

    private onShapeAssistHandleUp = (): void => {
        const before = this.shapeAssistDragStartSnapshot;
        const after = this.currentShapeAssistSnapshot();
        this.shapeAssistDragKey = null;
        this.shapeAssistDragStartSnapshot = null;
        document.removeEventListener('mousemove', this.onShapeAssistHandleMove);
        document.removeEventListener('mouseup', this.onShapeAssistHandleUp);
        if (before && after && !this.shapeAssistSnapshotsEqual(before, after)) {
            this.pushShapeAssistSnapshot(after);
        }
    };

    private shapeAssistPointForHandle(key: ShapeAssistHandleKey): Point {
        const handles = this.shapeAssistHandles!;
        if (key === 'ellipseCenter') {
            return this.ellipseAxesFromAnchors(handles.anchors).center;
        }
        if (key.startsWith('anchor:')) {
            const index = Number(key.slice('anchor:'.length));
            return handles.anchors[index];
        }
        return handles[key];
    }

    private setShapeAssistHandlePoint(key: ShapeAssistHandleKey, point: Point): void {
        const handles = this.shapeAssistHandles!;
        if (key === 'ellipseCenter') {
            const currentCenter = this.ellipseAxesFromAnchors(handles.anchors).center;
            const dx = point.x - currentCenter.x;
            const dy = point.y - currentCenter.y;
            handles.anchors = handles.anchors.map((anchor) => new Point(anchor.x + dx, anchor.y + dy));
            return;
        }
        if (key.startsWith('anchor:')) {
            const index = Number(key.slice('anchor:'.length));
            if (this.shapeAssistMode === 'circle') {
                this.updateCircleAnchor(index, point);
                return;
            }
            if (this.shapeAssistMode === 'ellipse') {
                this.updateEllipseAnchor(index, point);
                return;
            }
            handles.anchors[index] = point;
            return;
        }
        const keepPolylineClosed = this.shapeAssistMode === 'polyline' && key === 'start' && this.polylineHandlesAreClosed();
        handles[key] = point;
        if (keepPolylineClosed) {
            handles.end = point.clone();
        }
    }

    private polylineHandlesAreClosed(): boolean {
        return this.shapeAssistMode === 'polyline'
            && !!this.shapeAssistHandles
            && Common.distance(this.shapeAssistHandles.start, this.shapeAssistHandles.end) < 0.01;
    }

    private onShapeAssistDocumentMouseDown = (e: MouseEvent): void => {
        if (!this.shapeAssistEditingContext) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (this.shapeAssistRibbonEl?.contains(target) || this.shapeAssistHandlesEl?.contains(target)) return;
        if (this.sizeSliderWrapEl?.contains(target) || this.opacitySliderWrapEl?.contains(target)) return;
        if (this.undoBtnEl?.contains(target) || this.redoBtnEl?.contains(target)) return;
        if (target === this.glCanvas) return;
        void this.commitShapeAssistContext();
    };

    private async commitShapeAssistContext(): Promise<void> {
        if (!this.shapeAssistEditingContext || !this.canvas || !this.straightLineUndoGroup) return;

        this.renderShapeAssistPreview();
        const fixerGroup = await this.canvas.commitStraightenedLine(this.straightLineUndoGroup);
        if (this.hasAnyFixer(fixerGroup) && this.hasAnyRedoFixer(fixerGroup)) {
            const layerId = this.canvasStack?.selectedLayer()?.id;
            if (!layerId) return;
            if (this.straightLineStrokeGroup && this.hasAnyFixer(this.straightLineStrokeGroup) && this.hasAnyRedoFixer(this.straightLineStrokeGroup)) {
                this.undoStack.push({ kind: 'drawing', layerId, fixerGroup: this.straightLineStrokeGroup });
            }
            this.undoStack.push({ kind: 'drawing', layerId, fixerGroup });
            this.redoStack = [];
            this.queueLayerThumbnailRefresh(layerId);
            this.updateUndoRedoButtons();
        }

        this.resetShapeAssistState();
    }

    private resetShapeAssistEditHistory(): void {
        this.shapeAssistUndoStack = [];
        this.shapeAssistRedoStack = [];
        const snapshot = this.currentShapeAssistSnapshot();
        if (snapshot) this.shapeAssistUndoStack.push(snapshot);
        this.updateUndoRedoButtons();
    }

    private pushShapeAssistSnapshot(snapshot: ShapeAssistSnapshot | null = this.currentShapeAssistSnapshot()): void {
        if (!snapshot) return;
        const current = this.shapeAssistUndoStack[this.shapeAssistUndoStack.length - 1];
        if (current && this.shapeAssistSnapshotsEqual(current, snapshot)) return;
        this.shapeAssistUndoStack.push(this.cloneShapeAssistSnapshot(snapshot));
        this.shapeAssistRedoStack = [];
        this.updateUndoRedoButtons();
    }

    private undoShapeAssistEdit(): void {
        if (this.shapeAssistUndoStack.length <= 1) return;
        const current = this.shapeAssistUndoStack.pop()!;
        this.shapeAssistRedoStack.push(current);
        this.applyShapeAssistSnapshot(this.shapeAssistUndoStack[this.shapeAssistUndoStack.length - 1]);
        this.updateUndoRedoButtons();
    }

    private redoShapeAssistEdit(): void {
        const next = this.shapeAssistRedoStack.pop();
        if (!next) return;
        this.shapeAssistUndoStack.push(next);
        this.applyShapeAssistSnapshot(next);
        this.updateUndoRedoButtons();
    }

    private currentShapeAssistSnapshot(): ShapeAssistSnapshot | null {
        if (!this.shapeAssistHandles) return null;
        return {
            mode: this.shapeAssistMode,
            handles: this.cloneShapeAssistHandles(this.shapeAssistHandles),
            size: this.currentSize,
            opacity: this.currentOpacity,
            randomSeed: this.shapeAssistRandomSeed
        };
    }

    private applyShapeAssistSnapshot(snapshot: ShapeAssistSnapshot): void {
        this.shapeAssistMode = snapshot.mode;
        this.shapeAssistHandles = this.cloneShapeAssistHandles(snapshot.handles);
        this.shapeAssistRandomSeed = snapshot.randomSeed;
        this.applyBrushSize(snapshot.size, false, false);
        this.applyBrushOpacity(snapshot.opacity, false, false);
        this.updateShapeAssistRibbon();
        this.renderShapeAssistPreview();
    }

    private cloneShapeAssistSnapshot(snapshot: ShapeAssistSnapshot): ShapeAssistSnapshot {
        return {
            mode: snapshot.mode,
            handles: this.cloneShapeAssistHandles(snapshot.handles),
            size: snapshot.size,
            opacity: snapshot.opacity,
            randomSeed: snapshot.randomSeed
        };
    }

    private cloneShapeAssistHandles(handles: ShapeAssistHandles): ShapeAssistHandles {
        return {
            start: handles.start.clone(),
            control1: handles.control1.clone(),
            control2: handles.control2.clone(),
            end: handles.end.clone(),
            anchors: handles.anchors.map((anchor) => anchor.clone())
        };
    }

    private shapeAssistSnapshotsEqual(a: ShapeAssistSnapshot, b: ShapeAssistSnapshot): boolean {
        return a.mode === b.mode
            && Math.abs(a.size - b.size) < 0.0001
            && Math.abs(a.opacity - b.opacity) < 0.0001
            && a.randomSeed === b.randomSeed
            && this.pointsAlmostEqual(a.handles.start, b.handles.start)
            && this.pointsAlmostEqual(a.handles.control1, b.handles.control1)
            && this.pointsAlmostEqual(a.handles.control2, b.handles.control2)
            && this.pointsAlmostEqual(a.handles.end, b.handles.end)
            && this.pointArraysAlmostEqual(a.handles.anchors, b.handles.anchors);
    }

    private pointArraysAlmostEqual(a: Point[], b: Point[]): boolean {
        if (a.length !== b.length) return false;
        return a.every((point, index) => this.pointsAlmostEqual(point, b[index]));
    }

    private pointsAlmostEqual(a: Point, b: Point): boolean {
        return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    }

    private resetShapeAssistState(): void {
        this.hideShapeAssistUI();
        this.straightLinePreviewActive = false;
        this.shapeAssistEditingContext = false;
        this.straightLineActivating = false;
        this.straightLineActivationPromise = null;
        this.straightLineSamples = [];
        this.shapeAssistCurveSamples = [];
        this.shapeAssistRandomSeed = 0;
        this.shapeAssistPreviewAnimationToken++;
        this.shapeAssistRenderedSamples = [];
        this.shapeAssistHandles = null;
        this.shapeAssistDragStartSnapshot = null;
        this.shapeAssistUndoStack = [];
        this.shapeAssistRedoStack = [];
        this.straightLineStrokeGroup = null;
        this.straightLineUndoGroup = null;
        this.straightLineStartPos = null;
        this.straightLineStartStylus = null;
    }

    private canvasPointToContainer(point: Point): Point {
        const rect = this.glCanvas.getBoundingClientRect();
        const stage = this.viewportTransform().applyToPoint(this.canvasPointToStagePoint(point));
        return new Point(
            ((stage.x + 1) * 0.5) * rect.width,
            ((1 - stage.y) * 0.5) * rect.height
        );
    }

    private clientPointToCanvasPoint(clientX: number, clientY: number): Point {
        const stage = this.inverseViewportTransform().applyToPoint(this.clientPointToScreenStagePoint(clientX, clientY));
        return this.stagePointToCanvasPoint(stage);
    }

    private clientPointToScreenStagePoint(clientX: number, clientY: number): Point {
        const rect = this.glCanvas.getBoundingClientRect();
        return new Point(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            1 - ((clientY - rect.top) / rect.height) * 2
        );
    }

    private canvasPointToStagePoint(point: Point): Point {
        return new Point(
            (point.x / this.canvasWidth) * 2 - 1,
            (point.y / this.canvasHeight) * 2 - 1
        );
    }

    private stagePointToCanvasPoint(point: Point): Point {
        return new Point(
            ((point.x + 1) * 0.5) * this.canvasWidth,
            ((point.y + 1) * 0.5) * this.canvasHeight
        );
    }

    private eventPoint(e: MouseEvent | TouchEvent): Point {
        const rect = this.glCanvas.getBoundingClientRect();
        let clientX: number, clientY: number;

        if (e instanceof MouseEvent) {
            clientX = e.clientX;
            clientY = e.clientY;
        } else {
            clientX = e.touches[0]?.clientX ?? 0;
            clientY = e.touches[0]?.clientY ?? 0;
        }

        return this.clientPointToCanvasPoint(clientX, clientY);
    }

    private eventStylus(e: MouseEvent | TouchEvent): Stylus {
        if (e instanceof MouseEvent) return new Stylus();

        const touch = e.touches[0];
        if ((touch as any).touchType === 'stylus') {
            const pressure = this.stylusEventCount < 2 ? 0 : touch.force;
            this.stylusEventCount++;
            const altitude = 1.0 - (touch as any).altitudeAngle / (0.5 * Math.PI);
            const azimuth = 0.25 - (touch as any).azimuthAngle / (2 * Math.PI);
            return new Stylus(pressure, altitude, azimuth);
        }
        return new Stylus();
    }

    // ---- Undo / Redo ----

    private pushCanvasHistory(canvas: Canvas, fixerGroup: FixerGroup): void {
        const layerId = this.canvasStack?.layerIdForCanvas(canvas);
        if (!layerId) return;
        this.pushHistory(layerId, fixerGroup);
    }

    private pushHistory(layerId: string, fixerGroup: FixerGroup): void {
        this.undoStack.push({ kind: 'drawing', layerId, fixerGroup });
        this.redoStack = [];
        this.queueLayerThumbnailRefresh(layerId);
        this.updateUndoRedoButtons();
    }

    private pushLayerPropertyHistory(
        layerId: string,
        property: LayerHistoryProperty,
        before: string | number | boolean,
        after: string | number | boolean
    ): void {
        if (before === after) return;
        this.undoStack.push({ kind: 'layer-property', layerId, property, before, after });
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    private pushLayerOrderHistory(before: string[], after: string[]): void {
        if (before.length !== after.length || before.every((id, index) => id === after[index])) return;
        this.undoStack.push({ kind: 'layer-order', before, after });
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    private pushLayerAddDeleteHistory(entry: LayerAddDeleteHistoryEntry): void {
        this.undoStack.push(entry);
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    private pushLayerMergeDownHistory(entry: LayerMergeDownHistoryEntry): void {
        this.undoStack.push(entry);
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    private pushLayerFlattenVisibleHistory(entry: LayerFlattenVisibleHistoryEntry): void {
        this.undoStack.push(entry);
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    private pushSelectedHistory(fixerGroup: FixerGroup): void {
        const layerId = this.canvasStack?.selectedLayer()?.id;
        if (!layerId) return;
        this.pushHistory(layerId, fixerGroup);
    }

    private async clearWithHistory(): Promise<void> {
        if (!this.canvas) return;
        if (this.selectedLayerIsLocked()) return;

        const group = new FixerGroup();
        group.undoFixer = (await this.canvas.fixer()) || undefined;

        this.canvas.clear();

        group.redoFixer = (await this.canvas.fixer()) || undefined;

        if (!group.undoFixer) return;

        this.pushSelectedHistory(group);
    }

    private async undo(): Promise<void> {
        if (this.shapeAssistEditingContext) {
            this.undoShapeAssistEdit();
            return;
        }
        if (this.floodFillEditingContext) {
            void this.undoFloodFillEdit();
            return;
        }
        if (this.undoStack.length === 0) return;
        if (this.pendingFillHistoryCount > 0) return;
        const entry = this.undoStack.pop()!;
        if (!this.canUndoEntry(entry)) {
            this.updateUndoRedoButtons();
            return;
        }

        await this.applyHistoryEntry(entry, true);
        this.redoStack.push(entry);
        this.updateUndoRedoButtons();
    }

    private async redo(): Promise<void> {
        if (this.shapeAssistEditingContext) {
            this.redoShapeAssistEdit();
            return;
        }
        if (this.floodFillEditingContext) {
            void this.redoFloodFillEdit();
            return;
        }
        if (this.redoStack.length === 0) return;
        const entry = this.redoStack.pop()!;
        if (!this.canRedoEntry(entry)) {
            this.updateUndoRedoButtons();
            return;
        }

        await this.applyHistoryEntry(entry, false);
        this.undoStack.push(entry);
        this.updateUndoRedoButtons();
    }

    private updateUndoRedoButtons(): void {
        if (!this.undoBtnEl || !this.redoBtnEl) return;
        if (this.shapeAssistEditingContext) {
            this.undoBtnEl.disabled = this.shapeAssistUndoStack.length <= 1;
            this.redoBtnEl.disabled = this.shapeAssistRedoStack.length === 0;
            return;
        }
        if (this.floodFillEditingContext) {
            this.undoBtnEl.disabled = this.fillInProgress;
            this.redoBtnEl.disabled = this.fillInProgress || this.floodFillRedoStack.length === 0;
            return;
        }
        const undoTop = this.undoStack[this.undoStack.length - 1];
        const redoTop = this.redoStack[this.redoStack.length - 1];
        this.undoBtnEl.disabled = this.pendingFillHistoryCount > 0 || !this.canUndoEntry(undoTop);
        this.redoBtnEl.disabled = !this.canRedoEntry(redoTop);
    }

    private hasAnyFixer(group?: FixerGroup): boolean {
        return !!(group?.undoFixer || group?.undoFixerLiquid);
    }

    private hasAnyRedoFixer(group?: FixerGroup): boolean {
        return !!(group?.redoFixer || group?.redoFixerLiquid);
    }

    private canUndoEntry(entry?: HistoryEntry): boolean {
        if (!entry) return false;
        switch (entry.kind) {
            case 'drawing':
                return this.hasAnyFixer(entry.fixerGroup);
            case 'layer-property':
                return !!this.canvasStack?.layerForId(entry.layerId);
            case 'layer-add':
                return !!this.canvasStack?.layerForId(entry.layer.id);
            case 'layer-delete':
                return !this.canvasStack?.layerForId(entry.layer.id);
            case 'layer-order':
                return !!this.canvasStack && entry.before.every((id) => !!this.canvasStack!.layerForId(id));
            case 'layer-merge-down':
                return !!this.canvasStack
                    && !!this.canvasStack.layerForId(entry.targetLayerId)
                    && !this.canvasStack.layerForId(entry.sourceLayer.id)
                    && this.hasAnyFixer(entry.targetFixerGroup);
            case 'layer-flatten-visible':
                return !!this.canvasStack
                    && !!this.canvasStack.layerForId(entry.targetLayerId)
                    && entry.removedLayers.every((item) => !this.canvasStack!.layerForId(item.layer.id))
                    && this.hasAnyFixer(entry.targetFixerGroup);
        }
    }

    private canRedoEntry(entry?: HistoryEntry): boolean {
        if (!entry) return false;
        switch (entry.kind) {
            case 'drawing':
                return this.hasAnyRedoFixer(entry.fixerGroup);
            case 'layer-property':
                return !!this.canvasStack?.layerForId(entry.layerId);
            case 'layer-add':
                return !this.canvasStack?.layerForId(entry.layer.id);
            case 'layer-delete':
                return !!this.canvasStack?.layerForId(entry.layer.id);
            case 'layer-order':
                return !!this.canvasStack && entry.after.every((id) => !!this.canvasStack!.layerForId(id));
            case 'layer-merge-down':
                return !!this.canvasStack
                    && !!this.canvasStack.layerForId(entry.targetLayerId)
                    && !!this.canvasStack.layerForId(entry.sourceLayer.id)
                    && this.hasAnyRedoFixer(entry.targetFixerGroup);
            case 'layer-flatten-visible':
                return !!this.canvasStack
                    && !!this.canvasStack.layerForId(entry.targetLayerId)
                    && entry.removedLayers.every((item) => !!this.canvasStack!.layerForId(item.layer.id))
                    && this.hasAnyRedoFixer(entry.targetFixerGroup);
        }
    }

    private async applyHistoryEntry(entry: HistoryEntry, undoing: boolean): Promise<void> {
        if (entry.kind === 'drawing') {
            const group = entry.fixerGroup;
            const targetCanvas = this.canvasStack?.layerForId(entry.layerId)?.canvas;
            if (undoing) {
                if (group.undoFixerLiquid) await targetCanvas?.fix(group.undoFixerLiquid, true);
                else if (group.undoFixer) await targetCanvas?.fix(group.undoFixer, false);
            } else {
                if (group.redoFixerLiquid) await targetCanvas?.fix(group.redoFixerLiquid, true);
                else if (group.redoFixer) await targetCanvas?.fix(group.redoFixer, false);
            }
            this.queueLayerThumbnailRefresh(entry.layerId);
            return;
        }

        switch (entry.kind) {
            case 'layer-order':
                this.canvasStack?.setLayerOrder(undoing ? entry.before : entry.after);
                this.refreshLayerPanel();
                return;
            case 'layer-add':
            case 'layer-delete':
                this.applyLayerAddDeleteHistory(entry, undoing);
                return;
            case 'layer-merge-down':
                await this.applyLayerMergeDownHistory(entry, undoing);
                return;
            case 'layer-flatten-visible':
                await this.applyLayerFlattenVisibleHistory(entry, undoing);
                return;
            case 'layer-property':
                this.applyLayerPropertyHistory(entry.layerId, entry.property, undoing ? entry.before : entry.after);
                return;
        }
    }

    private applyLayerAddDeleteHistory(entry: LayerAddDeleteHistoryEntry, undoing: boolean): void {
        if (!this.canvasStack) return;
        const shouldExist = entry.kind === 'layer-delete' ? undoing : !undoing;
        if (shouldExist) {
            this.canvasStack.restoreLayer(entry.layer, entry.index, true);
        } else {
            this.canvasStack.detachLayer(entry.layer.id);
        }

        const targetSelection = undoing ? entry.selectedLayerIdBefore : entry.selectedLayerIdAfter;
        if (targetSelection && this.canvasStack.layerForId(targetSelection)) {
            this.selectLayer(targetSelection);
        } else {
            this.canvas = this.canvasStack.selectedCanvas;
            this.refreshLayerPanel();
        }
    }

    private async applyLayerMergeDownHistory(entry: LayerMergeDownHistoryEntry, undoing: boolean): Promise<void> {
        if (!this.canvasStack) return;
        const targetCanvas = this.canvasStack.layerForId(entry.targetLayerId)?.canvas;
        if (!targetCanvas) return;

        if (undoing) {
            if (entry.targetFixerGroup.undoFixer) await targetCanvas.fix(entry.targetFixerGroup.undoFixer, false);
            this.canvasStack.restoreLayer(entry.sourceLayer, entry.sourceIndex, true);
        } else {
            if (entry.targetFixerGroup.redoFixer) await targetCanvas.fix(entry.targetFixerGroup.redoFixer, false);
            this.canvasStack.detachLayer(entry.sourceLayer.id);
        }

        const targetSelection = undoing ? entry.selectedLayerIdBefore : entry.selectedLayerIdAfter;
        if (targetSelection && this.canvasStack.layerForId(targetSelection)) {
            this.selectLayer(targetSelection);
        } else {
            this.canvas = this.canvasStack.selectedCanvas;
            this.refreshLayerPanel();
        }
        this.canvasStack.updateCanvas();
    }

    private async applyLayerFlattenVisibleHistory(entry: LayerFlattenVisibleHistoryEntry, undoing: boolean): Promise<void> {
        if (!this.canvasStack) return;
        const targetLayer = this.canvasStack.layerForId(entry.targetLayerId);
        if (!targetLayer) return;

        if (undoing) {
            if (entry.targetFixerGroup.undoFixer) await targetLayer.canvas.fix(entry.targetFixerGroup.undoFixer, false);
            this.canvasStack.renameLayer(entry.targetLayerId, entry.targetNameBefore);
            for (const removed of entry.removedLayers) {
                this.canvasStack.restoreLayer(removed.layer, removed.index, false);
            }
        } else {
            if (entry.targetFixerGroup.redoFixer) await targetLayer.canvas.fix(entry.targetFixerGroup.redoFixer, false);
            this.canvasStack.renameLayer(entry.targetLayerId, entry.targetNameAfter);
            for (let i = entry.removedLayers.length - 1; i >= 0; i--) {
                this.canvasStack.detachLayer(entry.removedLayers[i].layer.id);
            }
        }

        const targetSelection = undoing ? entry.selectedLayerIdBefore : entry.selectedLayerIdAfter;
        if (targetSelection && this.canvasStack.layerForId(targetSelection)) {
            this.selectLayer(targetSelection);
        } else {
            this.canvas = this.canvasStack.selectedCanvas;
            this.refreshLayerPanel();
        }
        this.canvasStack.updateCanvas();
    }

    private applyLayerPropertyHistory(layerId: string, property: LayerHistoryProperty, value: string | number | boolean): void {
        if (!this.canvasStack?.layerForId(layerId)) return;
        switch (property) {
            case 'name':
                this.canvasStack.renameLayer(layerId, String(value));
                break;
            case 'visible':
                this.canvasStack.setLayerVisible(layerId, Boolean(value));
                break;
            case 'opacity':
                this.canvasStack.setLayerOpacity(layerId, Number(value));
                break;
            case 'blendMode':
                this.canvasStack.setLayerBlendMode(layerId, value as LayerBlendMode);
                break;
            case 'locked':
                this.canvasStack.setLayerLocked(layerId, Boolean(value));
                break;
            case 'alphaLock':
                this.canvasStack.setLayerAlphaLock(layerId, Boolean(value));
                break;
        }
        this.refreshLayerPanel();
    }

    // ---- Color ----

    private applyHexColor(hex: string): void {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        this.currentColor = new Color(r, g, b, 1);
        if (this.canvasStack) this.canvasStack.color = this.currentColor.clone();
        else this.canvas?.setColor(this.currentColor.clone());
    }

    private selectPaletteSwatch(swatch: HTMLButtonElement): void {
        if (this.selectedSwatch) {
            this.selectedSwatch.style.borderColor = 'transparent';
            this.selectedSwatch.style.boxShadow = 'none';
            this.selectedSwatch.style.transform = '';
        }
        this.selectedSwatch = swatch;
        swatch.style.borderColor = '#fff';
        swatch.style.boxShadow = '0 0 0 1px rgba(255,255,255,.35)';
        swatch.style.transform = 'scale(1.08)';
    }

    private clearPaletteSelection(): void {
        if (!this.selectedSwatch) return;
        this.selectedSwatch.style.borderColor = 'transparent';
        this.selectedSwatch.style.boxShadow = 'none';
        this.selectedSwatch.style.transform = '';
        this.selectedSwatch = null;
    }

    private buildToolSection(): HTMLElement {
        const wrap = document.createElement('div');
        const lbl = document.createElement('label');
        lbl.textContent = 'Tool';
        lbl.style.cssText = `display:block; font-size:11px; color:#9a9a9a; margin-bottom:5px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        wrap.appendChild(lbl);

        const row = document.createElement('div');
        row.style.cssText = `display:grid; grid-template-columns:1fr 1fr; gap:5px;`;

        this.brushToolBtn = this.toolButton('Brush', () => this.setTool('brush'));
        this.fillToolBtn = this.toolButton('Fill', () => this.setTool('fill'));
        row.appendChild(this.brushToolBtn);
        row.appendChild(this.fillToolBtn);
        wrap.appendChild(row);

        this.updateToolButtons();
        return wrap;
    }

    private buildBrushSizeSlider(): HTMLElement {
        const { wrap, input, valueEl } = this.brushControlSlider('Size', 0, 0.5, 0.001, this.currentSize, 2);
        this.sizeSliderWrapEl = wrap;
        this.sizeSliderEl = input;
        this.sizeValueEl = valueEl;
        input.addEventListener('input', () => this.applyBrushSize(Number(input.value), true));
        input.addEventListener('change', () => this.pushShapeAssistSnapshotForBrushControl());
        return wrap;
    }

    private buildBrushOpacitySlider(): HTMLElement {
        const { wrap, input, valueEl } = this.brushControlSlider('Opacity', 0, 1, 0.05, this.currentOpacity, 2);
        this.opacitySliderWrapEl = wrap;
        this.opacitySliderEl = input;
        this.opacityValueEl = valueEl;
        input.addEventListener('input', () => this.applyBrushOpacity(Number(input.value), true));
        input.addEventListener('change', () => this.pushShapeAssistSnapshotForBrushControl());
        return wrap;
    }

    private brushControlSlider(labelText: string, min: number, max: number, step: number, initial: number, decimals: number): { wrap: HTMLElement; input: HTMLInputElement; valueEl: HTMLElement } {
        const wrap = document.createElement('div');
        const header = document.createElement('div');
        header.style.cssText = `display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;`;
        const lbl = document.createElement('span');
        lbl.textContent = labelText;
        lbl.style.cssText = `font-size:11px; color:#9a9a9a; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        const valueEl = document.createElement('span');
        valueEl.style.cssText = `font-size:11px; color:#7a9fc0;`;
        valueEl.textContent = initial.toFixed(decimals);
        header.appendChild(lbl);
        header.appendChild(valueEl);
        wrap.appendChild(header);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(initial);
        input.style.cssText = `width:100%; accent-color:#4a90d9; cursor:pointer;`;
        wrap.appendChild(input);
        return { wrap, input, valueEl };
    }

    private applyBrushSize(value: number, fromUser: boolean = false, refreshPreview: boolean = true): void {
        this.currentSize = value;
        if (this.canvasStack) this.canvasStack.brushSize = value;
        else this.canvas?.lineDriver.setBrushSize(value);
        this.updateBrushControlSliders();
        if (refreshPreview && this.shapeAssistEditingContext) {
            this.renderShapeAssistPreview(true);
        }
        if (fromUser) this.saveState();
    }

    private applyBrushOpacity(value: number, fromUser: boolean = false, refreshPreview: boolean = true): void {
        this.currentOpacity = value;
        if (this.canvasStack) this.canvasStack.brushOpacity = value;
        else this.canvas?.lineDriver.setBrushOpacity(value);
        this.updateBrushControlSliders();
        if (refreshPreview && this.shapeAssistEditingContext) {
            this.renderShapeAssistPreview(true);
        }
        if (fromUser) this.saveState();
    }

    private updateBrushControlSliders(): void {
        if (this.sizeSliderEl) this.sizeSliderEl.value = String(this.currentSize);
        if (this.sizeValueEl) this.sizeValueEl.textContent = this.currentSize.toFixed(2);
        if (this.opacitySliderEl) this.opacitySliderEl.value = String(this.currentOpacity);
        if (this.opacityValueEl) this.opacityValueEl.textContent = this.currentOpacity.toFixed(2);
    }

    private pushShapeAssistSnapshotForBrushControl(): void {
        if (this.shapeAssistEditingContext) {
            this.pushShapeAssistSnapshot();
        }
    }

    private buildViewportSection(): HTMLElement {
        const wrap = document.createElement('div');
        const header = document.createElement('div');
        header.style.cssText = `display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;`;

        const label = document.createElement('span');
        label.textContent = 'View';
        label.style.cssText = `font-size:11px; color:#9a9a9a; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        this.viewportValueEl = document.createElement('span');
        this.viewportValueEl.style.cssText = `font-size:11px; color:#7a9fc0;`;
        header.appendChild(label);
        header.appendChild(this.viewportValueEl);
        wrap.appendChild(header);

        const controls = document.createElement('div');
        controls.style.cssText = `display:grid; grid-template-columns:1fr 1fr 1fr; gap:5px;`;
        controls.appendChild(this.layerMiniButton('-', 'Zoom out', () => this.zoomViewportAtCenter(1 / 1.2)));
        controls.appendChild(this.layerMiniButton('+', 'Zoom in', () => this.zoomViewportAtCenter(1.2)));
        controls.appendChild(this.layerMiniButton('Reset', 'Reset view', () => this.resetViewport()));
        wrap.appendChild(controls);

        const rotateControls = document.createElement('div');
        rotateControls.style.cssText = `display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-top:5px;`;
        rotateControls.appendChild(this.layerMiniButton('Rot -', 'Rotate view counterclockwise', () => this.rotateViewportAtCenter(-15)));
        rotateControls.appendChild(this.layerMiniButton('Rot +', 'Rotate view clockwise', () => this.rotateViewportAtCenter(15)));
        wrap.appendChild(rotateControls);
        this.updateViewportUI();
        return wrap;
    }

    private viewportTransform(): AffineTransform {
        const aspect = this.canvasWidth / Math.max(1, this.canvasHeight);
        const radians = this.viewportRotation * 0.017453292519943295;
        const cos = Math.cos(radians) * this.viewportScale;
        const sin = Math.sin(radians) * this.viewportScale;
        return new AffineTransform(
            cos,
            sin * aspect,
            -sin / aspect,
            cos,
            this.viewportPanX,
            this.viewportPanY
        );
    }

    private inverseViewportTransform(): AffineTransform {
        return this.viewportTransform().inverse();
    }

    private zoomViewportAtCenter(factor: number): void {
        this.zoomViewport(factor, new Point(0, 0));
    }

    private zoomViewport(factor: number, screenStagePoint: Point): void {
        const before = this.inverseViewportTransform().applyToPoint(screenStagePoint);
        this.viewportScale = Math.max(0.1, Math.min(16, this.viewportScale * factor));
        this.setViewportPanForAnchor(before, screenStagePoint);
        this.updateViewportUI();
        this.updateShapeAssistHandles();
    }

    private rotateViewportAtCenter(deltaDegrees: number): void {
        this.rotateViewport(deltaDegrees, new Point(0, 0));
    }

    private rotateViewport(deltaDegrees: number, screenStagePoint: Point): void {
        const before = this.inverseViewportTransform().applyToPoint(screenStagePoint);
        this.viewportRotation = this.normalizeViewportRotation(this.viewportRotation + deltaDegrees);
        this.setViewportPanForAnchor(before, screenStagePoint);
        this.updateViewportUI();
        this.updateShapeAssistHandles();
    }

    private setViewportPanForAnchor(canvasStagePoint: Point, screenStagePoint: Point): void {
        const previousPanX = this.viewportPanX;
        const previousPanY = this.viewportPanY;
        this.viewportPanX = 0;
        this.viewportPanY = 0;
        const projected = this.viewportTransform().applyToPoint(canvasStagePoint);
        this.viewportPanX = previousPanX;
        this.viewportPanY = previousPanY;
        this.viewportPanX = screenStagePoint.x - projected.x;
        this.viewportPanY = screenStagePoint.y - projected.y;
    }

    private normalizeViewportRotation(degrees: number): number {
        let next = degrees % 360;
        if (next > 180) next -= 360;
        if (next < -180) next += 360;
        return next;
    }

    private resetViewport(): void {
        this.viewportScale = 1;
        this.viewportRotation = 0;
        this.viewportPanX = 0;
        this.viewportPanY = 0;
        this.updateViewportUI();
        this.updateShapeAssistHandles();
    }

    private updateViewportUI(): void {
        if (this.viewportValueEl) {
            const rotation = Math.round(this.viewportRotation);
            this.viewportValueEl.textContent = `${Math.round(this.viewportScale * 100)}% / ${rotation}deg`;
        }
        this.updateCanvasFrame();
    }

    private updateCanvasFrame(): void {
        if (!this.canvasFrameEl || !this.glCanvas) return;
        const rect = this.glCanvas.getBoundingClientRect();
        const tx = (this.viewportPanX * rect.width) * 0.5;
        const ty = (-this.viewportPanY * rect.height) * 0.5;
        this.canvasFrameEl.style.transform = `translate(${tx}px, ${ty}px) rotate(${-this.viewportRotation}deg) scale(${this.viewportScale})`;
    }

    private onCanvasWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomViewport(factor, this.clientPointToScreenStagePoint(e.clientX, e.clientY));
    };

    private onDocumentKeyDown = (e: KeyboardEvent): void => {
        if (this.isTextEditingTarget(e.target)) return;
        if (e.code === 'Space') {
            e.preventDefault();
            this.spaceKeyDown = true;
            if (!this.isViewportPanning) this.glCanvas.style.cursor = 'grab';
            return;
        }
        if (e.code === 'Digit0') {
            e.preventDefault();
            this.resetViewport();
            return;
        }
        if (e.code === 'Minus') {
            e.preventDefault();
            this.zoomViewportAtCenter(1 / 1.2);
            return;
        }
        if (e.code === 'Equal') {
            e.preventDefault();
            this.zoomViewportAtCenter(1.2);
            return;
        }
        if (e.code === 'BracketLeft') {
            e.preventDefault();
            this.rotateViewportAtCenter(-15);
            return;
        }
        if (e.code === 'BracketRight') {
            e.preventDefault();
            this.rotateViewportAtCenter(15);
        }
    };

    private onDocumentKeyUp = (e: KeyboardEvent): void => {
        if (e.code !== 'Space') return;
        this.spaceKeyDown = false;
        if (!this.isViewportPanning) this.glCanvas.style.cursor = 'crosshair';
    };

    private isTextEditingTarget(target: EventTarget | null): boolean {
        const el = target as HTMLElement | null;
        if (!el) return false;
        return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
    }

    private buildLayerSection(): HTMLElement {
        const wrap = document.createElement('div');
        const header = document.createElement('div');
        header.style.cssText = `display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;`;

        const label = document.createElement('span');
        label.textContent = 'Layers';
        label.style.cssText = `font-size:11px; color:#9a9a9a; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        header.appendChild(label);

        const actions = document.createElement('div');
        actions.style.cssText = `display:flex; gap:4px;`;
        this.addLayerBtnEl = this.layerIconButton('+', 'Add layer', () => this.addLayer());
        this.duplicateLayerBtnEl = this.layerIconButton('D', 'Duplicate selected layer', () => this.duplicateSelectedLayer());
        this.mergeDownLayerBtnEl = this.layerIconButton('M', 'Merge selected layer down', () => { void this.mergeSelectedLayerDown(); });
        this.flattenVisibleLayerBtnEl = this.layerIconButton('F', 'Flatten visible layers', () => { void this.flattenVisibleLayers(); });
        this.deleteLayerBtnEl = this.layerIconButton('-', 'Delete selected layer', () => this.deleteSelectedLayer());
        actions.appendChild(this.addLayerBtnEl);
        actions.appendChild(this.duplicateLayerBtnEl);
        actions.appendChild(this.mergeDownLayerBtnEl);
        actions.appendChild(this.flattenVisibleLayerBtnEl);
        actions.appendChild(this.deleteLayerBtnEl);
        header.appendChild(actions);
        wrap.appendChild(header);

        this.layerListEl = document.createElement('div');
        this.layerListEl.style.cssText = `display:flex; flex-direction:column; gap:6px;`;
        this.layerListEl.addEventListener('dragover', (e) => e.preventDefault());
        wrap.appendChild(this.layerListEl);
        this.refreshLayerPanel();
        return wrap;
    }

    private layerIconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.textContent = text;
        button.title = title;
        button.style.cssText = `
            width:26px; height:24px; padding:0; border-radius:4px;
            background:#3a3a3a; border:1px solid #555; color:#e0e0e0;
            font-size:15px; line-height:1; cursor:pointer;
        `;
        button.addEventListener('click', onClick);
        return button;
    }

    private addLayer(): void {
        if (!this.canvasStack) return;
        const selectedLayerIdBefore = this.canvasStack.selectedLayer()?.id;
        const selectedIndex = this.canvasStack.selectedCanvasIndex();
        const layer = this.canvasStack.createLayer(undefined, selectedIndex + 1);
        this.selectLayer(layer.id);
        this.pushLayerAddDeleteHistory({
            kind: 'layer-add',
            layer,
            index: selectedIndex + 1,
            selectedLayerIdBefore,
            selectedLayerIdAfter: layer.id
        });
        this.queueLayerThumbnailRefresh(layer.id);
    }

    private duplicateSelectedLayer(): void {
        if (!this.canvasStack) return;
        const selectedLayer = this.canvasStack.selectedLayer();
        if (!selectedLayer) return;

        const selectedLayerIdBefore = selectedLayer.id;
        const selectedIndex = this.canvasStack.selectedCanvasIndex();
        const layer = this.canvasStack.duplicateLayer(selectedLayer.id, selectedIndex + 1);
        if (!layer) return;

        this.selectLayer(layer.id);
        this.pushLayerAddDeleteHistory({
            kind: 'layer-add',
            layer,
            index: selectedIndex + 1,
            selectedLayerIdBefore,
            selectedLayerIdAfter: layer.id
        });
        this.queueLayerThumbnailRefresh(layer.id);
    }

    private async mergeSelectedLayerDown(): Promise<void> {
        if (!this.canvasStack) return;
        const selectedLayer = this.canvasStack.selectedLayer();
        const selectedIndex = this.canvasStack.selectedCanvasIndex();
        if (!selectedLayer || selectedIndex <= 0) return;

        const targetLayer = this.canvasStack.layerArray[selectedIndex - 1];
        if (!targetLayer || selectedLayer.locked || targetLayer.locked) return;

        const selectedLayerIdBefore = selectedLayer.id;
        const targetFixerGroup = new FixerGroup();
        targetFixerGroup.undoFixer = (await targetLayer.canvas.fixer()) || undefined;

        const result = this.canvasStack.mergeLayerDown(selectedLayer.id);
        if (!result) return;

        const targetAfter = this.canvasStack.layerForId(result.targetLayerId);
        targetFixerGroup.redoFixer = (await targetAfter?.canvas.fixer()) || undefined;

        this.selectLayer(result.targetLayerId);
        this.pushLayerMergeDownHistory({
            kind: 'layer-merge-down',
            sourceLayer: result.sourceLayer,
            sourceIndex: result.sourceIndex,
            targetLayerId: result.targetLayerId,
            targetFixerGroup,
            selectedLayerIdBefore,
            selectedLayerIdAfter: result.targetLayerId
        });
    }

    private async flattenVisibleLayers(): Promise<void> {
        if (!this.canvasStack) return;
        const layers = this.canvasStack.layerArray;
        const visibleLayers = layers.filter((layer) => layer.visible && layer.opacity > 0);
        if (visibleLayers.length <= 1 || visibleLayers.some((layer) => layer.locked)) return;

        const targetLayer = visibleLayers[0];
        const selectedLayerIdBefore = this.canvasStack.selectedLayer()?.id;
        const targetNameBefore = targetLayer.name;
        const targetFixerGroup = new FixerGroup();
        targetFixerGroup.undoFixer = (await targetLayer.canvas.fixer()) || undefined;

        const result = this.canvasStack.flattenVisible();
        if (!result) return;

        const targetAfter = this.canvasStack.layerForId(result.targetLayerId);
        targetFixerGroup.redoFixer = (await targetAfter?.canvas.fixer()) || undefined;

        this.selectLayer(result.targetLayerId);
        this.pushLayerFlattenVisibleHistory({
            kind: 'layer-flatten-visible',
            targetLayerId: result.targetLayerId,
            targetNameBefore,
            targetNameAfter: targetAfter?.name ?? targetNameBefore,
            removedLayers: result.removedLayers,
            targetFixerGroup,
            selectedLayerIdBefore,
            selectedLayerIdAfter: result.targetLayerId
        });
    }

    private deleteSelectedLayer(): void {
        const layer = this.canvasStack?.selectedLayer();
        if (!layer) return;
        const selectedLayerIdBefore = layer.id;
        const removed = this.canvasStack?.detachLayer(layer.id);
        if (!removed) return;
        const selectedLayerIdAfter = this.canvasStack?.selectedLayer()?.id;
        this.canvas = this.canvasStack?.selectedCanvas;
        this.refreshLayerPanel();
        this.pushLayerAddDeleteHistory({
            kind: 'layer-delete',
            layer: removed.layer,
            index: removed.index,
            selectedLayerIdBefore,
            selectedLayerIdAfter
        });
    }

    private selectedLayerIsLocked(): boolean {
        return !!this.canvasStack?.selectedLayer()?.locked;
    }

    private moveLayer(layerId: string, direction: -1 | 1): void {
        const before = this.layerOrderIds();
        this.canvasStack?.moveLayer(layerId, direction);
        this.pushLayerOrderHistory(before, this.layerOrderIds());
        this.refreshLayerPanel();
    }

    private moveLayerToPanelIndex(layerId: string, panelIndex: number): void {
        if (!this.canvasStack) return;
        const before = this.layerOrderIds();
        const panelIds = this.canvasStack.layerArray.map((layer) => layer.id).reverse();
        const fromPanelIndex = panelIds.indexOf(layerId);
        if (fromPanelIndex < 0) return;
        panelIds.splice(fromPanelIndex, 1);
        let targetPanelIndex = Math.max(0, Math.min(panelIndex, panelIds.length));
        if (fromPanelIndex < panelIndex) targetPanelIndex = Math.max(0, targetPanelIndex - 1);
        panelIds.splice(targetPanelIndex, 0, layerId);
        this.canvasStack.setLayerOrder(panelIds.reverse());
        this.pushLayerOrderHistory(before, this.layerOrderIds());
        this.refreshLayerPanel();
    }

    private renameLayer(layerId: string, name: string): void {
        const before = this.canvasStack?.layerForId(layerId)?.name;
        this.canvasStack?.renameLayer(layerId, name);
        const after = this.canvasStack?.layerForId(layerId)?.name;
        if (before !== undefined && after !== undefined) {
            this.pushLayerPropertyHistory(layerId, 'name', before, after);
        }
        this.refreshLayerPanel();
    }

    private toggleLayerVisible(layerId: string): void {
        const layer = this.canvasStack?.layerForId(layerId);
        if (!layer) return;
        const before = layer.visible;
        this.canvasStack?.setLayerVisible(layerId, !before);
        this.pushLayerPropertyHistory(layerId, 'visible', before, !before);
        this.refreshLayerPanel();
    }

    private toggleLayerLock(layerId: string): void {
        const layer = this.canvasStack?.layerForId(layerId);
        if (!layer) return;
        const before = layer.locked;
        this.canvasStack?.setLayerLocked(layerId, !before);
        this.pushLayerPropertyHistory(layerId, 'locked', before, !before);
        this.refreshLayerPanel();
    }

    private toggleLayerAlphaLock(layerId: string): void {
        const layer = this.canvasStack?.layerForId(layerId);
        if (!layer) return;
        const before = layer.alphaLock;
        this.canvasStack?.setLayerAlphaLock(layerId, !before);
        this.pushLayerPropertyHistory(layerId, 'alphaLock', before, !before);
        this.refreshLayerPanel();
    }

    private setLayerBlendModeWithHistory(layerId: string, blendMode: LayerBlendMode): void {
        const layer = this.canvasStack?.layerForId(layerId);
        if (!layer) return;
        const before = layer.blendMode;
        this.canvasStack?.setLayerBlendMode(layerId, blendMode);
        this.pushLayerPropertyHistory(layerId, 'blendMode', before, blendMode);
        this.refreshLayerPanel();
    }

    private beginLayerOpacityHistory(layerId: string): void {
        const layer = this.canvasStack?.layerForId(layerId);
        if (!layer || this.layerOpacityHistoryStart.has(layerId)) return;
        this.layerOpacityHistoryStart.set(layerId, layer.opacity);
    }

    private setLayerOpacityForPreview(layerId: string, opacity: number, valueEl: HTMLElement): void {
        this.canvasStack?.setLayerOpacity(layerId, opacity, false);
        valueEl.textContent = `${Math.round(opacity * 100)}%`;
    }

    private commitLayerOpacityHistory(layerId: string): void {
        const before = this.layerOpacityHistoryStart.get(layerId);
        this.layerOpacityHistoryStart.delete(layerId);
        const after = this.canvasStack?.layerForId(layerId)?.opacity;
        if (before === undefined || after === undefined) return;
        this.pushLayerPropertyHistory(layerId, 'opacity', before, after);
        this.refreshLayerPanel();
    }

    private layerOrderIds(): string[] {
        return this.canvasStack?.layerArray.map((layer) => layer.id) ?? [];
    }

    private selectLayer(layerId: string): void {
        if (!this.canvasStack) return;
        this.canvasStack.selectLayer(layerId);
        this.canvas = this.canvasStack.selectedCanvas;
        this.canvasStack.setBrush(this.currentBrushClone());
        this.canvasStack.color = this.currentColor.clone();
        this.canvasStack.brushSize = this.currentSize;
        this.canvasStack.brushOpacity = this.currentOpacity;
        this.refreshLayerPanel();
    }

    private refreshLayerPanel(): void {
        if (!this.layerListEl) return;
        this.layerListEl.replaceChildren();

        const layers = this.canvasStack?.layerArray ?? [];
        const selectedId = this.canvasStack?.selectedLayer()?.id;
        const layerIds = new Set(layers.map((layer) => layer.id));
        for (const id of Array.from(this.layerThumbnailCache.keys())) {
            if (!layerIds.has(id)) this.layerThumbnailCache.delete(id);
        }
        for (const id of Array.from(this.layerThumbnailPendingAges.keys())) {
            if (!layerIds.has(id)) this.layerThumbnailPendingAges.delete(id);
        }
        for (const [id, timer] of Array.from(this.layerThumbnailRefreshTimers.entries())) {
            if (layerIds.has(id)) continue;
            window.clearTimeout(timer);
            this.layerThumbnailRefreshTimers.delete(id);
        }

        for (let i = layers.length - 1; i >= 0; i--) {
            this.layerListEl.appendChild(this.buildLayerRow(layers[i], layers[i].id === selectedId));
        }

        if (this.deleteLayerBtnEl) this.deleteLayerBtnEl.disabled = layers.length <= 1;
        if (this.duplicateLayerBtnEl) this.duplicateLayerBtnEl.disabled = layers.length === 0;
        if (this.mergeDownLayerBtnEl) {
            const selectedIndex = layers.findIndex((layer) => layer.id === selectedId);
            const selectedLayer = selectedIndex >= 0 ? layers[selectedIndex] : undefined;
            const targetLayer = selectedIndex > 0 ? layers[selectedIndex - 1] : undefined;
            this.mergeDownLayerBtnEl.disabled = selectedIndex <= 0 || !!selectedLayer?.locked || !!targetLayer?.locked;
        }
        if (this.flattenVisibleLayerBtnEl) {
            const visibleLayers = layers.filter((layer) => layer.visible && layer.opacity > 0);
            this.flattenVisibleLayerBtnEl.disabled = visibleLayers.length <= 1 || visibleLayers.some((layer) => layer.locked);
        }
    }

    private queueLayerThumbnailRefresh(layerId: string): void {
        const previous = this.layerThumbnailRefreshTimers.get(layerId);
        if (previous !== undefined) window.clearTimeout(previous);

        const timer = window.setTimeout(() => {
            this.layerThumbnailRefreshTimers.delete(layerId);
            this.layerThumbnailCache.delete(layerId);
            this.layerThumbnailPendingAges.delete(layerId);
            this.refreshLayerPanel();
        }, 0);
        this.layerThumbnailRefreshTimers.set(layerId, timer);
    }

    private buildLayerRow(layer: CanvasLayer, selected: boolean): HTMLElement {
        const layers = this.canvasStack?.layerArray ?? [];
        const layerIndex = layers.findIndex((candidate) => candidate.id === layer.id);
        const row = document.createElement('div');
        row.style.cssText = `
            display:grid; grid-template-columns:26px ${LAYER_THUMB_W}px 1fr; gap:6px; align-items:center;
            padding:7px; border-radius:6px; border:1px solid ${selected ? '#75b7f1' : '#444'};
            background:${selected ? '#26384a' : '#333'}; cursor:pointer;
        `;
        row.draggable = true;
        row.dataset.layerId = layer.id;
        row.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/plain', layer.id);
            e.dataTransfer?.setDragImage(row, 12, 12);
            row.style.opacity = '.55';
        });
        row.addEventListener('dragend', () => {
            row.style.opacity = '1';
            this.clearLayerDropIndicators();
        });
        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.showLayerDropIndicator(row, e.offsetY > row.clientHeight * 0.5);
        });
        row.addEventListener('dragleave', () => {
            row.style.borderTopColor = selected ? '#75b7f1' : '#444';
            row.style.borderBottomColor = selected ? '#75b7f1' : '#444';
        });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const sourceLayerId = e.dataTransfer?.getData('text/plain');
            if (!sourceLayerId || sourceLayerId === layer.id) return;
            const panelRows = Array.from(this.layerListEl.querySelectorAll<HTMLElement>('[data-layer-id]'));
            const targetPanelIndex = panelRows.indexOf(row);
            const dropAfter = e.offsetY > row.clientHeight * 0.5;
            this.moveLayerToPanelIndex(sourceLayerId, targetPanelIndex + (dropAfter ? 1 : 0));
        });
        row.addEventListener('click', () => this.selectLayer(layer.id));

        const layerButtons = document.createElement('div');
        layerButtons.style.cssText = `display:flex; flex-direction:column; gap:4px;`;

        const visible = document.createElement('button');
        visible.textContent = layer.visible ? 'V' : '-';
        visible.title = layer.visible ? 'Hide layer' : 'Show layer';
        visible.style.cssText = `
            width:24px; height:24px; border-radius:4px; border:1px solid #555;
            background:${layer.visible ? '#4a4a4a' : '#2a2a2a'}; color:#e0e0e0; cursor:pointer;
        `;
        visible.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleLayerVisible(layer.id);
        });
        layerButtons.appendChild(visible);

        const lock = document.createElement('button');
        lock.textContent = layer.locked ? 'L' : '-';
        lock.title = layer.locked ? 'Unlock layer' : 'Lock layer';
        lock.style.cssText = `
            width:24px; height:24px; border-radius:4px; border:1px solid #555;
            background:${layer.locked ? '#5a4630' : '#2a2a2a'}; color:#e0e0e0; cursor:pointer;
        `;
        lock.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleLayerLock(layer.id);
        });
        layerButtons.appendChild(lock);

        const alphaLock = document.createElement('button');
        alphaLock.textContent = layer.alphaLock ? 'A' : '-';
        alphaLock.title = layer.alphaLock ? 'Disable alpha lock' : 'Enable alpha lock';
        alphaLock.style.cssText = `
            width:24px; height:24px; border-radius:4px; border:1px solid #555;
            background:${layer.alphaLock ? '#305242' : '#2a2a2a'}; color:#e0e0e0; cursor:pointer;
        `;
        alphaLock.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleLayerAlphaLock(layer.id);
        });
        layerButtons.appendChild(alphaLock);
        row.appendChild(layerButtons);

        const thumbnail = this.buildLayerThumbnail(layer);
        row.appendChild(thumbnail);

        const body = document.createElement('div');
        body.style.cssText = `min-width:0; display:flex; flex-direction:column; gap:5px;`;

        const top = document.createElement('div');
        top.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:6px;`;

        const name = document.createElement('input');
        name.value = layer.name;
        name.title = 'Layer name';
        name.style.cssText = `
            min-width:0; flex:1; background:transparent; border:1px solid transparent;
            border-radius:4px; color:#e8e8e8; font-size:12px; padding:2px 3px; outline:none;
        `;
        name.addEventListener('click', (e) => e.stopPropagation());
        name.addEventListener('focus', () => {
            name.style.background = '#252525';
            name.style.borderColor = '#555';
            name.select();
        });
        name.addEventListener('blur', () => {
            name.style.background = 'transparent';
            name.style.borderColor = 'transparent';
            this.renameLayer(layer.id, name.value);
        });
        name.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') name.blur();
            if (e.key === 'Escape') {
                name.value = layer.name;
                name.blur();
            }
        });
        top.appendChild(name);

        const opacityText = document.createElement('span');
        opacityText.textContent = `${Math.round(layer.opacity * 100)}%`;
        opacityText.style.cssText = `font-size:11px; color:#93bce4; flex-shrink:0;`;
        top.appendChild(opacityText);
        body.appendChild(top);

        const controls = document.createElement('div');
        controls.style.cssText = `display:grid; grid-template-columns:1fr 72px; gap:6px; align-items:center;`;

        const opacity = document.createElement('input');
        opacity.type = 'range';
        opacity.min = '0';
        opacity.max = '1';
        opacity.step = '0.01';
        opacity.value = String(layer.opacity);
        opacity.style.cssText = `width:100%; accent-color:#4a90d9;`;
        opacity.addEventListener('click', (e) => e.stopPropagation());
        opacity.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            this.beginLayerOpacityHistory(layer.id);
        });
        opacity.addEventListener('focus', () => this.beginLayerOpacityHistory(layer.id));
        opacity.addEventListener('input', (e) => {
            e.stopPropagation();
            this.setLayerOpacityForPreview(layer.id, Number(opacity.value), opacityText);
        });
        opacity.addEventListener('change', (e) => {
            e.stopPropagation();
            this.commitLayerOpacityHistory(layer.id);
        });
        controls.appendChild(opacity);

        const blend = document.createElement('select');
        blend.style.cssText = `min-width:0; background:#2a2a2a; border:1px solid #555; color:#e0e0e0; border-radius:4px; font-size:11px; padding:3px;`;
        for (const mode of ['normal', 'multiply', 'add', 'screen', 'max'] as LayerBlendMode[]) {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode;
            blend.appendChild(option);
        }
        blend.value = layer.blendMode;
        blend.addEventListener('click', (e) => e.stopPropagation());
        blend.addEventListener('change', (e) => {
            e.stopPropagation();
            this.setLayerBlendModeWithHistory(layer.id, blend.value as LayerBlendMode);
        });
        controls.appendChild(blend);

        body.appendChild(controls);

        const orderControls = document.createElement('div');
        orderControls.style.cssText = `display:grid; grid-template-columns:1fr 1fr; gap:5px;`;
        const moveUp = this.layerMiniButton('Up', 'Move layer up', () => this.moveLayer(layer.id, 1));
        const moveDown = this.layerMiniButton('Down', 'Move layer down', () => this.moveLayer(layer.id, -1));
        moveUp.disabled = layerIndex === layers.length - 1;
        moveDown.disabled = layerIndex <= 0;
        orderControls.appendChild(moveUp);
        orderControls.appendChild(moveDown);
        body.appendChild(orderControls);

        row.appendChild(body);
        return row;
    }

    private buildLayerThumbnail(layer: CanvasLayer): HTMLCanvasElement {
        const thumbnail = document.createElement('canvas');
        thumbnail.width = LAYER_THUMB_W;
        thumbnail.height = LAYER_THUMB_H;
        thumbnail.title = 'Layer thumbnail';
        thumbnail.style.cssText = `
            width:${LAYER_THUMB_W}px; height:${LAYER_THUMB_H}px; border-radius:4px;
            border:1px solid #555; background:
                linear-gradient(45deg, #555 25%, transparent 25%),
                linear-gradient(-45deg, #555 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #555 75%),
                linear-gradient(-45deg, transparent 75%, #555 75%);
            background-color:#3c3c3c; background-size:10px 10px; background-position:0 0,0 5px,5px -5px,-5px 0;
            image-rendering:auto; object-fit:contain;
        `;
        thumbnail.addEventListener('click', (e) => e.stopPropagation());

        const cached = this.layerThumbnailCache.get(layer.id);
        if (cached && cached.age === layer.canvas.age) {
            this.drawLayerThumbnailDataUrl(thumbnail, cached.dataUrl);
        } else {
            this.drawEmptyLayerThumbnail(thumbnail);
            void this.refreshLayerThumbnail(layer, thumbnail);
        }
        return thumbnail;
    }

    private drawEmptyLayerThumbnail(thumbnail: HTMLCanvasElement): void {
        const ctx = thumbnail.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, thumbnail.width, thumbnail.height);
    }

    private drawLayerThumbnailDataUrl(thumbnail: HTMLCanvasElement, dataUrl: string): void {
        const image = new Image();
        image.onload = () => {
            const ctx = thumbnail.getContext('2d');
            if (!ctx) return;
            ctx.clearRect(0, 0, thumbnail.width, thumbnail.height);
            ctx.drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
        };
        image.src = dataUrl;
    }

    private async refreshLayerThumbnail(layer: CanvasLayer, thumbnail: HTMLCanvasElement): Promise<void> {
        const pendingAge = this.layerThumbnailPendingAges.get(layer.id);
        if (pendingAge === layer.canvas.age) return;
        this.layerThumbnailPendingAges.set(layer.id, layer.canvas.age);

        const age = layer.canvas.age;
        const renderTarget = layer.canvas.outputRenderTarget;
        const sourceWidth = renderTarget.size.width;
        const sourceHeight = renderTarget.size.height;
        const pixels = await this.glContext?.readPixels(renderTarget, new Rect(0, 0, sourceWidth, sourceHeight));
        this.layerThumbnailPendingAges.delete(layer.id);
        if (!pixels || !this.canvasStack?.layerForId(layer.id) || layer.canvas.age !== age) return;

        const source = document.createElement('canvas');
        source.width = sourceWidth;
        source.height = sourceHeight;
        const sourceCtx = source.getContext('2d');
        if (!sourceCtx) return;
        sourceCtx.putImageData(new ImageData(new Uint8ClampedArray(pixels), sourceWidth, sourceHeight), 0, 0);

        const preview = document.createElement('canvas');
        preview.width = LAYER_THUMB_W;
        preview.height = LAYER_THUMB_H;
        const previewCtx = preview.getContext('2d');
        if (!previewCtx) return;
        previewCtx.clearRect(0, 0, preview.width, preview.height);

        const scale = Math.min(preview.width / sourceWidth, preview.height / sourceHeight);
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const x = Math.round((preview.width - width) * 0.5);
        const y = Math.round((preview.height - height) * 0.5);
        previewCtx.drawImage(source, x, y, width, height);

        const dataUrl = preview.toDataURL('image/png');
        this.layerThumbnailCache.set(layer.id, { age, dataUrl });
        if (thumbnail.isConnected) this.drawLayerThumbnailDataUrl(thumbnail, dataUrl);
    }

    private layerMiniButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.textContent = text;
        button.title = title;
        button.style.cssText = `
            height:22px; min-width:0; border-radius:4px; border:1px solid #555;
            background:#2a2a2a; color:#d8d8d8; font-size:11px; cursor:pointer;
        `;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return button;
    }

    private showLayerDropIndicator(row: HTMLElement, after: boolean): void {
        this.clearLayerDropIndicators();
        if (after) {
            row.style.borderBottomColor = '#f1b84a';
        } else {
            row.style.borderTopColor = '#f1b84a';
        }
    }

    private clearLayerDropIndicators(): void {
        if (!this.layerListEl) return;
        for (const row of Array.from(this.layerListEl.querySelectorAll<HTMLElement>('[data-layer-id]'))) {
            const selected = row.dataset.layerId === this.canvasStack?.selectedLayer()?.id;
            row.style.borderTopColor = selected ? '#75b7f1' : '#444';
            row.style.borderBottomColor = selected ? '#75b7f1' : '#444';
        }
    }

    private currentBrushClone(): IBrush | undefined {
        const brush = this.getCurrentBrush() ?? this.savedBrush ?? undefined;
        return brush ? JSON.parse(JSON.stringify(brush)) : undefined;
    }

    private ensureSelectedCanvasBrush(): void {
        const brush = this.currentBrushClone();
        if (!brush) return;
        this.savedBrush = JSON.parse(JSON.stringify(brush));
        this.canvasStack?.setBrush(brush);
    }

    private toolButton(text: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.textContent = text;
        button.style.cssText = `
            height:30px; background:#3a3a3a; color:#e0e0e0;
            border:1px solid #555; border-radius:5px;
            font-size:12px; cursor:pointer;
        `;
        button.addEventListener('click', onClick);
        return button;
    }

    private setTool(tool: 'brush' | 'fill'): void {
        this.currentTool = tool;
        this.updateToolButtons();
    }

    private updateToolButtons(): void {
        if (!this.brushToolBtn || !this.fillToolBtn) return;
        const base = `
            height:30px; border-radius:5px;
            font-size:12px; cursor:pointer;
        `;
        const active = `${base} background:#4a90d9; border:1px solid #6db2f0; color:#fff;`;
        const inactive = `${base} background:#3a3a3a; border:1px solid #555; color:#e0e0e0;`;
        this.brushToolBtn.style.cssText = this.currentTool === 'brush' ? active : inactive;
        this.fillToolBtn.style.cssText = this.currentTool === 'fill' ? active : inactive;
        if (this.glCanvas) this.glCanvas.style.cursor = this.currentTool === 'fill' ? 'cell' : 'crosshair';
    }

    private buildWebGPUStatsSection(): HTMLElement {
        const wrap = document.createElement('div');
        const lbl = document.createElement('label');
        lbl.textContent = 'WebGPU Stats';
        lbl.style.cssText = `display:block; font-size:11px; color:#9a9a9a; margin-bottom:5px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        wrap.appendChild(lbl);

        this.webGPUStatsEl = document.createElement('div');
        this.webGPUStatsEl.style.cssText = `
            min-height:86px; padding:8px;
            background:#202020; border:1px solid #3f3f3f; border-radius:5px;
            color:#8fa8bd; font-size:10px; line-height:1.45;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            white-space:pre-wrap; word-break:break-word;
        `;
        this.webGPUStatsEl.textContent = 'Waiting for init';
        wrap.appendChild(this.webGPUStatsEl);
        return wrap;
    }

    private updateWebGPUStats(info: {
        status: 'initializing' | 'ready' | 'failed';
        adapter?: GPUAdapter;
        device?: GPUDevice;
        format?: GPUTextureFormat;
        error?: string;
    }): void {
        if (!this.webGPUStatsEl) return;

        const adapterInfo = info.adapter ? (info.adapter as unknown as { info?: Record<string, unknown> }).info : undefined;
        const vendor = this.statValue(adapterInfo?.vendor);
        const architecture = this.statValue(adapterInfo?.architecture);
        const device = this.statValue(adapterInfo?.device);
        const description = this.statValue(adapterInfo?.description);
        const features = info.adapter ? Array.from(info.adapter.features).slice(0, 8).join(', ') || 'none' : '-';
        const maxTexture = info.device?.limits.maxTextureDimension2D ?? '-';
        const maxStorageBuffer = info.device?.limits.maxStorageBufferBindingSize ?? '-';
        const ua = navigator.userAgent.replace(/\s+/g, ' ');

        this.webGPUStatsEl.textContent =
            `status     ${info.status}\n` +
            `secure     ${window.isSecureContext ? 'yes' : 'no'}\n` +
            `navigator  ${navigator.gpu ? 'yes' : 'no'}\n` +
            `format     ${info.format ?? '-'}\n` +
            `vendor     ${vendor}\n` +
            `arch       ${architecture}\n` +
            `device     ${device}\n` +
            `desc       ${description}\n` +
            `maxTex2D   ${maxTexture}\n` +
            `maxStorage ${maxStorageBuffer}\n` +
            `features   ${features}\n` +
            `error      ${info.error ?? '-'}\n` +
            `ua         ${ua}`;
    }

    private statValue(value: unknown): string {
        if (value === undefined || value === null || value === '') return '-';
        return String(value);
    }

    private async applyFloodFill(seed: Point): Promise<void> {
        if (!this.canvas || this.fillInProgress) return;
        this.fillInProgress = true;
        try {
            const tolerance = this.fillToleranceToEngineValue(this.fillTolerance);
            const edgeThreshold = this.fillEdgeSensitivityToEngineValue(this.fillEdgeSensitivity);
            const result = await this.canvas.floodFill(seed, this.currentColor.clone(), tolerance, edgeThreshold, this.fillTuningMode);
            if (!result) return;
            console.debug(
                `[FloodFill] ${result.metrics.mode} tuning=${result.metrics.tuningMode} total=${result.metrics.totalMs.toFixed(1)}ms dry=${result.metrics.dryMs.toFixed(1)}ms source=${result.metrics.sourceCopyMs.toFixed(1)}ms gpu=${result.metrics.gpuMs.toFixed(1)}ms post=${result.metrics.postProcessMs.toFixed(1)}ms history=${result.metrics.historyMs.toFixed(1)}ms update=${result.metrics.updateMs.toFixed(1)}ms readback=${result.metrics.readbackMs.toFixed(1)}ms iterations=${result.metrics.iterations} dispatch=${result.metrics.dispatchIterations} substeps=${result.metrics.substeps} tile=${result.metrics.tileSize} batch=${result.metrics.batchSize} bounds=${result.metrics.bounds.toString()}`
            );
            this.updateFillStats(result.metrics);
            const fixerGroup = result.fixerGroup;
            const layerId = this.canvasStack?.selectedLayer()?.id;
            if (!layerId) return;
            if (fixerGroup) {
                this.pushHistory(layerId, fixerGroup);
            } else if (result.historyPromise) {
                const pendingGroup = new FixerGroup();
                const pendingEntry: DrawingHistoryEntry = { kind: 'drawing', layerId, fixerGroup: pendingGroup };
                this.undoStack.push(pendingEntry);
                this.redoStack = [];
                this.pendingFillHistoryCount++;
                this.queueLayerThumbnailRefresh(layerId);
                this.updateUndoRedoButtons();
                let historyReady = false;
                result.historyPromise
                    .then((history) => {
                        if (history.fixerGroup) {
                            pendingGroup.undoFixer = history.fixerGroup.undoFixer;
                            pendingGroup.redoFixer = history.fixerGroup.redoFixer;
                            historyReady = true;
                            console.debug(`[FloodFill] history ready history=${history.historyMs.toFixed(1)}ms readback=${history.readbackMs.toFixed(1)}ms`);
                        }
                    })
                    .then(
                        () => undefined,
                        (error) => console.error('Flood fill history failed', error)
                    )
                    .then(() => {
                        if (!historyReady) {
                            const idx = this.undoStack.indexOf(pendingEntry);
                            if (idx >= 0) this.undoStack.splice(idx, 1);
                        }
                        this.pendingFillHistoryCount = Math.max(0, this.pendingFillHistoryCount - 1);
                        this.updateUndoRedoButtons();
                    });
            }
        } catch (error) {
            console.error('Flood fill failed', error);
        } finally {
            this.fillInProgress = false;
        }
    }

    private async startFloodFillContext(seed: Point): Promise<void> {
        if (!this.canvas || this.fillInProgress) return;

        this.floodFillSeed = seed.clone();
        this.floodFillBaselineFixer = await this.canvas.fixer();
        if (!this.floodFillBaselineFixer) return;

        this.floodFillEditingContext = true;
        this.floodFillPreviewResult = null;
        this.floodFillPreviewQueued = false;
        this.floodFillPreviewToken++;
        this.showFloodFillUI();
        this.resetFloodFillEditHistory();
        await this.renderFloodFillPreview();
    }

    private async renderFloodFillPreview(): Promise<void> {
        if (!this.canvas || !this.floodFillEditingContext || !this.floodFillSeed || !this.floodFillBaselineFixer) return;
        if (this.fillInProgress) {
            this.floodFillPreviewQueued = true;
            return this.floodFillPreviewPromise ?? Promise.resolve();
        }

        const token = ++this.floodFillPreviewToken;
        this.fillInProgress = true;
        this.updateUndoRedoButtons();
        const run = (async () => {
            try {
                await this.canvas!.fix(this.floodFillBaselineFixer!, false, false);
                if (token !== this.floodFillPreviewToken || !this.floodFillEditingContext) return;

                const result = await this.canvas!.floodFill(
                    this.floodFillSeed!,
                    this.currentColor.clone(),
                    this.fillToleranceToEngineValue(this.fillTolerance),
                    this.fillEdgeSensitivityToEngineValue(this.fillEdgeSensitivity),
                    this.fillTuningMode
                );
                if (token !== this.floodFillPreviewToken || !this.floodFillEditingContext) return;
                if (!result) return;

                this.canvas!.updateCanvas();
                this.floodFillPreviewResult = result;
                this.updateFillStats(result.metrics);
            } catch (error) {
                console.error('Flood fill preview failed', error);
            } finally {
                if (token === this.floodFillPreviewToken) {
                    this.fillInProgress = false;
                    this.updateUndoRedoButtons();
                    if (this.floodFillPreviewQueued) {
                        this.floodFillPreviewQueued = false;
                        void this.renderFloodFillPreview();
                    }
                }
            }
        })();

        const previewPromise = run.then(
            () => {
                if (this.floodFillPreviewPromise === previewPromise) this.floodFillPreviewPromise = null;
            },
            (error) => {
                if (this.floodFillPreviewPromise === previewPromise) this.floodFillPreviewPromise = null;
                throw error;
            }
        );
        this.floodFillPreviewPromise = previewPromise;
        return this.floodFillPreviewPromise;
    }

    private async commitFloodFillContext(): Promise<void> {
        if (!this.floodFillEditingContext) return;

        while (this.floodFillPreviewPromise) {
            await this.floodFillPreviewPromise;
        }
        this.floodFillPreviewQueued = false;

        const result = this.floodFillPreviewResult;
        this.hideFloodFillUI();
        this.floodFillEditingContext = false;
        this.floodFillPreviewToken++;

        if (result) {
            this.pushFloodFillResultToHistory(result);
        }

        this.resetFloodFillState();
        this.updateUndoRedoButtons();
    }

    private pushFloodFillResultToHistory(result: CanvasFloodFillResult): void {
        const fixerGroup = result.fixerGroup;
        const layerId = this.canvasStack?.selectedLayer()?.id;
        if (!layerId) return;
        if (fixerGroup) {
            this.pushHistory(layerId, fixerGroup);
            return;
        }

        if (!result.historyPromise) return;

        const pendingGroup = new FixerGroup();
        const pendingEntry: DrawingHistoryEntry = { kind: 'drawing', layerId, fixerGroup: pendingGroup };
        this.undoStack.push(pendingEntry);
        this.redoStack = [];
        this.pendingFillHistoryCount++;
        this.queueLayerThumbnailRefresh(layerId);
        this.updateUndoRedoButtons();
        let historyReady = false;
        result.historyPromise
            .then((history) => {
                if (history.fixerGroup) {
                    pendingGroup.undoFixer = history.fixerGroup.undoFixer;
                    pendingGroup.redoFixer = history.fixerGroup.redoFixer;
                    historyReady = true;
                    console.debug(`[FloodFill] history ready history=${history.historyMs.toFixed(1)}ms readback=${history.readbackMs.toFixed(1)}ms`);
                }
            })
            .then(
                () => undefined,
                (error) => console.error('Flood fill history failed', error)
            )
            .then(() => {
                if (!historyReady) {
                    const idx = this.undoStack.indexOf(pendingEntry);
                    if (idx >= 0) this.undoStack.splice(idx, 1);
                }
                this.pendingFillHistoryCount = Math.max(0, this.pendingFillHistoryCount - 1);
                this.updateUndoRedoButtons();
            });
    }

    private fillToleranceToEngineValue(value: number): number {
        return (value / 255) * 2;
    }

    private fillEdgeSensitivityToEngineValue(value: number): number {
        return Math.max(0.02, ((value + 1) / 100) * 1.5);
    }

    private showFloodFillUI(): void {
        this.hideFloodFillUI();

        const ribbon = document.createElement('div');
        ribbon.style.cssText = `
            position:absolute; left:50%; top:14px; transform:translateX(-50%);
            display:flex; align-items:center; gap:10px; padding:7px 8px;
            background:rgba(32,34,38,.94); border:1px solid rgba(255,255,255,.16);
            border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.22); z-index:20;
            pointer-events:auto; color:#e9edf2; font-size:12px; font-weight:600;
        `;
        ribbon.addEventListener('mousedown', (e) => e.stopPropagation());

        this.floodFillToleranceInputEl = this.floodFillSlider('Tolerance', 0, 255, this.fillTolerance, (value) => {
            this.fillTolerance = value;
            void this.renderFloodFillPreview();
        }, () => this.pushFloodFillSnapshot());
        this.floodFillEdgeInputEl = this.floodFillSlider('Edge', 0, 100, this.fillEdgeSensitivity, (value) => {
            this.fillEdgeSensitivity = value;
            void this.renderFloodFillPreview();
        }, () => this.pushFloodFillSnapshot());
        const doneBtn = this.shapeAssistButton('Done', () => void this.commitFloodFillContext());
        doneBtn.style.marginLeft = '2px';

        ribbon.appendChild(this.floodFillToleranceInputEl.parentElement!);
        ribbon.appendChild(this.floodFillEdgeInputEl.parentElement!);
        ribbon.appendChild(doneBtn);
        this.canvasContainer.appendChild(ribbon);
        this.floodFillRibbonEl = ribbon;
        document.addEventListener('mousedown', this.onFloodFillDocumentMouseDown, true);
    }

    private floodFillSlider(label: string, min: number, max: number, value: number, onInput: (value: number) => void, onCommit: () => void): HTMLInputElement {
        const wrap = document.createElement('label');
        wrap.style.cssText = `display:flex; align-items:center; gap:6px; white-space:nowrap;`;
        const text = document.createElement('span');
        text.textContent = label;
        text.style.cssText = `color:#cfd6de;`;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
        input.value = String(value);
        input.style.cssText = `width:138px;`;
        input.addEventListener('input', () => onInput(Number(input.value)));
        input.addEventListener('change', onCommit);
        wrap.appendChild(text);
        wrap.appendChild(input);
        return input;
    }

    private hideFloodFillUI(): void {
        document.removeEventListener('mousedown', this.onFloodFillDocumentMouseDown, true);
        this.floodFillRibbonEl?.remove();
        this.floodFillRibbonEl = null;
        this.floodFillToleranceInputEl = null;
        this.floodFillEdgeInputEl = null;
    }

    private onFloodFillDocumentMouseDown = (e: MouseEvent): void => {
        if (!this.floodFillEditingContext) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (this.floodFillRibbonEl?.contains(target)) return;
        if (this.undoBtnEl?.contains(target) || this.redoBtnEl?.contains(target)) return;
        if (target === this.glCanvas) return;
        void this.commitFloodFillContext();
    };

    private resetFloodFillEditHistory(): void {
        this.floodFillUndoStack = [];
        this.floodFillRedoStack = [];
        this.pushFloodFillSnapshot();
        this.updateUndoRedoButtons();
    }

    private pushFloodFillSnapshot(snapshot: FloodFillSnapshot = this.currentFloodFillSnapshot()): void {
        const current = this.floodFillUndoStack[this.floodFillUndoStack.length - 1];
        if (current && this.floodFillSnapshotsEqual(current, snapshot)) return;
        this.floodFillUndoStack.push({ ...snapshot });
        this.floodFillRedoStack = [];
        this.updateUndoRedoButtons();
    }

    private async undoFloodFillEdit(): Promise<void> {
        if (this.fillInProgress) return;
        if (this.floodFillUndoStack.length <= 1) {
            await this.cancelFloodFillContext();
            return;
        }
        const current = this.floodFillUndoStack.pop()!;
        this.floodFillRedoStack.push(current);
        await this.applyFloodFillSnapshot(this.floodFillUndoStack[this.floodFillUndoStack.length - 1]);
        this.updateUndoRedoButtons();
    }

    private async redoFloodFillEdit(): Promise<void> {
        if (this.fillInProgress) return;
        const next = this.floodFillRedoStack.pop();
        if (!next) return;
        this.floodFillUndoStack.push(next);
        await this.applyFloodFillSnapshot(next);
        this.updateUndoRedoButtons();
    }

    private currentFloodFillSnapshot(): FloodFillSnapshot {
        return {
            tolerance: this.fillTolerance,
            edgeSensitivity: this.fillEdgeSensitivity
        };
    }

    private async applyFloodFillSnapshot(snapshot: FloodFillSnapshot): Promise<void> {
        this.fillTolerance = snapshot.tolerance;
        this.fillEdgeSensitivity = snapshot.edgeSensitivity;
        if (this.floodFillToleranceInputEl) this.floodFillToleranceInputEl.value = String(snapshot.tolerance);
        if (this.floodFillEdgeInputEl) this.floodFillEdgeInputEl.value = String(snapshot.edgeSensitivity);
        await this.renderFloodFillPreview();
    }

    private floodFillSnapshotsEqual(a: FloodFillSnapshot, b: FloodFillSnapshot): boolean {
        return a.tolerance === b.tolerance && a.edgeSensitivity === b.edgeSensitivity;
    }

    private async cancelFloodFillContext(): Promise<void> {
        if (!this.floodFillEditingContext) return;

        while (this.floodFillPreviewPromise) {
            await this.floodFillPreviewPromise;
        }

        this.floodFillPreviewQueued = false;
        this.floodFillPreviewToken++;
        if (this.canvas && this.floodFillBaselineFixer) {
            await this.canvas.fix(this.floodFillBaselineFixer, false);
        }
        this.resetFloodFillState();
        this.updateUndoRedoButtons();
    }

    private resetFloodFillState(): void {
        this.hideFloodFillUI();
        this.floodFillEditingContext = false;
        this.floodFillSeed = null;
        this.floodFillBaselineFixer = null;
        this.floodFillPreviewResult = null;
        this.floodFillPreviewQueued = false;
        this.floodFillPreviewPromise = null;
        this.floodFillUndoStack = [];
        this.floodFillRedoStack = [];
    }

    private updateFillStats(metrics: {
        mode: 'fast-empty' | 'flood';
        iterations: number;
        dispatchIterations: number;
        substeps: number;
        tileSize: number;
        batchSize: number;
        tuningMode: FloodFillTuningMode;
        gpuMs: number;
        sourceCopyMs: number;
        postProcessMs: number;
        historyMs: number;
        readbackMs: number;
        dryMs: number;
        updateMs: number;
        totalMs: number;
        bounds: Rect;
    }): void {
        const bounds = `${metrics.bounds.size.width}x${metrics.bounds.size.height}`;
        console.debug(
            `[FloodFill] ${metrics.mode} tuning=${metrics.tuningMode} total=${metrics.totalMs.toFixed(1)}ms dry=${metrics.dryMs.toFixed(1)}ms source=${metrics.sourceCopyMs.toFixed(1)}ms gpu=${metrics.gpuMs.toFixed(1)}ms post=${metrics.postProcessMs.toFixed(1)}ms history=${metrics.historyMs.toFixed(1)}ms update=${metrics.updateMs.toFixed(1)}ms readback=${metrics.readbackMs.toFixed(1)}ms iterations=${metrics.iterations} dispatch=${metrics.dispatchIterations} substeps=${metrics.substeps} tile=${metrics.tileSize} batch=${metrics.batchSize} bounds=${bounds}`
        );
    }

    private buildColorSection(): HTMLElement {
        const PALETTE = [
            '#FFC312', '#F79F1F', '#EE5A24', '#EA2027',
            '#C4E538', '#A3CB38', '#009432', '#006266',
            '#12CBC4', '#1289A7', '#0652DD', '#1B1464',
            '#FDA7DF', '#D980FA', '#9980FA', '#5758BB',
            '#ED4C67', '#B53471', '#833471', '#6F1E51',
        ];

        const wrap = document.createElement('div');

        const lbl = document.createElement('label');
        lbl.textContent = 'Color';
        lbl.style.cssText = `display:block; font-size:11px; color:#9a9a9a; margin-bottom:6px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        wrap.appendChild(lbl);

        // Palette grid — 4 colours per row, grouped by colour family
        const grid = document.createElement('div');
        grid.style.cssText = `display:grid; grid-template-columns:repeat(4, 1fr); gap:4px; margin-bottom:6px;`;

        PALETTE.forEach(hex => {
            const swatch = document.createElement('button');
            swatch.title = hex;
            swatch.style.cssText = `
                aspect-ratio:1; width:100%; border-radius:5px; padding:0;
                background:${hex}; border:2px solid transparent;
                cursor:pointer; transition:border-color .12s, box-shadow .12s, transform .12s;
            `;
            swatch.addEventListener('click', () => {
                this.applyHexColor(hex);
                this.colorInputEl.value = hex;
                this.selectPaletteSwatch(swatch);
            });
            swatch.addEventListener('mouseenter', () => {
                if (swatch !== this.selectedSwatch) swatch.style.transform = 'scale(1.1)';
            });
            swatch.addEventListener('mouseleave', () => {
                if (swatch !== this.selectedSwatch) swatch.style.transform = '';
            });
            grid.appendChild(swatch);
        });
        wrap.appendChild(grid);

        // Native colour picker — syncs with palette selection
        this.colorInputEl = document.createElement('input');
        this.colorInputEl.type = 'color';
        this.colorInputEl.value = '#000000';
        this.colorInputEl.style.cssText = `width:100%; height:28px; border:none; border-radius:4px; cursor:pointer; background:none;`;
        this.colorInputEl.addEventListener('input', () => {
            this.applyHexColor(this.colorInputEl.value);
            this.clearPaletteSelection();
        });
        wrap.appendChild(this.colorInputEl);

        return wrap;
    }

    // ---- Favorites ----

    private toggleFavorite(): void {
        const cat = this.categories[this.currentCategoryIndex];
        if (!cat || cat.key === '__favorites__') return;
        const brush = cat.brushes?.[this.currentBrushIndex];
        if (!brush) return;
        const nowFav = isFavorite(brush.name, cat.file);
        setFavorite(brush.name, cat.file, !nowFav).catch(console.error);
        this.refreshFavoritesCategory();
    }

    private updateFavoriteStar(): void {
        if (!this.favStarBtn) return;
        const cat = this.categories[this.currentCategoryIndex];
        if (cat?.key === '__favorites__') {
            this.favStarBtn.textContent = '—';
            this.favStarBtn.style.color = '#555';
            this.favStarBtn.disabled = true;
            return;
        }
        this.favStarBtn.disabled = false;
        const brush = cat?.brushes?.[this.currentBrushIndex];
        const fav = brush ? isFavorite(brush.name, cat!.file) : false;
        this.favStarBtn.textContent = fav ? '★' : '☆';
        this.favStarBtn.style.color = fav ? '#f0a030' : '#888';
    }
}

// ---- UI helpers ----

const inputCSS = `
    width:100%; background:#3a3a3a; border:1px solid #555; border-radius:4px;
    color:#e0e0e0; padding:5px 8px; font-size:13px; outline:none;
`;

function row(labelText: string, buildControl: () => HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.textContent = labelText;
    lbl.style.cssText = `display:block; font-size:11px; color:#9a9a9a; margin-bottom:4px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
    wrap.appendChild(lbl);
    wrap.appendChild(buildControl());
    return wrap;
}

function sliderRow(
    labelText: string, min: number, max: number, step: number,
    initial: number, onChange: (v: number) => void, decimals: number = 2
): HTMLElement {
    const wrap = document.createElement('div');

    const header = document.createElement('div');
    header.style.cssText = `display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;`;
    const lbl = document.createElement('span');
    lbl.textContent = labelText;
    lbl.style.cssText = `font-size:11px; color:#9a9a9a; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
    const valSpan = document.createElement('span');
    valSpan.style.cssText = `font-size:11px; color:#7a9fc0;`;
    valSpan.textContent = initial.toFixed(decimals);
    header.appendChild(lbl);
    header.appendChild(valSpan);
    wrap.appendChild(header);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(initial);
    range.style.cssText = `width:100%; accent-color:#4a90d9; cursor:pointer;`;
    range.addEventListener('input', () => {
        const v = parseFloat(range.value);
        valSpan.textContent = v.toFixed(decimals);
        onChange(v);
    });
    wrap.appendChild(range);
    return wrap;
}

function actionBtn(text: string, bg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = `
        width:100%; padding:9px; background:${bg}; color:#e0e0e0;
        border:1px solid ${bg === '#4a4a4a' ? '#666' : bg};
        border-radius:5px; font-size:13px; cursor:pointer;
        transition: opacity .15s;
    `;
    b.addEventListener('click', onClick);
    b.addEventListener('mouseenter', () => { b.style.opacity = '.8'; });
    b.addEventListener('mouseleave', () => { b.style.opacity = '1'; });
    return b;
}

function divider(): HTMLElement {
    const d = document.createElement('div');
    d.style.cssText = `height:1px; background:#3a3a3a; margin:2px 0;`;
    return d;
}

function showPWAGuideModal(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,.65);
        display: flex; align-items: center; justify-content: center;
        font-family: sans-serif;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background: #252525; border: 1px solid #3a3a3a; border-radius: 12px;
        padding: 24px 28px; max-width: 360px; width: 90%;
        color: #e0e0e0;
    `;

    const title = document.createElement('div');
    title.textContent = '홈 화면에 추가하는 방법';
    title.style.cssText = `font-size:16px; font-weight:700; color:#4a90d9; margin-bottom:18px;`;
    modal.appendChild(title);

    const steps: { icon: string; label: string; desc: string }[] = [
        { icon: '📱', label: 'iOS Safari',       desc: '하단 공유 버튼(□↑) → 홈 화면에 추가' },
        { icon: '🤖', label: 'Android Chrome',   desc: '주소창 우측 ⋮ 메뉴 → 홈 화면에 추가' },
        { icon: '🖥', label: 'Desktop Chrome',   desc: '주소창 우측 설치 아이콘(⊕) 클릭' },
        { icon: '🌐', label: 'Desktop Edge',     desc: '주소창 우측 앱 아이콘 → 설치' },
    ];

    steps.forEach(s => {
        const row = document.createElement('div');
        row.style.cssText = `display:flex; gap:10px; align-items:flex-start; margin-bottom:14px;`;

        const icon = document.createElement('span');
        icon.textContent = s.icon;
        icon.style.cssText = `font-size:20px; flex-shrink:0; line-height:1.4;`;

        const text = document.createElement('div');
        const lbl = document.createElement('div');
        lbl.textContent = s.label;
        lbl.style.cssText = `font-size:13px; font-weight:600; color:#bbb; margin-bottom:2px;`;
        const desc = document.createElement('div');
        desc.textContent = s.desc;
        desc.style.cssText = `font-size:12px; color:#888; line-height:1.5;`;
        text.appendChild(lbl);
        text.appendChild(desc);

        row.appendChild(icon);
        row.appendChild(text);
        modal.appendChild(row);
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '닫기';
    closeBtn.style.cssText = `
        width:100%; margin-top:8px; padding:10px;
        background:#3a3a3a; color:#e0e0e0;
        border:1px solid #555; border-radius:6px;
        font-size:14px; cursor:pointer;
    `;
    closeBtn.addEventListener('click', () => overlay.remove());
    modal.appendChild(closeBtn);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}
