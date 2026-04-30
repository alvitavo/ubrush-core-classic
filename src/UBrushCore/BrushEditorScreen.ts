import { IBrush } from '../UBrushCore/common/IBrush';
import { BrushAttributeRenderer, AttributeGroup } from './BrushAttributeRenderer';
import { UBrushContext } from '../UBrushCore/gpu/UBrushContext';
import { Canvas, CanvasDelegate } from '../UBrushCore/canvas/Canvas';
import { ProgramManager } from '../UBrushCore/program/ProgramManager';
import { Size } from '../UBrushCore/common/Size';
import { Color } from '../UBrushCore/common/Color';
import { Point } from '../UBrushCore/common/Point';
import { Stylus } from '../UBrushCore/common/Stylus';
import { AffineTransform } from '../UBrushCore/common/AffineTransform';
import { Common } from '../UBrushCore/common/Common';
import { RenderObjectBlend } from '../UBrushCore/gpu/RenderObject';
import { Rect } from '../UBrushCore/common/Rect';
import { FixerGroup } from '../UBrushCore/common/FixerGroup';

const PREVIEW_W = 440;

interface EditAttributeData {
    dataModel: AttributeGroup[];
}

export class BrushEditorScreen {
    readonly element: HTMLElement;

    // ---- editor state ----
    private tabButtons: HTMLButtonElement[] = [];
    private tabPanels: HTMLElement[] = [];
    private activeTab: number = 0;
    private currentBrush: IBrush | null = null;
    private currentCategoryFile: string = '';
    private schema: AttributeGroup[] = [];
    private renderer = new BrushAttributeRenderer();
    private onBack: () => void;
    private onApply: (brush: IBrush) => void;
    private applyBtn!: HTMLButtonElement;
    private saveBtn?: HTMLButtonElement;
    private restoreBtn?: HTMLButtonElement;
    private statusEl!: HTMLElement;
    private _tabNav!: HTMLElement;
    private _tabContent!: HTMLElement;

    // ---- preview state ----
    private previewGLCanvas!: HTMLCanvasElement;
    private previewGLContext?: UBrushContext;
    private previewDrawingCanvas?: Canvas;
    private previewPMInstance?: any;   // preview ProgramManager instance
    private mainPMInstance?: any;      // saved main ProgramManager instance
    private previewColor = new Color(0, 0, 0, 1);
    private previewLastPos = new Point();
    private previewLastStylus = new Stylus();
    private previewLoopActive = false;
    private previewCanvasW = 0;
    private previewCanvasH = 0;
    private previewUpdateTimer?: number;

    constructor(onBack: () => void, onApply: (brush: IBrush) => void) {
        this.onBack = onBack;
        this.onApply = onApply;
        this.element = this.buildLayout();
    }

    async loadSchema(): Promise<void> {
        const resp = await fetch('UBrushEditAttribute.json');
        const json = await resp.json() as EditAttributeData;
        this.schema = json.dataModel;
        this.buildTabs();
    }

    /** Called AFTER show(), so preview PM is already active. */
    loadBrush(brush: IBrush, categoryFile: string): void {
        this.currentBrush = JSON.parse(JSON.stringify(brush));
        this.currentCategoryFile = categoryFile;
        this.statusEl.textContent = '';
        if (this.previewDrawingCanvas) {
            this.previewDrawingCanvas.setBrush(JSON.parse(JSON.stringify(brush)));
        }
        this.renderActiveTab();
    }

    show(): void {
        this.element.style.display = 'flex';
        if (!this.previewGLContext) {
            requestAnimationFrame(() => {
                this.initPreviewGL();
                this.startPreview();
            });
        } else {
            this.startPreview();
        }
    }

    private startPreview(): void {
        this.activatePreviewPM();
        if (this.currentBrush && this.previewDrawingCanvas) {
            this.previewDrawingCanvas.setBrush(JSON.parse(JSON.stringify(this.currentBrush)));
        }
        this.previewLoopActive = true;
        this.previewLoop();
    }

    hide(): void {
        this.previewLoopActive = false;
        this.restoreMainPM();
        this.element.style.display = 'none';
    }

    // ---- PM management ----

    private activatePreviewPM(): void {
        if (!this.previewPMInstance) return;
        this.mainPMInstance = (ProgramManager as any).instance;
        (ProgramManager as any).instance = this.previewPMInstance;
    }

    private restoreMainPM(): void {
        if (this.mainPMInstance !== undefined) {
            (ProgramManager as any).instance = this.mainPMInstance;
        }
    }

