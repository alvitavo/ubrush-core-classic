import { getFavoritesSync, isFavorite, setFavorite } from './favorites/FavoritesManager';
import { UBrushContext } from '../UBrushCore/gpu/UBrushContext';
import { Canvas, CanvasDelegate } from '../UBrushCore/canvas/Canvas';
import { IBrush } from '../UBrushCore/common/IBrush';
import { Size } from '../UBrushCore/common/Size';
import { Point } from '../UBrushCore/common/Point';
import { Stylus } from '../UBrushCore/common/Stylus';
import { ProgramManager } from '../UBrushCore/program/ProgramManager';
import { Color } from '../UBrushCore/common/Color';
import { AffineTransform } from '../UBrushCore/common/AffineTransform';
import { RenderObjectBlend } from '../UBrushCore/gpu/RenderObject';
import { Common } from '../UBrushCore/common/Common';
import { Rect } from '../UBrushCore/common/Rect';
import { FixerGroup } from '../UBrushCore/common/FixerGroup';
import { BrushCategory } from './App';

const SIDEBAR_W = 220;

export class DrawingScreen implements CanvasDelegate {
    readonly element: HTMLElement;

    private glCanvas!: HTMLCanvasElement;
    private canvasContainer!: HTMLElement;
    private canvas?: Canvas;
    private glContext?: UBrushContext;
    private canvasWidth = 0;
    private canvasHeight = 0;

    private lastPos: Point = new Point();
    private lastStylus: Stylus = new Stylus();
    private stylusEventCount: number = 0;
    private undoStack: FixerGroup[] = [];
    private loopPaused = false;

    private categories: BrushCategory[] = [];
    private currentCategoryIndex = 0;
    private currentBrushIndex = 0;
    private currentColor = new Color(0, 0, 0, 1);
    private currentSize = 0.1;
    private currentOpacity = 1.0;

    private savedBrush: IBrush | null = null;
    private isInitialRestore = false;
    private static readonly STORAGE_KEY = 'ubrush_state';

    private categorySelectEl!: HTMLSelectElement;
    private brushSelectEl!: HTMLSelectElement;
    private favStarBtn!: HTMLButtonElement;
    private undoBtnEl!: HTMLButtonElement;
    private colorInputEl!: HTMLInputElement;
    private selectedSwatch: HTMLButtonElement | null = null;

    private onEditBrush: () => void;

    constructor(categories: BrushCategory[], onEditBrush: () => void) {
        this.categories = categories;
        this.onEditBrush = onEditBrush;
        this.loadPersistedState();
        this.element = this.buildLayout();
        this.initWebGL();
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
        this.undoBtnEl.disabled = false;
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

        // Divider
        sidebar.appendChild(divider());

        // Clear button
        sidebar.appendChild(actionBtn('Clear', '#4a4a4a', () => this.canvas?.clear()));

        // Dry button
        sidebar.appendChild(actionBtn('Dry', '#4a4a4a', () => this.canvas?.dry()));

        // Undo button
        this.undoBtnEl = actionBtn('Undo', '#4a4a4a', () => this.undo());
        this.undoBtnEl.disabled = true;
        this.undoBtnEl.hidden = true;

        sidebar.appendChild(this.undoBtnEl);

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

    // ---- WebGL initialization ----

    private initWebGL(): void {
        const w = window.innerWidth - SIDEBAR_W;
        const h = window.innerHeight;
        this.canvasWidth = w * 2;
        this.canvasHeight = h * 2;

        this.glCanvas.width = w * 2;
        this.glCanvas.height = h * 2;

        const contextAttributes: WebGLContextAttributes = {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: true,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
        };

        const gl = this.glCanvas.getContext('webgl2', contextAttributes);

        if (!gl) {
            console.error('WebGL2 not supported');
            return;
        }

        const context = new UBrushContext(gl, new Size(w * 2, h * 2));
        this.glContext = context;

        const canvas = new Canvas(context, new Size(w * 2, h * 2));
        canvas.delegate = this;
        this.canvas = canvas;

        ProgramManager.init(context);

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

        ProgramManager.getInstance().fillRectProgram.fill(
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

    private onPointerDown = (e: MouseEvent | TouchEvent): void => {
        e.preventDefault();
        this.stylusEventCount = 0;
        this.lastPos = this.eventPoint(e);
        this.lastStylus = this.eventStylus(e);
        this.canvas?.moveTo(this.lastPos, this.lastStylus);

        if (e instanceof MouseEvent) {
            document.addEventListener('mousemove', this.onPointerMove);
            document.addEventListener('mouseup', this.onPointerUp);
        } else {
            document.addEventListener('touchmove', this.onPointerMove);
            document.addEventListener('touchend', this.onPointerUp);
        }
    };

    private onPointerMove = (e: MouseEvent | TouchEvent): void => {
        this.lastPos = this.eventPoint(e);
        this.lastStylus = this.eventStylus(e);
        this.canvas?.lineTo(this.lastPos, this.lastStylus);
    };

    private onPointerUp = (e: MouseEvent | TouchEvent): void => {
        e.preventDefault();
        this.canvas?.endLine(this.lastPos, this.lastStylus);
        document.removeEventListener('mousemove', this.onPointerMove);
        document.removeEventListener('mouseup', this.onPointerUp);
        document.removeEventListener('touchmove', this.onPointerMove);
        document.removeEventListener('touchend', this.onPointerUp);
    };

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

    // ---- Undo ----

    private undo(): void {
        if (this.undoStack.length === 0) return;
        const group = this.undoStack.pop()!;

        if (group.undoFixerLiquid) {
            this.canvas?.fix(group.undoFixerLiquid, true);
        } else if (group.undoFixer) {
            this.canvas?.fix(group.undoFixer, false);
        }

        this.undoBtnEl.disabled = this.undoStack.length === 0;
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
    initial: number, onChange: (v: number) => void
): HTMLElement {
    const wrap = document.createElement('div');

    const header = document.createElement('div');
    header.style.cssText = `display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;`;
    const lbl = document.createElement('span');
    lbl.textContent = labelText;
    lbl.style.cssText = `font-size:11px; color:#9a9a9a; font-weight:600; text-transform:uppercase; letter-spacing:.4px;`;
    const valSpan = document.createElement('span');
    valSpan.style.cssText = `font-size:11px; color:#7a9fc0;`;
    valSpan.textContent = initial.toFixed(2);
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
        valSpan.textContent = v.toFixed(2);
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
