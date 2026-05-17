import { getFavoritesSync, isFavorite, setFavorite } from './favorites/FavoritesManager';
import { WGPUContext } from '../UBrushCore/gpu/webgpu/WGPUContext';
import { bootstrapWebGPU } from '../UBrushCore/gpu/webgpu/bootstrap';
import { Canvas, CanvasDelegate } from '../UBrushCore/canvas/Canvas';
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
import { FixerGroup } from '../UBrushCore/common/FixerGroup';
import { BrushCategory } from './App';
import { FloodFillTuningMode } from '../UBrushCore/program/webgpu/WGPUFloodFillProgram';

const SIDEBAR_W = 220;
const STRAIGHTEN_MORPH_MS = 180;

interface StrokeSample {
    point: Point;
    stylus: Stylus;
}

type ShapeAssistMode = 'line' | 'bezier';

interface ShapeAssistHandles {
    start: Point;
    control1: Point;
    control2: Point;
    end: Point;
}

type ShapeAssistHandleKey = keyof ShapeAssistHandles;

export class DrawingScreen implements CanvasDelegate {
    readonly element: HTMLElement;

    private glCanvas!: HTMLCanvasElement;
    private canvasContainer!: HTMLElement;
    private canvas?: Canvas;
    private glContext?: WGPUContext;
    private canvasWidth = 0;
    private canvasHeight = 0;

    private lastPos: Point = new Point();
    private lastStylus: Stylus = new Stylus();
    private stylusEventCount: number = 0;
    private undoStack: FixerGroup[] = [];
    private redoStack: FixerGroup[] = [];
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

    private savedBrush: IBrush | null = null;
    private isInitialRestore = false;
    private static readonly STORAGE_KEY = 'ubrush_state';

    private categorySelectEl!: HTMLSelectElement;
    private brushSelectEl!: HTMLSelectElement;
    private favStarBtn!: HTMLButtonElement;
    private undoBtnEl!: HTMLButtonElement;
    private redoBtnEl!: HTMLButtonElement;
    private colorInputEl!: HTMLInputElement;
    private brushToolBtn!: HTMLButtonElement;
    private fillToolBtn!: HTMLButtonElement;
    private fillTuningSelectEl!: HTMLSelectElement;
    private webGPUStatsEl!: HTMLElement;
    private fillStatsEl!: HTMLElement;
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
        this.canvas?.setBrush(JSON.parse(JSON.stringify(cloned)));
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

    changeRect(_canvas: Canvas, _rect: Rect): void {}