    // ---- preview GL init ----

    private initPreviewGL(): void {
        const rect = this.previewGLCanvas.getBoundingClientRect();
        const displayW = rect.width > 0 ? rect.width : PREVIEW_W;
        const displayH = rect.height > 0 ? rect.height : Math.max(400, window.innerHeight - 195);
        this.previewCanvasW = Math.round(displayW * 2);
        this.previewCanvasH = Math.round(displayH * 2);

        this.previewGLCanvas.width = this.previewCanvasW;
        this.previewGLCanvas.height = this.previewCanvasH;

        const contextAttributes: WebGLContextAttributes = {
            alpha: false, depth: false, stencil: false,
            antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true,
        };
        const gl = this.previewGLCanvas.getContext('webgl2', contextAttributes);
        if (!gl) { console.error('Preview WebGL2 not supported'); return; }

        this.previewGLContext = new UBrushContext(gl, new Size(this.previewCanvasW, this.previewCanvasH));

        // Save main PM, init preview PM, then restore main PM
        const savedPM = (ProgramManager as any).instance;
        ProgramManager.init(this.previewGLContext);
        this.previewPMInstance = (ProgramManager as any).instance;
        (ProgramManager as any).instance = savedPM;

        // Create preview Canvas (no undo → useFixer = false)
        const previewCanvas = new Canvas(this.previewGLContext, new Size(this.previewCanvasW, this.previewCanvasH));
        previewCanvas.useFixer = false;
        previewCanvas.delegate = this.makeNullDelegate();
        this.previewDrawingCanvas = previewCanvas;

        this.previewDrawingCanvas.setColor(this.previewColor.clone());
        this.previewDrawingCanvas.lineDriver.setBrushSize(0.5);
        this.previewDrawingCanvas.lineDriver.setBrushOpacity(1.0);

        this.attachPreviewInputEvents();
    }

    private makeNullDelegate(): CanvasDelegate {
        return {
            changeRect: (_c: Canvas, _r: Rect) => {},
            didReleaseDrawingWithFixerGroup: (_c: Canvas, _f: FixerGroup) => {},
            didDryCanvas: (_c: Canvas) => {},
        };
    }

    // ---- preview render loop ----

    private previewLoop(): void {
        if (!this.previewLoopActive) return;
        this.renderPreview();
        requestAnimationFrame(() => this.previewLoop());
    }

    private renderPreview(): void {
        if (!this.previewDrawingCanvas || !this.previewGLContext) return;
        this.previewGLContext.clearRenderTarget(null, Color.white());
        ProgramManager.getInstance().fillRectProgram.fill(
            null,
            {
                targetRect: Common.stageRect(),
                source: this.previewDrawingCanvas.outputRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.Normal,
            }
        );
    }

    // ---- preview input events ----

    private attachPreviewInputEvents(): void {
        this.previewGLCanvas.addEventListener('mousedown', this.onPreviewDown);
        this.previewGLCanvas.addEventListener('touchstart', this.onPreviewDown, { passive: false });
    }

    private onPreviewDown = (e: MouseEvent | TouchEvent): void => {
        e.preventDefault();
        this.previewLastPos = this.previewEventPoint(e);
        this.previewLastStylus = this.previewEventStylus(e);
        this.previewDrawingCanvas?.moveTo(this.previewLastPos, this.previewLastStylus);
        if (e instanceof MouseEvent) {
            document.addEventListener('mousemove', this.onPreviewMove);
            document.addEventListener('mouseup', this.onPreviewUp);
        } else {
            document.addEventListener('touchmove', this.onPreviewMove);
            document.addEventListener('touchend', this.onPreviewUp);
        }
    };

    private onPreviewMove = (e: MouseEvent | TouchEvent): void => {
        this.previewLastPos = this.previewEventPoint(e);
        this.previewLastStylus = this.previewEventStylus(e);
        this.previewDrawingCanvas?.lineTo(this.previewLastPos, this.previewLastStylus);
    };

    private onPreviewUp = (e: MouseEvent | TouchEvent): void => {
        e.preventDefault();
        this.previewDrawingCanvas?.endLine(this.previewLastPos, this.previewLastStylus);
        document.removeEventListener('mousemove', this.onPreviewMove);
        document.removeEventListener('mouseup', this.onPreviewUp);
        document.removeEventListener('touchmove', this.onPreviewMove);
        document.removeEventListener('touchend', this.onPreviewUp);
    };

