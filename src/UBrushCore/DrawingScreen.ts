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
    private currentSize = 0.5;
    private currentOpacity = 1.0;

    private categorySelectEl!: HTMLSelectElement;
    private brushSelectEl!: HTMLSelectElement;
    private undoBtnEl!: HTMLButtonElement;

    private onEditBrush: () => void;

    constructor(categories: BrushCategory[], onEditBrush: () => void) {
        this.categories = categories;
        this.onEditBrush = onEditBrush;
        this.element = this.buildLayout();
        this.initWebGL();
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
    }

    getCurrentBrush(): IBrush | undefined {
        return this.categories[this.currentCategoryIndex]?.brushes?.[this.currentBrushIndex];
    }

    getCurrentBrushInfo(): { brush: IBrush; categoryFile: string } | undefined {
        // Try current selection first; fall back to the first loaded brush in any category
        for (let ci = this.currentCategoryIndex; ci < this.categories.length; ci++) {
            const cat = this.categories[ci];
            const bi = ci === this.currentCategoryIndex ? this.currentBrushIndex : 0;
            const brush = cat?.brushes?.[bi];
            if (brush) return { brush, categoryFile: cat.file };
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
        this.glCanvas.style.cssText = `display: block; cursor: crosshair;`;
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
            this.categorySelectEl.addEventListener('change', () => {
                this.currentCategoryIndex = parseInt(this.categorySelectEl.value);
                this.currentBrushIndex = 0;
                this.loadCategoryAndRefreshBrushList();
            });
            return this.categorySelectEl;
        }));

        // Brush selector
        sidebar.appendChild(row('Brush', () => {
            this.brushSelectEl = document.createElement('select');
            this.brushSelectEl.style.cssText = inputCSS;
            this.brushSelectEl.addEventListener('change', () => {
                this.currentBrushIndex = parseInt(this.brushSelectEl.value);
                const cat = this.categories[this.currentCategoryIndex];
                const brush = cat?.brushes?.[this.currentBrushIndex];
                if (brush && this.canvas) {
                    this.canvas.setBrush(JSON.parse(JSON.stringify(brush)));
                }
            });
            // Populate with first category's brushes (already loaded)
            this.refreshBrushList();
            return this.brushSelectEl;
        }));

        // Color picker
        sidebar.appendChild(row('Color', () => {
            const inp = document.createElement('input');
            inp.type = 'color';
            inp.value = '#000000';
            inp.style.cssText = `width:100%; height:32px; border:none; border-radius:4px; cursor:pointer; background:none;`;
            inp.addEventListener('input', () => {
                const hex = inp.value.replace('#', '');
                const r = parseInt(hex.slice(0, 2), 16) / 255;
                const g = parseInt(hex.slice(2, 4), 16) / 255;
                const b = parseInt(hex.slice(4, 6), 16) / 255;
                this.currentColor = new Color(r, g, b, 1);
                this.canvas?.setColor(this.currentColor.clone());
            });
            return inp;
        }));

        // Size slider
        sidebar.appendChild(sliderRow('Size', 0, 1, 0.05, this.currentSize, (v) => {
            this.currentSize = v;
            this.canvas?.lineDriver.setBrushSize(v);
        }));

        // Opacity slider
        sidebar.appendChild(sliderRow('Opacity', 0, 1, 0.05, this.currentOpacity, (v) => {
            this.currentOpacity = v;
            this.canvas?.lineDriver.setBrushOpacity(v);
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
        sidebar.appendChild(this.undoBtnEl);

        // Divider
        sidebar.appendChild(divider());

        // Edit Brush button
        sidebar.appendChild(actionBtn('Edit Brush', '#2a5aa0', () => this.onEditBrush()));

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
        this.brushSelectEl.value = '0';

        // Apply first brush of this category to canvas
        if (brushes.length > 0 && this.canvas) {
            this.canvas.setBrush(JSON.parse(JSON.stringify(brushes[0])));
        }
    }

    /** Lazy-loads the category if needed, then refreshes the brush list. */
    private loadCategoryAndRefreshBrushList(): void {
        const cat = this.categories[this.currentCategoryIndex];
        if (!cat) return;

        if (cat.brushes) {
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
        this.glCanvas.style.width = w + 'px';
        this.glCanvas.style.height = h + 'px';

        const contextAttributes: WebGLContextAttributes = {
            alpha: false,
            depth: false,
            stencil: false,
            antialias: true,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
        };

        const gl = (
            this.glCanvas.getContext('webgl', contextAttributes) ||
            this.glCanvas.getContext('experimental-webgl', contextAttributes)
        ) as WebGLRenderingContext;

        if (!gl) {
            console.error('WebGL not supported');
            return;
        }

        const context = new UBrushContext(gl, new Size(w * 2, h * 2));
        this.glContext = context;

        const canvas = new Canvas(context, new Size(w * 2, h * 2));
        canvas.delegate = this;
        this.canvas = canvas;

        ProgramManager.init(context);

        // Apply first brush of first category
        const firstCat = this.categories[0];
        const firstBrush = firstCat?.brushes?.[0];
        if (firstBrush) {
            canvas.setBrush(JSON.parse(JSON.stringify(firstBrush)));
        }

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
