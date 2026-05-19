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
    private undoButton = this.iconButton('Undo', 'Undo', () => void this.document?.history.undo());
    private redoButton = this.iconButton('Redo', 'Redo', () => void this.document?.history.redo());
    private layerSheet?: LayerSheet;
    private brushSheet: BrushLibrarySheet;
    private sizeValue = document.createElement('span');
    private opacityValue = document.createElement('span');
    private document?: DocumentController;

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
    }

    public documentDidChangeLayers(): void {
        this.layerSheet?.refresh();
    }

    public documentDidChangeHistory(): void {
        this.updateHistoryButtons();
    }

    public documentDidChangeRender(): void {}

    private build(): void {
        this.topBar.className = 'ub-topbar';
        this.topBar.append(
            this.textButton('Gallery', () => {}),
            this.undoButton,
            this.redoButton,
            this.segmentButton('Brush', () => this.brushSheet.toggle()),
            this.segmentButton('Smudge', () => {}),
            this.segmentButton('Erase', () => {}),
            this.colorButton(),
            this.iconButton('Layers', 'Layers', () => this.layerSheet?.toggle()),
            this.iconButton('More', 'More', () => this.document?.drySelectedLayer())
        );

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
        wrap.append(
            this.slider('Size', 0, 0.5, 0.001, 0.1, this.sizeValue, (value) => this.document?.setBrushSize(value)),
            this.slider('Opacity', 0, 1, 0.01, 1, this.opacityValue, (value) => this.document?.setBrushOpacity(value))
        );
        return wrap;
    }

    private slider(labelText: string, min: number, max: number, step: number, value: number, valueEl: HTMLElement, onInput: (value: number) => void): HTMLElement {
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

        wrap.append(label, input, valueEl);
        return wrap;
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
        this.undoButton.disabled = !this.document?.history.canUndo;
        this.redoButton.disabled = !this.document?.history.canRedo;
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
.ub-topbar { position:absolute; z-index:20; top:calc(env(safe-area-inset-top, 0px) + 10px); left:14px; right:14px; height:48px; display:flex; align-items:center; gap:8px; padding:7px; border:1px solid rgba(255,255,255,.13); border-radius:24px; background:rgba(31,32,30,.78); backdrop-filter:blur(22px); box-shadow:0 12px 34px rgba(0,0,0,.24); }
.ub-stage-host, .ub-ipad-stage, .ub-ipad-canvas { width:100%; height:100%; }
.ub-ipad-canvas { display:block; cursor:crosshair; }
.ub-text-button, .ub-segment-button, .ub-icon-button { height:34px; border:0; color:#f6f2ea; background:rgba(255,255,255,.1); border-radius:17px; padding:0 12px; font:600 13px -apple-system, BlinkMacSystemFont, sans-serif; cursor:pointer; }
.ub-icon-button { min-width:34px; padding:0 10px; }
.ub-icon-button.compact { height:28px; min-width:28px; padding:0 7px; font-size:11px; }
.ub-text-button { background:transparent; color:#d9d1c2; }
.ub-segment-button:active, .ub-icon-button:active { background:rgba(255,255,255,.22); }
.ub-icon-button:disabled { opacity:.35; cursor:default; }
.ub-color-chip { --chip-color:#000; width:34px; height:34px; border:2px solid rgba(255,255,255,.72); border-radius:50%; background:var(--chip-color); overflow:hidden; cursor:pointer; }
.ub-color-chip input { opacity:0; width:100%; height:100%; }
.ub-floating-controls { position:absolute; z-index:15; left:18px; top:110px; bottom:34px; display:flex; flex-direction:column; justify-content:space-between; pointer-events:none; }
.ub-floating-slider { width:48px; min-height:210px; display:flex; flex-direction:column; align-items:center; gap:9px; padding:13px 8px; border:1px solid rgba(255,255,255,.12); border-radius:24px; background:rgba(31,32,30,.58); backdrop-filter:blur(18px); color:#efe7da; pointer-events:auto; }
.ub-floating-slider span { font-size:11px; font-weight:700; }
.ub-floating-slider input { width:174px; transform:rotate(-90deg); margin:66px 0; accent-color:#f0c96a; }
.ub-sheet-host { position:absolute; z-index:30; inset:0; pointer-events:none; }
.ub-sheet { position:absolute; pointer-events:auto; top:72px; right:18px; width:min(380px, calc(100vw - 36px)); max-height:calc(100vh - 94px); overflow:hidden; border:1px solid rgba(255,255,255,.13); border-radius:22px; background:rgba(38,39,36,.9); backdrop-filter:blur(24px); box-shadow:0 20px 60px rgba(0,0,0,.32); }
.ub-sheet[hidden] { display:none; }
.ub-sheet-header { height:52px; display:flex; align-items:center; justify-content:space-between; padding:0 16px; border-bottom:1px solid rgba(255,255,255,.1); font-weight:800; }
.ub-brush-body { display:grid; grid-template-columns:136px 1fr; height:min(560px, calc(100vh - 146px)); }
.ub-brush-categories, .ub-brush-list, .ub-layer-list { overflow:auto; padding:10px; }
.ub-brush-categories { border-right:1px solid rgba(255,255,255,.1); }
.ub-list-button, .ub-brush-button { width:100%; min-height:38px; margin-bottom:6px; border:0; border-radius:10px; background:rgba(255,255,255,.08); color:#efe9de; text-align:left; padding:0 11px; font-weight:650; }
.ub-brush-button { min-height:42px; }
.ub-layer-list { max-height:calc(100vh - 146px); }
.ub-layer-row { display:grid; grid-template-columns:48px 1fr auto; gap:10px; align-items:center; padding:10px; margin-bottom:8px; border:1px solid rgba(255,255,255,.08); border-radius:14px; background:rgba(255,255,255,.06); cursor:pointer; }
.ub-layer-row.selected { border-color:#f0c96a; background:rgba(240,201,106,.16); }
.ub-layer-thumb { width:48px; height:38px; border-radius:8px; background:#d7d2c7; border:1px solid rgba(0,0,0,.28); }
.ub-layer-meta { min-width:0; }
.ub-layer-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:760; }
.ub-layer-sub { margin-top:3px; color:#c7bdac; font-size:12px; }
.ub-layer-actions { display:flex; gap:6px; }
.ub-layer-options { grid-column:1 / -1; display:grid; grid-template-columns:1fr 120px auto; gap:8px; align-items:center; }
.ub-layer-options input { accent-color:#f0c96a; }
.ub-layer-options select { min-width:0; height:30px; border:0; border-radius:8px; background:rgba(255,255,255,.12); color:#f7f2e9; padding:0 8px; }
.ub-small-danger { height:30px; border:0; border-radius:8px; background:#733832; color:#fff3ed; padding:0 10px; font-weight:700; }
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