    private previewEventPoint(e: MouseEvent | TouchEvent): Point {
        const rect = this.previewGLCanvas.getBoundingClientRect();
        let clientX: number, clientY: number;
        if (e instanceof MouseEvent) {
            clientX = e.clientX; clientY = e.clientY;
        } else {
            clientX = e.touches[0]?.clientX ?? 0;
            clientY = e.touches[0]?.clientY ?? 0;
        }
        // CSS 표시 크기 → WebGL 내부 픽셀 좌표로 변환 후 Y 플립
        const scaleX = this.previewCanvasW / rect.width;
        const scaleY = this.previewCanvasH / rect.height;
        const x = (clientX - rect.left) * scaleX;
        const y = this.previewCanvasH - (clientY - rect.top) * scaleY;
        return new Point(x, y);
    }

    private previewEventStylus(e: MouseEvent | TouchEvent): Stylus {
        if (e instanceof MouseEvent) return new Stylus();
        const touch = e.touches[0];
        if ((touch as any).touchType === 'stylus') {
            return new Stylus(
                touch.force,
                1.0 - (touch as any).altitudeAngle / (0.5 * Math.PI),
                0.25 - (touch as any).azimuthAngle / (2 * Math.PI)
            );
        }
        return new Stylus();
    }

    // ---- layout ----

    private buildLayout(): HTMLElement {
        const screen = document.createElement('div');
        screen.style.cssText = `
            display: none;
            flex-direction: column;
            width: 100vw;
            height: 100vh;
            background: #1e1e1e;
            font-family: sans-serif;
            overflow: hidden;
        `;

        screen.appendChild(this.buildHeader());

        const body = document.createElement('div');
        body.style.cssText = `display:flex; flex:1; overflow:hidden;`;

        const tabNav = document.createElement('div');
        tabNav.style.cssText = `
            width: 150px; min-width: 150px;
            background: #252525;
            border-right: 1px solid #3a3a3a;
            display: flex; flex-direction: column;
            padding: 8px 0; overflow-y: auto;
        `;

        const tabContent = document.createElement('div');
        tabContent.style.cssText = `
            flex: 1; overflow-y: auto; padding: 20px;
        `;

        body.appendChild(tabNav);
        body.appendChild(tabContent);
        body.appendChild(this.buildPreviewPanel());
        screen.appendChild(body);

        this._tabNav = tabNav;
        this._tabContent = tabContent;

        return screen;
    }

    private buildPreviewPanel(): HTMLElement {
        const panel = document.createElement('div');
        panel.style.cssText = `
            width: ${PREVIEW_W}px; min-width: ${PREVIEW_W}px;
            background: #1a1a1a;
            border-left: 1px solid #3a3a3a;
            display: flex; flex-direction: column;
            overflow: hidden;
        `;

        // Label
        const label = document.createElement('div');
        label.textContent = 'Preview';
        label.style.cssText = `
            font-size: 11px; font-weight: 600; color: #9a9a9a;
            text-transform: uppercase; letter-spacing: .4px;
            padding: 8px 12px 6px; border-bottom: 1px solid #2a2a2a;
            flex-shrink: 0;
        `;
        panel.appendChild(label);

        // GL canvas wrapper (flex:1 to fill)
        const canvasWrap = document.createElement('div');
        canvasWrap.style.cssText = `flex:1; overflow:hidden; background:#f0f0f0; cursor:crosshair;`;

        this.previewGLCanvas = document.createElement('canvas');
        this.previewGLCanvas.style.cssText = `display:block; width:100%; height:100%;`;
        canvasWrap.appendChild(this.previewGLCanvas);
        panel.appendChild(canvasWrap);

        // Sliders area
        const sliders = document.createElement('div');
        sliders.style.cssText = `
            padding: 8px 12px 4px; border-top: 1px solid #2a2a2a; flex-shrink: 0;
            display: flex; flex-direction: column; gap: 6px;
        `;
        sliders.appendChild(previewSlider('Size', 0, 1, 0.05, 0.5, (v) => {
            this.previewDrawingCanvas?.lineDriver.setBrushSize(v);
        }));
        sliders.appendChild(previewSlider('Opacity', 0, 1, 0.05, 1.0, (v) => {
            this.previewDrawingCanvas?.lineDriver.setBrushOpacity(v);
        }));
        panel.appendChild(sliders);

        // Controls row
        const controls = document.createElement('div');
        controls.style.cssText = `
            display: flex; align-items: center; gap: 8px;
            padding: 6px 12px 10px; flex-shrink: 0;
        `;

        // Color picker
        const colorWrap = document.createElement('div');
        colorWrap.style.cssText = `display:flex; align-items:center; gap:4px; flex:1;`;
        const colorLbl = document.createElement('span');
        colorLbl.textContent = 'Color';
        colorLbl.style.cssText = `font-size:11px; color:#9a9a9a;`;
        const colorInp = document.createElement('input');
        colorInp.type = 'color';
        colorInp.value = '#000000';
        colorInp.style.cssText = `width:36px; height:28px; border:none; border-radius:4px; cursor:pointer; background:none;`;
        colorInp.addEventListener('input', () => {
            const hex = colorInp.value.replace('#', '');
            const r = parseInt(hex.slice(0, 2), 16) / 255;
            const g = parseInt(hex.slice(2, 4), 16) / 255;
            const b = parseInt(hex.slice(4, 6), 16) / 255;
            this.previewColor = new Color(r, g, b, 1);
            this.previewDrawingCanvas?.setColor(this.previewColor.clone());
        });
        colorWrap.appendChild(colorLbl);
        colorWrap.appendChild(colorInp);
        controls.appendChild(colorWrap);

        // Clear button
        controls.appendChild(previewBtn('Clear', () => {
            this.previewDrawingCanvas?.clear();
        }));

        // Dry button
        controls.appendChild(previewBtn('Dry', () => {
            this.previewDrawingCanvas?.dry();
        }));

        panel.appendChild(controls);
        return panel;
    }

