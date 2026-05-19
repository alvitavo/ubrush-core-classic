import { Color } from '../../common/Color';
import { IBrush } from '../../common/IBrush';
import { DocumentController, DocumentControllerDelegate } from './controllers/DocumentController';
import { BrushLibrarySheet } from './sheets/BrushLibrarySheet';
import { LayerSheet } from './sheets/LayerSheet';
import { BrushCategory } from './types';

export interface IpadAppShellDelegate {
    loadBrushes(category: BrushCategory): Promise<IBrush[]>;
    selectBrush(brush: IBrush, category: BrushCategory): void;
}

export class IpadAppShell implements DocumentControllerDelegate {
    public readonly element = document.createElement('div');
    private topBar = document.createElement('div');
    private sheetHost = document.createElement('div');
    private undoButton = this.iconButton('Undo', 'Undo', () => this.document?.undo());
    private redoButton = this.iconButton('Redo', 'Redo', () => this.document?.redo());
    private brushButton = this.segmentButton('Brush', () => this.setTool('brush'));
    private fillButton = this.segmentButton('Fill', () => this.setTool('fill'));
    private layerSheet?: LayerSheet;
    private brushSheet: BrushLibrarySheet;
    private sizeValue = document.createElement('span');
    private opacityValue = document.createElement('span');
    private sizeInput?: HTMLInputElement;
    private opacityInput?: HTMLInputElement;
    private document?: DocumentController;
    private toastTimer: number | null = null;

    constructor(
        categories: BrushCategory[],
        private delegate: IpadAppShellDelegate
    ) {
        this.element.className = 'ub-ipad-app';
        this.brushSheet = new BrushLibrarySheet(categories, {
            loadBrushes: (category) => this.delegate.loadBrushes(category),
            selectBrush: (brush, category) => this.delegate.selectBrush(brush, category)
        });
        this.injectStyles();
        this.build();
    }

    public attachStage(stageElement: HTMLElement): void {
        this.element.querySelector('.ub-stage-host')?.appendChild(stageElement);
    }

    public bindDocument(document: DocumentController): void {
        this.document = document;
        document.delegate = this;
        this.layerSheet = new LayerSheet(document);
        this.sheetHost.appendChild(this.layerSheet.element);
        this.updateHistoryButtons();
        this.updateBrushControls();
    }

