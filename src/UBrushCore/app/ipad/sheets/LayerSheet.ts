import { CanvasLayer, LayerBlendMode } from '../../../canvas/CanvasStack';
import { DocumentController } from '../controllers/DocumentController';

const BLEND_MODES: LayerBlendMode[] = [
    'normal',
    'multiply',
    'screen',
    'add',
    'max',
    'overlay',
    'hard-light',
    'soft-light',
    'color-dodge',
    'color-burn',
    'difference'
];

export class LayerSheet {
    public readonly element = document.createElement('div');
    private list = document.createElement('div');
    private optionsPanel = document.createElement('div');
    private optionsLayerId?: string;
    private opacityHistoryStart = new Map<string, number>();

    constructor(private documentController: DocumentController) {
        this.element.className = 'ub-sheet ub-layer-sheet';
        this.element.hidden = true;
        this.build();
    }

    public show(): void {
        this.element.hidden = false;
        this.refresh();
    }

    public hide(): void {
        this.element.hidden = true;
        this.optionsLayerId = undefined;
    }

    public toggle(): void {
        this.element.hidden ? this.show() : this.hide();
    }

    public refresh(): void {
        this.list.replaceChildren();
        const selectedId = this.documentController.selectedLayer?.id;
        const layers = this.documentController.layers;

        for (let i = layers.length - 1; i >= 0; i--) {
            this.list.appendChild(this.layerRow(layers[i], layers[i].id === selectedId));
        }
        this.refreshOptionsPanel();
    }

    private build(): void {
        const header = document.createElement('div');
        header.className = 'ub-sheet-header ub-layer-header';

        const title = document.createElement('span');
        title.textContent = 'Layers';
        const add = document.createElement('button');
        add.className = 'ub-icon-button';
        add.textContent = '+';
        add.title = 'Add layer';
        add.addEventListener('click', () => {
            this.documentController.addLayer();
            this.refresh();
        });
        header.append(title, add);

        this.list.className = 'ub-layer-list';
        this.optionsPanel.className = 'ub-layer-options-panel';
        this.optionsPanel.hidden = true;
        this.element.append(header, this.list, this.optionsPanel);
    }

    private layerRow(layer: CanvasLayer, selected: boolean): HTMLElement {
        const row = document.createElement('div');
        row.className = `ub-layer-row${selected ? ' selected' : ''}`;
        row.addEventListener('click', () => {
            this.documentController.selectLayer(layer.id);
            this.refresh();
        });

        const thumb = document.createElement('canvas');
        thumb.className = 'ub-layer-thumb';
        thumb.width = 96;
        thumb.height = 76;
        this.drawEmptyThumbnail(thumb);
        void this.documentController.drawLayerThumbnail(layer.id, thumb);

        const meta = document.createElement('div');
        meta.className = 'ub-layer-meta';
        const name = document.createElement('div');
        name.className = 'ub-layer-name';
        name.textContent = layer.name;
        const sub = document.createElement('div');
        sub.className = 'ub-layer-sub';
        sub.textContent = `${layer.blendMode} ${Math.round(layer.opacity * 100)}%`;
        meta.append(name, sub);

        const actions = document.createElement('div');
        actions.className = 'ub-layer-actions';
        actions.append(
            this.action(layer.visible ? 'V' : '-', layer.visible ? 'Hide layer' : 'Show layer', () => this.documentController.toggleLayerVisible(layer.id)),
            this.action(layer.locked ? 'L' : '-', layer.locked ? 'Unlock layer' : 'Lock layer', () => this.documentController.toggleLayerLocked(layer.id)),
            this.action(layer.alphaLock ? 'A' : '-', layer.alphaLock ? 'Disable alpha lock' : 'Enable alpha lock', () => this.documentController.toggleLayerAlphaLock(layer.id)),
            this.action('...', 'Layer options', () => this.showOptions(layer.id))
        );

        row.append(thumb, meta, actions);
        return row;
    }