    private buildHeader(): HTMLElement {
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex; align-items: center; gap: 10px;
            padding: 12px 20px; background: #252525;
            border-bottom: 1px solid #3a3a3a; flex-shrink: 0;
        `;

        const backBtn = btn('← Back', '#3a3a3a', '#ccc');
        backBtn.addEventListener('click', () => this.onBack());
        header.appendChild(backBtn);

        const title = document.createElement('span');
        title.textContent = 'Brush Editor';
        title.style.cssText = `font-size:16px; font-weight:600; color:#e0e0e0; flex:1;`;
        header.appendChild(title);

        this.statusEl = document.createElement('span');
        this.statusEl.style.cssText = `font-size:12px; color:#7ab;`;
        header.appendChild(this.statusEl);

        this.applyBtn = btn('Apply', '#2a5aa0', '#fff');
        this.applyBtn.addEventListener('click', () => {
            if (this.currentBrush) this.onApply(this.currentBrush);
        });
        header.appendChild(this.applyBtn);

        if (process.env.NODE_ENV !== 'production') {
            this.saveBtn = btn('Save to JSON', '#2a7a4a', '#fff');
            this.saveBtn.addEventListener('click', () => this.saveBrush());
            header.appendChild(this.saveBtn);

            this.restoreBtn = btn('Restore Original', '#7a4a2a', '#fff');
            this.restoreBtn.addEventListener('click', () => this.restoreBrush());
            header.appendChild(this.restoreBtn);
        }

        return header;
    }

    // ---- save / restore ----