    public showToast(message: string): void {
        let toast = this.element.querySelector<HTMLElement>('.ub-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'ub-toast';
            this.element.appendChild(toast);
        }

        toast.textContent = message;
        toast.classList.add('visible');
        if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => {
            toast?.classList.remove('visible');
            this.toastTimer = null;
        }, 2400);
    }

    public documentDidChangeLayers(): void {
        this.layerSheet?.refresh();
    }

    public documentDidChangeHistory(): void {
        this.updateHistoryButtons();
    }

    public documentDidChangeRender(): void {}

    public documentDidChangeTool(): void {
        this.updateToolButtons();
    }

    public documentDidChangeBrush(): void {
        this.updateBrushControls();
    }

    private build(): void {
        this.topBar.className = 'ub-topbar';
        this.topBar.append(
            this.textButton('Gallery', () => {}),
            this.undoButton,
            this.redoButton,
            this.brushButton,
            this.fillButton,
            this.segmentButton('Library', () => this.brushSheet.toggle()),
            this.segmentButton('Smudge', () => {}),
            this.segmentButton('Erase', () => {}),
            this.colorButton(),
            this.iconButton('Layers', 'Layers', () => this.layerSheet?.toggle()),
            this.iconButton('More', 'More', () => this.document?.drySelectedLayer())
        );
        this.updateToolButtons();

        const stageHost = document.createElement('div');
        stageHost.className = 'ub-stage-host';

        const controls = this.floatingControls();
        this.sheetHost.className = 'ub-sheet-host';
        this.sheetHost.appendChild(this.brushSheet.element);

        this.element.append(this.topBar, stageHost, controls, this.sheetHost);
    }

    private floatingControls(): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'ub-floating-controls';
        const sizeControl = this.slider('Size', 0, 0.5, 0.001, 0.1, this.sizeValue, (value) => this.document?.setBrushSize(value));
        const opacityControl = this.slider('Opacity', 0, 1, 0.01, 1, this.opacityValue, (value) => this.document?.setBrushOpacity(value));
        this.sizeInput = sizeControl.input;
        this.opacityInput = opacityControl.input;
        wrap.append(
            sizeControl.wrap,
            opacityControl.wrap
        );
        return wrap;
    }

    private slider(labelText: string, min: number, max: number, step: number, value: number, valueEl: HTMLElement, onInput: (value: number) => void): { wrap: HTMLElement; input: HTMLInputElement } {
        const wrap = document.createElement('label');
        wrap.className = 'ub-floating-slider';
        const label = document.createElement('span');
        label.textContent = labelText;
        valueEl.textContent = labelText === 'Opacity' ? '100%' : value.toFixed(2);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(value);
        input.addEventListener('input', () => {
            const next = Number(input.value);
            valueEl.textContent = labelText === 'Opacity' ? `${Math.round(next * 100)}%` : next.toFixed(2);
            onInput(next);
        });
        input.addEventListener('change', () => this.document?.commitBrushControls());

        wrap.append(label, input, valueEl);
        return { wrap, input };
    }

    private colorButton(): HTMLLabelElement {
        const label = document.createElement('label');
        label.className = 'ub-color-chip';
        label.title = 'Color';
        const input = document.createElement('input');
        input.type = 'color';
        input.value = '#000000';
        input.addEventListener('input', () => {
            const color = input.value;
            label.style.setProperty('--chip-color', color);
            this.document?.setColor(this.hexToColor(color));
        });
        label.appendChild(input);
        return label;
    }

    private hexToColor(hex: string): Color {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return new Color(r, g, b, 1);
    }

    private updateHistoryButtons(): void {
        this.undoButton.disabled = !this.document?.canUndo;
        this.redoButton.disabled = !this.document?.canRedo;
    }

    private updateBrushControls(): void {
        if (!this.document) return;
        const size = this.document.brushSize;
        const opacity = this.document.brushOpacity;
        if (this.sizeInput) this.sizeInput.value = String(size);
        if (this.opacityInput) this.opacityInput.value = String(opacity);
        this.sizeValue.textContent = size.toFixed(2);
        this.opacityValue.textContent = `${Math.round(opacity * 100)}%`;
    }

    private setTool(tool: 'brush' | 'fill'): void {
        this.document?.setTool(tool);
        this.updateToolButtons();
    }

    private updateToolButtons(): void {
        this.brushButton.classList.toggle('active', this.document?.tool !== 'fill');
        this.fillButton.classList.toggle('active', this.document?.tool === 'fill');
    }

    private textButton(text: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'ub-text-button';
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
    }

    private segmentButton(text: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'ub-segment-button';
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
    }

    private iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'ub-icon-button';
        button.textContent = text;
        button.title = title;
        button.addEventListener('click', onClick);
        return button;
    }

    private injectStyles(): void {
        if (document.getElementById('ub-ipad-styles')) return;
        const style = document.createElement('style');
        style.id = 'ub-ipad-styles';
        style.textContent = `
.ub-ipad-app { position:relative; width:100%; height:100%; overflow:hidden; background:#20211f; color:#f4f0e8; }
.ub-ipad-app button, .ub-ipad-app input, .ub-ipad-app select, .ub-ipad-app label, .ub-ipad-app a { touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
.ub-topbar { position:absolute; z-index:20; top:calc(env(safe-area-inset-top, 0px) + 10px); left:14px; right:14px; height:48px; display:flex; align-items:center; gap:8px; padding:7px; border:1px solid rgba(255,255,255,.13); border-radius:24px; background:rgba(31,32,30,.78); backdrop-filter:blur(22px); box-shadow:0 12px 34px rgba(0,0,0,.24); }
.ub-stage-host, .ub-ipad-stage, .ub-ipad-canvas { width:100%; height:100%; }
.ub-ipad-stage { position:relative; overflow:hidden; }
.ub-ipad-canvas { display:block; cursor:crosshair; touch-action:none; }
.ub-fit-view-button { position:absolute; z-index:18; right:calc(env(safe-area-inset-right, 0px) + 18px); bottom:calc(env(safe-area-inset-bottom, 0px) + 18px); height:42px; min-width:58px; border:1px solid rgba(255,255,255,.16); border-radius:21px; background:rgba(31,32,30,.78); color:#f6f0e7; box-shadow:0 12px 34px rgba(0,0,0,.24); backdrop-filter:blur(20px); font:750 13px -apple-system, BlinkMacSystemFont, sans-serif; cursor:pointer; opacity:0; transform:translateY(10px) scale(.96); transition:opacity .16s ease, transform .16s ease, background .16s ease; pointer-events:none; }
.ub-fit-view-button.visible { opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }
.ub-fit-view-button:active { background:rgba(255,255,255,.18); }
.ub-text-button, .ub-segment-button, .ub-icon-button { height:34px; border:0; color:#f6f2ea; background:rgba(255,255,255,.1); border-radius:17px; padding:0 12px; font:600 13px -apple-system, BlinkMacSystemFont, sans-serif; cursor:pointer; }
.ub-icon-button { min-width:34px; padding:0 10px; }
.ub-icon-button.compact { height:28px; min-width:28px; padding:0 7px; font-size:11px; }
.ub-text-button { background:transparent; color:#d9d1c2; }
.ub-segment-button:active, .ub-icon-button:active { background:rgba(255,255,255,.22); }
.ub-segment-button.active { background:#f0c96a; color:#1f201e; }
.ub-icon-button:disabled { opacity:.35; cursor:default; }
.ub-color-chip { --chip-color:#000; width:34px; height:34px; border:2px solid rgba(255,255,255,.72); border-radius:50%; background:var(--chip-color); overflow:hidden; cursor:pointer; }
.ub-color-chip input { opacity:0; width:100%; height:100%; }
.ub-floating-controls { position:absolute; z-index:15; left:18px; top:110px; bottom:34px; display:flex; flex-direction:column; justify-content:space-between; pointer-events:none; }
.ub-floating-slider { width:48px; min-height:210px; display:flex; flex-direction:column; align-items:center; gap:9px; padding:13px 8px; border:1px solid rgba(255,255,255,.12); border-radius:24px; background:rgba(31,32,30,.58); backdrop-filter:blur(18px); color:#efe7da; pointer-events:auto; }
.ub-floating-slider span { font-size:11px; font-weight:700; }
.ub-floating-slider input { width:174px; transform:rotate(-90deg); margin:66px 0; accent-color:#f0c96a; }
.ub-sheet-host { position:absolute; z-index:30; inset:0; pointer-events:none; }
.ub-toast { position:absolute; z-index:42; left:50%; bottom:calc(env(safe-area-inset-bottom, 0px) + 22px); transform:translate(-50%, 10px); max-width:calc(100vw - 40px); padding:10px 14px; border-radius:18px; background:rgba(31,32,30,.86); color:#f6f0e7; font:700 13px -apple-system, BlinkMacSystemFont, sans-serif; box-shadow:0 14px 38px rgba(0,0,0,.28); opacity:0; pointer-events:none; transition:opacity .18s ease, transform .18s ease; }
.ub-toast.visible { opacity:1; transform:translate(-50%, 0); }
.ub-sheet { position:absolute; pointer-events:auto; top:72px; right:18px; width:min(380px, calc(100vw - 36px)); max-height:calc(100vh - 94px); overflow:hidden; border:1px solid rgba(255,255,255,.13); border-radius:22px; background:rgba(38,39,36,.9); backdrop-filter:blur(24px); box-shadow:0 20px 60px rgba(0,0,0,.32); }
.ub-layer-sheet { display:flex; flex-direction:column; }
.ub-sheet[hidden] { display:none; }
.ub-sheet-header { height:52px; display:flex; align-items:center; justify-content:space-between; padding:0 16px; border-bottom:1px solid rgba(255,255,255,.1); font-weight:800; }
.ub-brush-body { display:grid; grid-template-columns:136px 1fr; height:min(560px, calc(100vh - 146px)); }
.ub-brush-categories, .ub-brush-list, .ub-layer-list { overflow:auto; padding:10px; }
.ub-brush-categories { border-right:1px solid rgba(255,255,255,.1); }
.ub-list-button, .ub-brush-button { width:100%; min-height:38px; margin-bottom:6px; border:0; border-radius:10px; background:rgba(255,255,255,.08); color:#efe9de; text-align:left; padding:0 11px; font-weight:650; }
.ub-brush-button { min-height:42px; }
.ub-layer-list { max-height:min(440px, calc(100vh - 360px)); }
.ub-layer-row { display:grid; grid-template-columns:48px 1fr auto; gap:10px; align-items:center; padding:10px; margin-bottom:8px; border:1px solid rgba(255,255,255,.08); border-radius:14px; background:rgba(255,255,255,.06); cursor:pointer; }
.ub-layer-row.selected { border-color:#f0c96a; background:rgba(240,201,106,.16); }
.ub-layer-thumb { width:48px; height:38px; border-radius:8px; background:#d7d2c7; border:1px solid rgba(0,0,0,.28); }
.ub-layer-meta { min-width:0; }
.ub-layer-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:760; }
.ub-layer-sub { margin-top:3px; color:#c7bdac; font-size:12px; }
.ub-layer-actions { display:flex; gap:5px; }
.ub-layer-options-panel { padding:12px; border-top:1px solid rgba(255,255,255,.1); background:rgba(0,0,0,.13); }
.ub-layer-options-panel[hidden] { display:none; }
.ub-layer-options-content { display:grid; gap:10px; }
.ub-layer-options-title { color:#e8dfcf; font-size:12px; font-weight:800; text-transform:uppercase; }
.ub-layer-name-input { width:100%; height:36px; border:0; border-radius:10px; background:rgba(255,255,255,.12); color:#fff7ec; padding:0 11px; font-weight:700; }
.ub-layer-option-row { display:grid; grid-template-columns:92px 1fr; align-items:center; gap:10px; color:#cfc5b5; font-size:12px; font-weight:700; }
.ub-layer-option-row input { accent-color:#f0c96a; }
.ub-layer-option-row select { min-width:0; height:34px; border:0; border-radius:10px; background:rgba(255,255,255,.12); color:#f7f2e9; padding:0 9px; }
.ub-layer-toggle-grid, .ub-layer-command-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
.ub-layer-command-grid { grid-template-columns:1fr 1fr; }
.ub-layer-option-button { min-height:34px; border:0; border-radius:10px; background:rgba(255,255,255,.1); color:#f6f0e7; padding:0 8px; font-weight:750; }
.ub-layer-option-button.danger { background:#733832; color:#fff3ed; }
.ub-shape-assist-ribbon { position:absolute; z-index:25; left:50%; top:calc(env(safe-area-inset-top, 0px) + 68px); transform:translateX(-50%); display:flex; align-items:center; gap:6px; max-width:calc(100vw - 28px); overflow-x:auto; padding:6px; border:1px solid rgba(255,255,255,.14); border-radius:18px; background:rgba(31,32,30,.82); backdrop-filter:blur(20px); box-shadow:0 12px 34px rgba(0,0,0,.24); pointer-events:auto; }
.ub-shape-assist-ribbon button { flex:0 0 auto; height:32px; border:0; border-radius:16px; background:rgba(255,255,255,.1); color:#f6f0e7; padding:0 12px; font-weight:750; }
.ub-shape-assist-ribbon button.active { background:#f0c96a; color:#1f201e; }
.ub-shape-assist-ribbon button.done { background:rgba(255,255,255,.2); }
.ub-shape-assist-handles { position:absolute; z-index:24; inset:0; pointer-events:none; }
.ub-shape-assist-handle { position:absolute; width:18px; height:18px; margin-left:-9px; margin-top:-9px; border-radius:50%; background:#4a90d9; border:2px solid #fff; box-shadow:0 2px 10px rgba(0,0,0,.32); pointer-events:auto; touch-action:none; cursor:grab; }
.ub-shape-assist-handle.control { background:#f1b84a; }
.ub-shape-assist-handle.anchor { background:#5ad18d; }
.ub-shape-assist-handle.center { width:20px; height:20px; margin-left:-10px; margin-top:-10px; background:#f05a7e; }
.ub-flood-fill-ribbon { position:absolute; z-index:25; left:50%; top:calc(env(safe-area-inset-top, 0px) + 68px); transform:translateX(-50%); display:flex; align-items:center; gap:10px; max-width:calc(100vw - 28px); overflow-x:auto; padding:8px; border:1px solid rgba(255,255,255,.14); border-radius:18px; background:rgba(31,32,30,.84); backdrop-filter:blur(20px); box-shadow:0 12px 34px rgba(0,0,0,.24); pointer-events:auto; }
.ub-flood-fill-slider { display:flex; align-items:center; gap:7px; color:#f6f0e7; font-size:12px; font-weight:750; white-space:nowrap; }
.ub-flood-fill-slider input { width:132px; accent-color:#f0c96a; }
.ub-flood-fill-slider b { min-width:28px; color:#f0c96a; font-size:12px; }
.ub-flood-fill-ribbon button { flex:0 0 auto; height:32px; border:0; border-radius:16px; background:rgba(255,255,255,.18); color:#f6f0e7; padding:0 12px; font-weight:750; }
@media (max-width: 720px) {
  .ub-topbar { left:8px; right:8px; gap:5px; overflow-x:auto; }
  .ub-text-button, .ub-segment-button, .ub-icon-button { flex:0 0 auto; }
  .ub-floating-controls { left:10px; top:92px; bottom:20px; }
  .ub-floating-slider { width:42px; min-height:180px; }
  .ub-floating-slider input { width:142px; margin:50px 0; }
}
`;
        document.head.appendChild(style);
    }
}