    didReleaseDrawingWithFixerGroup(_canvas: Canvas, fixerGroup: FixerGroup): void {
        this.undoStack.push(fixerGroup);
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    didDryCanvas(_canvas: Canvas): void {}

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
            if (brush && this.canvas) {
                this.canvas.setBrush(JSON.parse(JSON.stringify(brush)));
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

        sidebar.appendChild(this.buildWebGPUStatsSection());

        // Size slider
        sidebar.appendChild(sliderRow('Size', 0, 0.5, 0.001, this.currentSize, (v) => {
            this.currentSize = v;
            this.canvas?.lineDriver.setBrushSize(v);
            this.saveState();
        }));

        // Opacity slider
        sidebar.appendChild(sliderRow('Opacity', 0, 1, 0.05, this.currentOpacity, (v) => {
            this.currentOpacity = v;
            this.canvas?.lineDriver.setBrushOpacity(v);
            this.saveState();
        }));

        sidebar.appendChild(sliderRow('Fill Tolerance', 0, 255, 1, this.fillTolerance, (v) => {
            this.fillTolerance = v;
        }, 0));

        sidebar.appendChild(sliderRow('Edge Sensitivity', 0, 100, 1, this.fillEdgeSensitivity, (v) => {
            this.fillEdgeSensitivity = v;
        }, 0));

        sidebar.appendChild(row('Fill Tuning', () => this.buildFillTuningSelect()));

        sidebar.appendChild(this.buildFillStatsSection());

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
        if (brushes.length > 0 && this.canvas && !this.isInitialRestore) {
            this.canvas.setBrush(JSON.parse(JSON.stringify(brushes[targetIndex])));
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

        const canvas = new Canvas(context, size);
        canvas.delegate = this;
        this.canvas = canvas;

        WGPUProgramManager.init(context);

        // Apply saved brush or fall back to first available brush across all categories
        const firstAvailable = this.categories.reduce<IBrush | undefined>(
            (found, cat) => found ?? cat.brushes?.[0], undefined
        );
        const brushToApply = this.savedBrush ?? firstAvailable;
        if (brushToApply) {
            canvas.setBrush(JSON.parse(JSON.stringify(brushToApply)));
        }
        this.isInitialRestore = false;

        canvas.setColor(this.currentColor.clone());
        canvas.lineDriver.setBrushSize(this.currentSize);
        canvas.lineDriver.setBrushOpacity(this.currentOpacity);

        this.attachInputEvents();
        this.loop();
    }

    // ---- Render loop ----

    private loop(): void {
        if (!this.loopPaused) this.render();
        requestAnimationFrame(this.loop.bind(this));
    }

    private render(): void {
        if (!this.canvas || !this.glContext) return;

        this.glContext.clearRenderTarget(null, Color.white());

        WGPUProgramManager.getInstance().fillRectProgram.fill(
            null,
            {
                targetRect: Common.stageRect(),
                source: this.canvas.outputRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.Normal
            }
        );
    }

    // ---- Input events ----

    private attachInputEvents(): void {
        this.glCanvas.addEventListener('mousedown', this.onPointerDown);
        this.glCanvas.addEventListener('touchstart', this.onPointerDown, { passive: false });
    }

    private onPointerDown = async (e: MouseEvent | TouchEvent): Promise<void> => {
        e.preventDefault();
        if (this.shapeAssistEditingContext) {
            await this.commitShapeAssistContext();
        }

        this.stylusEventCount = 0;
        this.lastPos = this.eventPoint(e);
        this.clearStraightLineTimer();
        this.straightLinePreviewActive = false;
        this.straightLineActivating = false;
        this.straightLineActivationPromise = null;
        this.straightLineSamples = [];
        this.shapeAssistCurveSamples = [];
        this.shapeAssistMode = 'line';
        this.shapeAssistHandles = null;
        this.shapeAssistEditingContext = false;
        this.hideShapeAssistUI();
        this.straightLineStrokeGroup = null;
        this.straightLineUndoGroup = null;

        if (this.currentTool === 'fill') {
            await this.applyFloodFill(this.lastPos);
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
        }, 3000);
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
                this.canvas.replaceActiveLineWithPath(samples, { disableSmudging });

                if (rawT >= 1) {
                    resolve();
                } else {
                    requestAnimationFrame(frame);
                }
            };

            requestAnimationFrame(frame);
        });
    }

    private renderShapeAssistPreview(): void {
        if (!this.canvas || !this.shapeAssistHandles) return;
        const samples = this.buildShapeAssistSamples(this.shapeAssistMode, Math.max(2, this.shapeAssistCurveSamples.length));
        this.canvas.replaceActiveLineWithPath(samples, { disableSmudging: this.canvas.brushUsesSmudging() });
        this.updateShapeAssistHandles();
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

    private createShapeAssistHandles(mode: ShapeAssistMode): ShapeAssistHandles {
        const start = this.straightLineStartPos!.clone();
        const end = this.lastPos.clone();
        const chord = Math.max(1, Common.distance(start, end));
        const startTangent = mode === 'bezier' ? this.strokeTangent(this.shapeAssistCurveSamples, true) : this.unitPoint(start, end);
        const endTangent = mode === 'bezier' ? this.strokeTangent(this.shapeAssistCurveSamples, false) : this.unitPoint(start, end);

        return {
            start,
            control1: new Point(start.x + startTangent.x * chord * 0.35, start.y + startTangent.y * chord * 0.35),
            control2: new Point(end.x - endTangent.x * chord * 0.35, end.y - endTangent.y * chord * 0.35),
            end
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
        this.shapeAssistMode = mode;
        this.shapeAssistHandles = this.createShapeAssistHandles(mode);
        this.updateShapeAssistRibbon();
        this.renderShapeAssistPreview();
    }

    private chooseShapeAssistMode(samples: StrokeSample[]): ShapeAssistMode {
        if (samples.length < 3) return 'line';
        const pathLength = this.strokePathLength(samples);
        if (pathLength <= 0) return 'line';
        const chord = Common.distance(samples[0].point, samples[samples.length - 1].point);
        return chord / pathLength > 0.94 ? 'line' : 'bezier';
    }

    private strokePathLength(samples: StrokeSample[]): number {
        let length = 0;
        for (let i = 1; i < samples.length; i++) {
            length += Common.distance(samples[i - 1].point, samples[i].point);
        }
        return length;
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
        const curveBtn = this.shapeAssistButton('Curve', () => this.selectShapeAssistMode('bezier'));
        curveBtn.dataset.mode = 'bezier';
        const doneBtn = this.shapeAssistButton('Done', () => void this.commitShapeAssistContext());
        doneBtn.style.marginLeft = '6px';
        ribbon.appendChild(lineBtn);
        ribbon.appendChild(curveBtn);
        ribbon.appendChild(doneBtn);
        this.canvasContainer.appendChild(ribbon);
        this.shapeAssistRibbonEl = ribbon;

        const handles = document.createElement('div');
        handles.style.cssText = `position:absolute; inset:0; pointer-events:none; z-index:19;`;
        this.canvasContainer.appendChild(handles);
        this.shapeAssistHandlesEl = handles;

        this.updateShapeAssistRibbon();
        this.updateShapeAssistHandles();
        document.addEventListener('mousedown', this.onShapeAssistDocumentMouseDown, true);
    }

    private hideShapeAssistUI(): void {
        document.removeEventListener('mousedown', this.onShapeAssistDocumentMouseDown, true);
        this.shapeAssistRibbonEl?.remove();
        this.shapeAssistHandlesEl?.remove();
        this.shapeAssistRibbonEl = null;
        this.shapeAssistHandlesEl = null;
        this.shapeAssistDragKey = null;
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
            : ['start', 'control1', 'control2', 'end'];

        for (const key of keys) {
            const point = this.shapeAssistHandles[key];
            const pos = this.canvasPointToContainer(point);
            const handle = document.createElement('div');
            handle.style.cssText = `
                position:absolute; left:${pos.x}px; top:${pos.y}px; width:13px; height:13px;
                margin-left:-6.5px; margin-top:-6.5px; border-radius:50%;
                background:${key === 'control1' || key === 'control2' ? '#f1b84a' : '#4a90d9'};
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
        document.addEventListener('mousemove', this.onShapeAssistHandleMove);
        document.addEventListener('mouseup', this.onShapeAssistHandleUp);
    }

    private onShapeAssistHandleMove = (e: MouseEvent): void => {
        if (!this.shapeAssistDragKey || !this.shapeAssistHandles) return;
        e.preventDefault();
        const point = this.clientPointToCanvasPoint(e.clientX, e.clientY);
        this.shapeAssistHandles[this.shapeAssistDragKey] = point;
        if (this.shapeAssistDragKey === 'end') this.lastPos = point.clone();
        if (this.shapeAssistDragKey === 'start') this.straightLineStartPos = point.clone();
        this.renderShapeAssistPreview();
    };

    private onShapeAssistHandleUp = (): void => {
        this.shapeAssistDragKey = null;
        document.removeEventListener('mousemove', this.onShapeAssistHandleMove);
        document.removeEventListener('mouseup', this.onShapeAssistHandleUp);
    };

    private onShapeAssistDocumentMouseDown = (e: MouseEvent): void => {
        if (!this.shapeAssistEditingContext) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (this.shapeAssistRibbonEl?.contains(target) || this.shapeAssistHandlesEl?.contains(target)) return;
        if (target === this.glCanvas) return;
        void this.commitShapeAssistContext();
    };

    private async commitShapeAssistContext(): Promise<void> {
        if (!this.shapeAssistEditingContext || !this.canvas || !this.straightLineUndoGroup) return;

        this.renderShapeAssistPreview();
        const fixerGroup = await this.canvas.commitStraightenedLine(this.straightLineUndoGroup);
        if (this.hasAnyFixer(fixerGroup) && this.hasAnyRedoFixer(fixerGroup)) {
            if (this.straightLineStrokeGroup && this.hasAnyFixer(this.straightLineStrokeGroup) && this.hasAnyRedoFixer(this.straightLineStrokeGroup)) {
                this.undoStack.push(this.straightLineStrokeGroup);
            }
            this.undoStack.push(fixerGroup);
            this.redoStack = [];
            this.updateUndoRedoButtons();
        }

        this.resetShapeAssistState();
    }

    private resetShapeAssistState(): void {
        this.hideShapeAssistUI();
        this.straightLinePreviewActive = false;
        this.shapeAssistEditingContext = false;
        this.straightLineActivating = false;
        this.straightLineActivationPromise = null;
        this.straightLineSamples = [];
        this.shapeAssistCurveSamples = [];
        this.shapeAssistHandles = null;
        this.straightLineStrokeGroup = null;
        this.straightLineUndoGroup = null;
        this.straightLineStartPos = null;
        this.straightLineStartStylus = null;
    }

    private canvasPointToContainer(point: Point): Point {
        const rect = this.glCanvas.getBoundingClientRect();
        return new Point(
            (point.x / this.canvasWidth) * rect.width,
            ((this.canvasHeight - point.y) / this.canvasHeight) * rect.height
        );
    }

    private clientPointToCanvasPoint(clientX: number, clientY: number): Point {
        const rect = this.glCanvas.getBoundingClientRect();
        const x = (clientX - rect.left) * (this.canvasWidth / rect.width);
        const y = this.canvasHeight - (clientY - rect.top) * (this.canvasHeight / rect.height);
        return new Point(x, y);
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

        const scaleX = this.canvasWidth / rect.width;
        const scaleY = this.canvasHeight / rect.height;
        const x = (clientX - rect.left) * scaleX;
        const y = this.canvasHeight - (clientY - rect.top) * scaleY;
        return new Point(x, y);
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

    private async clearWithHistory(): Promise<void> {
        if (!this.canvas) return;

        const group = new FixerGroup();
        group.undoFixer = (await this.canvas.fixer()) || undefined;

        this.canvas.clear();

        group.redoFixer = (await this.canvas.fixer()) || undefined;

        if (!group.undoFixer) return;

        this.undoStack.push(group);
        this.redoStack = [];
        this.updateUndoRedoButtons();
    }

    private undo(): void {
        if (this.undoStack.length === 0) return;
        if (this.pendingFillHistoryCount > 0) return;
        const group = this.undoStack.pop()!;
        if (!this.hasAnyFixer(group)) {
            this.updateUndoRedoButtons();
            return;
        }

        if (group.undoFixerLiquid) {
            this.canvas?.fix(group.undoFixerLiquid, true);
        } else if (group.undoFixer) {
            this.canvas?.fix(group.undoFixer, false);
        }

        this.redoStack.push(group);
        this.updateUndoRedoButtons();
    }

    private redo(): void {
        if (this.redoStack.length === 0) return;
        const group = this.redoStack.pop()!;
        if (!this.hasAnyRedoFixer(group)) {
            this.updateUndoRedoButtons();
            return;
        }

        if (group.redoFixerLiquid) {
            this.canvas?.fix(group.redoFixerLiquid, true);
        } else if (group.redoFixer) {
            this.canvas?.fix(group.redoFixer, false);
        }

        this.undoStack.push(group);
        this.updateUndoRedoButtons();
    }

    private updateUndoRedoButtons(): void {
        if (!this.undoBtnEl || !this.redoBtnEl) return;
        const undoTop = this.undoStack[this.undoStack.length - 1];
        const redoTop = this.redoStack[this.redoStack.length - 1];
        this.undoBtnEl.disabled = this.pendingFillHistoryCount > 0 || !this.hasAnyFixer(undoTop);
        this.redoBtnEl.disabled = !this.hasAnyRedoFixer(redoTop);
    }

    private hasAnyFixer(group?: FixerGroup): boolean {
        return !!(group?.undoFixer || group?.undoFixerLiquid);
    }

    private hasAnyRedoFixer(group?: FixerGroup): boolean {
        return !!(group?.redoFixer || group?.redoFixerLiquid);
    }

    // ---- Color ----

    private applyHexColor(hex: string): void {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        this.currentColor = new Color(r, g, b, 1);
        this.canvas?.setColor(this.currentColor.clone());
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

    private buildFillTuningSelect(): HTMLSelectElement {
        this.fillTuningSelectEl = document.createElement('select');
        this.fillTuningSelectEl.style.cssText = inputCSS;
        const options: Array<{ value: FloodFillTuningMode; label: string }> = [
            { value: 'auto', label: 'Auto' },
            { value: 'lowLatency', label: 'Low Latency' },
            { value: 'throughput', label: 'Throughput' },
        ];
        for (const option of options) {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            this.fillTuningSelectEl.appendChild(opt);
        }
        this.fillTuningSelectEl.value = this.fillTuningMode;
        this.fillTuningSelectEl.addEventListener('change', () => {
            this.fillTuningMode = this.fillTuningSelectEl.value as FloodFillTuningMode;
        });
        return this.fillTuningSelectEl;
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
            const tolerance = (this.fillTolerance / 255) * 2;
            const edgeThreshold = Math.max(0.02, (101 - this.fillEdgeSensitivity) / 100 * 1.5);
            const result = await this.canvas.floodFill(seed, this.currentColor.clone(), tolerance, edgeThreshold, this.fillTuningMode);
            if (!result) return;
            console.debug(
                `[FloodFill] ${result.metrics.mode} tuning=${result.metrics.tuningMode} total=${result.metrics.totalMs.toFixed(1)}ms dry=${result.metrics.dryMs.toFixed(1)}ms source=${result.metrics.sourceCopyMs.toFixed(1)}ms gpu=${result.metrics.gpuMs.toFixed(1)}ms post=${result.metrics.postProcessMs.toFixed(1)}ms history=${result.metrics.historyMs.toFixed(1)}ms update=${result.metrics.updateMs.toFixed(1)}ms readback=${result.metrics.readbackMs.toFixed(1)}ms iterations=${result.metrics.iterations} dispatch=${result.metrics.dispatchIterations} substeps=${result.metrics.substeps} tile=${result.metrics.tileSize} batch=${result.metrics.batchSize} bounds=${result.metrics.bounds.toString()}`
            );
            this.updateFillStats(result.metrics);
            const fixerGroup = result.fixerGroup;
            if (fixerGroup) {
                this.undoStack.push(fixerGroup);
                this.redoStack = [];
                this.updateUndoRedoButtons();
            } else if (result.historyPromise) {
                const pendingGroup = new FixerGroup();
                this.undoStack.push(pendingGroup);
                this.redoStack = [];
                this.pendingFillHistoryCount++;
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
                    .catch((error) => console.error('Flood fill history failed', error))
                    .finally(() => {
                        if (!historyReady) {
                            const idx = this.undoStack.indexOf(pendingGroup);
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

    private buildFillStatsSection(): HTMLElement {
        const wrap = document.createElement('div');
        const lbl = document.createElement('label');
        lbl.textContent = 'Fill Stats';
        lbl.style.cssText = `display:block; font-size:11px; color:#9a9a9a; margin-bottom:5px; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
        wrap.appendChild(lbl);

        this.fillStatsEl = document.createElement('div');
        this.fillStatsEl.style.cssText = `
            min-height:72px; padding:8px;
            background:#202020; border:1px solid #3f3f3f; border-radius:5px;
            color:#8fa8bd; font-size:11px; line-height:1.45;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            white-space:pre-wrap;
        `;
        this.fillStatsEl.textContent = 'No fill yet';
        wrap.appendChild(this.fillStatsEl);
        return wrap;
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
        if (!this.fillStatsEl) return;
        const bounds = `${metrics.bounds.size.width}x${metrics.bounds.size.height}`;
        this.fillStatsEl.textContent =
            `mode       ${metrics.mode}\n` +
            `tuning     ${metrics.tuningMode}\n` +
            `total      ${metrics.totalMs.toFixed(1)} ms\n` +
            `dry        ${metrics.dryMs.toFixed(1)} ms\n` +
            `source     ${metrics.sourceCopyMs.toFixed(1)} ms\n` +
            `gpu        ${metrics.gpuMs.toFixed(1)} ms\n` +
            `post       ${metrics.postProcessMs.toFixed(1)} ms\n` +
            `history    ${metrics.historyMs.toFixed(1)} ms\n` +
            `update     ${metrics.updateMs.toFixed(1)} ms\n` +
            `iter       ${metrics.iterations} (${metrics.dispatchIterations} dispatch)\n` +
            `readback   ${metrics.readbackMs.toFixed(1)} ms\n` +
            `tile/sub   ${metrics.tileSize}/${metrics.substeps}\n` +
            `batch      ${metrics.batchSize}\n` +
            `bounds     ${bounds}`;
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
