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
        this.element.append(header, this.list);
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
            this.action(layer.visible ? 'E' : 'H', layer.visible ? 'Hide layer' : 'Show layer', () => this.documentController.toggleLayerVisible(layer.id)),
            this.action(layer.locked ? 'L' : 'U', layer.locked ? 'Unlock layer' : 'Lock layer', () => this.documentController.toggleLayerLocked(layer.id))
        );

        row.append(thumb, meta, actions);
        row.appendChild(this.layerOptions(layer));
        return row;
    }

    private layerOptions(layer: CanvasLayer): HTMLElement {
        const options = document.createElement('div');
        options.className = 'ub-layer-options';

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

        const deleteButton = document.createElement('button');
        deleteButton.className = 'ub-small-danger';
        deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.documentController.selectLayer(layer.id);
            this.documentController.deleteSelectedLayer();
            this.refresh();
        });

        options.append(opacity, blend, deleteButton);
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