    private layerOptions(layer: CanvasLayer): HTMLElement {
        const options = document.createElement('div');
        options.className = 'ub-layer-options-content';

        const header = document.createElement('div');
        header.className = 'ub-layer-options-title';
        header.textContent = 'Layer Options';

        const name = document.createElement('input');
        name.className = 'ub-layer-name-input';
        name.value = layer.name;
        name.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') name.blur();
        });
        name.addEventListener('change', () => {
            this.documentController.renameLayer(layer.id, name.value);
            this.refresh();
        });

        const opacity = document.createElement('input');
        opacity.type = 'range';
        opacity.min = '0';
        opacity.max = '1';
        opacity.step = '0.01';
        opacity.value = String(layer.opacity);
        opacity.addEventListener('click', (e) => e.stopPropagation());
        opacity.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            this.beginOpacityHistory(layer.id);
        });
        opacity.addEventListener('focus', () => this.beginOpacityHistory(layer.id));
        opacity.addEventListener('input', () => this.documentController.setLayerOpacity(layer.id, Number(opacity.value), false));
        opacity.addEventListener('change', () => this.commitOpacityHistory(layer.id, Number(opacity.value)));

        const opacityRow = this.optionRow(`Opacity ${Math.round(layer.opacity * 100)}%`, opacity);

        const blend = document.createElement('select');
        blend.value = layer.blendMode;
        blend.addEventListener('click', (e) => e.stopPropagation());
        blend.addEventListener('change', () => this.documentController.setLayerBlendMode(layer.id, blend.value as LayerBlendMode));
        for (const mode of BLEND_MODES) {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode;
            blend.appendChild(option);
        }
        const blendRow = this.optionRow('Blend', blend);

        const toggles = document.createElement('div');
        toggles.className = 'ub-layer-toggle-grid';
        toggles.append(
            this.optionButton(layer.visible ? 'Visible' : 'Hidden', () => this.documentController.toggleLayerVisible(layer.id)),
            this.optionButton(layer.locked ? 'Locked' : 'Unlocked', () => this.documentController.toggleLayerLocked(layer.id)),
            this.optionButton(layer.alphaLock ? 'Alpha Lock On' : 'Alpha Lock Off', () => this.documentController.toggleLayerAlphaLock(layer.id))
        );

        const commands = document.createElement('div');
        commands.className = 'ub-layer-command-grid';
        commands.append(
            this.optionButton('Duplicate', () => this.documentController.duplicateSelectedLayer()),
            this.optionButton('Delete', () => this.documentController.deleteSelectedLayer(), 'danger')
        );

        options.append(header, name, opacityRow, blendRow, toggles, commands);
        return options;
    }

    private action(text: string, title: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'ub-icon-button compact';
        button.textContent = text;
        button.title = title;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
            this.refresh();
        });
        return button;
    }

    private showOptions(layerId: string): void {
        this.documentController.selectLayer(layerId);
        this.optionsLayerId = layerId;
        this.refresh();
    }

    private refreshOptionsPanel(): void {
        const layerId = this.optionsLayerId ?? this.documentController.selectedLayer?.id;
        let layer = this.documentController.layers.find((candidate) => candidate.id === layerId);
        if (!layer && this.documentController.selectedLayer) {
            layer = this.documentController.selectedLayer;
        }
        this.optionsPanel.replaceChildren();
        if (!layer) {
            this.optionsPanel.hidden = true;
            this.optionsLayerId = undefined;
            return;
        }

        this.optionsPanel.hidden = false;
        this.optionsPanel.appendChild(this.layerOptions(layer));
    }

    private optionRow(labelText: string, control: HTMLElement): HTMLElement {
        const row = document.createElement('label');
        row.className = 'ub-layer-option-row';
        const label = document.createElement('span');
        label.textContent = labelText;
        row.append(label, control);
        return row;
    }

    private optionButton(text: string, onClick: () => void, tone: 'normal' | 'danger' = 'normal'): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = `ub-layer-option-button${tone === 'danger' ? ' danger' : ''}`;
        button.textContent = text;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
            this.optionsLayerId = this.documentController.selectedLayer?.id;
            this.refresh();
        });
        return button;
    }

    private drawEmptyThumbnail(thumbnail: HTMLCanvasElement): void {
        const ctx = thumbnail.getContext('2d');
        if (!ctx) return;
        const cell = 12;
        for (let y = 0; y < thumbnail.height; y += cell) {
            for (let x = 0; x < thumbnail.width; x += cell) {
                ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#dedbd2' : '#bcb7ad';
                ctx.fillRect(x, y, cell, cell);
            }
        }
    }

    private beginOpacityHistory(layerId: string): void {
        if (this.opacityHistoryStart.has(layerId)) return;
        const layer = this.documentController.layers.find((candidate) => candidate.id === layerId);
        if (layer) this.opacityHistoryStart.set(layerId, layer.opacity);
    }

    private commitOpacityHistory(layerId: string, after: number): void {
        const before = this.opacityHistoryStart.get(layerId);
        this.opacityHistoryStart.delete(layerId);
        if (before === undefined) return;
        this.documentController.commitLayerOpacity(layerId, before, after);
        this.refresh();
    }
}