    private async saveBrush(): Promise<void> {
        if (!this.currentBrush || !this.currentCategoryFile) return;
        if (this.saveBtn) this.saveBtn.disabled = true;
        this.setStatus('Saving…');
        try {
            const resp = await fetch('/api/save-brush', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ categoryFile: this.currentCategoryFile, brush: this.currentBrush })
            });
            const result = await resp.json();
            this.setStatus(result.ok ? 'Saved.' : `Error: ${result.error}`);
        } catch (e) {
            this.setStatus(`Network error: ${e}`);
        } finally {
            if (this.saveBtn) this.saveBtn.disabled = false;
        }
    }

    private async restoreBrush(): Promise<void> {
        if (!this.currentBrush || !this.currentCategoryFile) return;
        if (!confirm(`"${this.currentBrush.name}" 을 원본으로 복원하시겠습니까?`)) return;
        if (this.restoreBtn) this.restoreBtn.disabled = true;
        this.setStatus('Restoring…');
        try {
            const resp = await fetch('/api/restore-brush', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ categoryFile: this.currentCategoryFile, brushName: this.currentBrush.name })
            });
            const result = await resp.json();
            if (result.ok && result.brush) {
                this.currentBrush = result.brush;
                if (this.previewDrawingCanvas) {
                    this.previewDrawingCanvas.setBrush(JSON.parse(JSON.stringify(result.brush)));
                }
                this.renderActiveTab();
                this.setStatus('Restored.');
            } else {
                this.setStatus(`Error: ${result.error}`);
            }
        } catch (e) {
            this.setStatus(`Network error: ${e}`);
        } finally {
            if (this.restoreBtn) this.restoreBtn.disabled = false;
        }
    }

    private setStatus(msg: string): void {
        this.statusEl.textContent = msg;
    }

    // ---- tabs ----

    private buildTabs(): void {
        this._tabNav.innerHTML = '';
        this._tabContent.innerHTML = '';
        this.tabButtons = [];
        this.tabPanels = [];

        this.schema.forEach((section, idx) => {
            const tabBtn = document.createElement('button');
            tabBtn.textContent = section.name;
            tabBtn.style.cssText = `
                background: none; border: none; color: #999;
                text-align: left; padding: 10px 16px; font-size: 13px;
                cursor: pointer; border-left: 3px solid transparent;
                transition: all .15s; width: 100%;
            `;
            tabBtn.addEventListener('click', () => this.selectTab(idx));
            this._tabNav.appendChild(tabBtn);
            this.tabButtons.push(tabBtn);

            const panel = document.createElement('div');
            panel.style.display = 'none';
            this._tabContent.appendChild(panel);
            this.tabPanels.push(panel);
        });

        this.selectTab(0);
    }

    private selectTab(idx: number): void {
        this.activeTab = idx;
        this.tabButtons.forEach((b, i) => {
            b.style.color = i === idx ? '#fff' : '#999';
            b.style.borderLeftColor = i === idx ? '#4a90d9' : 'transparent';
            b.style.background = i === idx ? '#2a2a2a' : 'none';
        });
        this.tabPanels.forEach((p, i) => { p.style.display = i === idx ? 'block' : 'none'; });
        this.renderActiveTab();
    }

    private renderActiveTab(): void {
        if (!this.currentBrush || this.schema.length === 0) return;
        const section = this.schema[this.activeTab];
        const panel = this.tabPanels[this.activeTab];
        if (!section || !panel) return;
        this.renderer.render(
            panel,
            section,
            this.currentBrush as unknown as Record<string, unknown>,
            () => this.schedulePreviewBrushUpdate()
        );
    }

    /** Debounced: re-applies currentBrush to preview canvas after form edits. */
    private schedulePreviewBrushUpdate(): void {
        if (this.previewUpdateTimer !== undefined) {
            window.clearTimeout(this.previewUpdateTimer);
        }
        this.previewUpdateTimer = window.setTimeout(() => {
            this.previewUpdateTimer = undefined;
            if (!this.previewDrawingCanvas || !this.currentBrush) return;
            // Reset internal brush reference so setBrush doesn't skip due to same-object cache check
            (this.previewDrawingCanvas as any).brush = undefined;
            this.previewDrawingCanvas.setBrush(this.currentBrush);
        }, 150);
    }
}

// ---- UI helpers ----

function btn(text: string, bg: string, color: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = `
        background: ${bg}; color: ${color};
        border: 1px solid ${bg === '#3a3a3a' ? '#555' : bg};
        border-radius: 5px; padding: 8px 14px;
        font-size: 13px; cursor: pointer; white-space: nowrap;
    `;
    return b;
}

function previewSlider(
    labelText: string, min: number, max: number, step: number,
    initial: number, onChange: (v: number) => void
): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex; align-items:center; gap:6px;`;

    const lbl = document.createElement('span');
    lbl.textContent = labelText;
    lbl.style.cssText = `font-size:11px; color:#9a9a9a; width:44px; flex-shrink:0;`;

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(initial);
    range.style.cssText = `flex:1; accent-color:#4a90d9; cursor:pointer;`;

    const val = document.createElement('span');
    val.textContent = initial.toFixed(2);
    val.style.cssText = `font-size:11px; color:#7a9fc0; width:32px; text-align:right; flex-shrink:0;`;

    range.addEventListener('input', () => {
        const v = parseFloat(range.value);
        val.textContent = v.toFixed(2);
        onChange(v);
    });

    wrap.appendChild(lbl);
    wrap.appendChild(range);
    wrap.appendChild(val);
    return wrap;
}

function previewBtn(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = `
        background: #3a3a3a; color: #e0e0e0;
        border: 1px solid #555; border-radius: 4px;
        padding: 6px 12px; font-size: 12px; cursor: pointer;
    `;
    b.addEventListener('click', onClick);
    b.addEventListener('mouseenter', () => { b.style.opacity = '.8'; });
    b.addEventListener('mouseleave', () => { b.style.opacity = '1'; });
    return b;
}
