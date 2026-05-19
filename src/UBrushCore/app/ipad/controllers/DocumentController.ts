import { Canvas, CanvasFloodFillResult } from '../../../canvas/Canvas';
import { CanvasLayer, CanvasStack, CanvasStackDelegate, LayerBlendMode } from '../../../canvas/CanvasStack';
import { Color } from '../../../common/Color';
import { FixerGroup } from '../../../common/FixerGroup';
import { IBrush } from '../../../common/IBrush';
import { Rect } from '../../../common/Rect';
import { Size } from '../../../common/Size';
import { WGPUContext } from '../../../gpu/webgpu/WGPUContext';
import { HistoryController, HistoryLayerProvider } from './HistoryController';
import { AppTool } from '../types';

export interface DocumentControllerDelegate {
    documentDidChangeLayers(): void;
    documentDidChangeHistory(): void;
    documentDidChangeRender(): void;
    documentDidChangeTool(): void;
    documentDidChangeBrush(): void;
}

export interface TransientHistoryController {
    canUndo(): boolean;
    canRedo(): boolean;
    undo(): void;
    redo(): void;
    brushDidChange?(): void;
    brushDidCommit?(): void;
}

export class DocumentController implements CanvasStackDelegate, HistoryLayerProvider {
    public readonly canvasStack: CanvasStack;
    public readonly history: HistoryController;
    public delegate?: DocumentControllerDelegate;

    private currentColor = Color.black();
    private currentBrushSize = 0.1;
    private currentBrushOpacity = 1;
    private currentTool: AppTool = 'brush';
    private thumbnailCache = new Map<string, { age: number; dataUrl: string }>();
    private suppressLayerHistory = false;
    private transientHistory?: TransientHistoryController;

    constructor(private context: WGPUContext, size: Size) {
        this.canvasStack = new CanvasStack(context, size);
        this.canvasStack.delegate = this;
        this.history = new HistoryController(this);

        this.canvasStack.createLayer();
        this.canvasStack.color = this.currentColor.clone();
        this.canvasStack.brushSize = this.currentBrushSize;
        this.canvasStack.brushOpacity = this.currentBrushOpacity;
    }

    public get layers(): CanvasLayer[] {
        return this.canvasStack.layerArray;
    }

    public get selectedLayer(): CanvasLayer | undefined {
        return this.canvasStack.selectedLayer();
    }

    public get selectedCanvas(): Canvas | undefined {
        return this.canvasStack.selectedCanvas;
    }

    public get tool(): AppTool {
        return this.currentTool;
    }

    public get color(): Color {
        return this.currentColor.clone();
    }

    public get brushSize(): number {
        return this.currentBrushSize;
    }

    public get brushOpacity(): number {
        return this.currentBrushOpacity;
    }

    public get canUndo(): boolean {
        return this.transientHistory?.canUndo() ?? this.history.canUndo;
    }

    public get canRedo(): boolean {
        return this.transientHistory?.canRedo() ?? this.history.canRedo;
    }

    public setTransientHistory(controller?: TransientHistoryController): void {
        this.transientHistory = controller;
        this.delegate?.documentDidChangeHistory();
    }

    public undo(): void {
        if (this.transientHistory) {
            this.transientHistory.undo();
            this.delegate?.documentDidChangeHistory();
            return;
        }
        void this.history.undo();
    }

    public redo(): void {
        if (this.transientHistory) {
            this.transientHistory.redo();
            this.delegate?.documentDidChangeHistory();
            return;
        }
        void this.history.redo();
    }

    public async setBrush(brush?: IBrush): Promise<void> {
        this.canvasStack.setBrush(brush ? JSON.parse(JSON.stringify(brush)) : undefined);
    }

    public setBrushSize(size: number): void {
        this.currentBrushSize = size;
        this.canvasStack.brushSize = size;
        this.transientHistory?.brushDidChange?.();
        this.delegate?.documentDidChangeBrush();
    }

    public setBrushOpacity(opacity: number): void {
        this.currentBrushOpacity = opacity;
        this.canvasStack.brushOpacity = opacity;
        this.transientHistory?.brushDidChange?.();
        this.delegate?.documentDidChangeBrush();
    }

    public commitBrushControls(): void {
        this.transientHistory?.brushDidCommit?.();
        this.delegate?.documentDidChangeHistory();
    }

    public setColor(color: Color): void {
        this.currentColor = color.clone();
        this.canvasStack.color = color.clone();
    }

    public setTool(tool: AppTool): void {
        if (this.currentTool === tool) return;
        this.currentTool = tool;
        this.delegate?.documentDidChangeTool();
    }

    public addLayer(): void {
        const selectedBefore = this.selectedLayer?.id;
        const index = this.layers.length;
        const layer = this.canvasStack.createLayer();
        if (!this.suppressLayerHistory) {
            this.history.pushLayerAddDelete({
                kind: 'layer-add',
                layer,
                index,
                selectedLayerIdBefore: selectedBefore,
                selectedLayerIdAfter: layer.id
            });
        }
        this.delegate?.documentDidChangeLayers();
    }

    public deleteSelectedLayer(): void {
        const layer = this.selectedLayer;
        if (!layer || this.layers.length <= 1) return;
        const selectedBefore = layer.id;
        const removed = this.canvasStack.detachLayer(layer.id);
        if (!removed) return;
        if (!this.suppressLayerHistory) {
            this.history.pushLayerAddDelete({
                kind: 'layer-delete',
                layer: removed.layer,
                index: removed.index,
                selectedLayerIdBefore: selectedBefore,
                selectedLayerIdAfter: this.selectedLayer?.id
            });
        }
        this.delegate?.documentDidChangeLayers();
    }

    public duplicateSelectedLayer(): void {
        const source = this.selectedLayer;
        if (!source) return;
        const selectedBefore = source.id;
        const sourceIndex = this.layers.findIndex((candidate) => candidate.id === source.id);
        const layer = this.canvasStack.duplicateLayer(source.id);
        if (!layer) return;

        if (!this.suppressLayerHistory) {
            this.history.pushLayerAddDelete({
                kind: 'layer-add',
                layer,
                index: sourceIndex + 1,
                selectedLayerIdBefore: selectedBefore,
                selectedLayerIdAfter: layer.id
            });
        }
        this.delegate?.documentDidChangeLayers();
    }

    public selectLayer(layerId: string): void {
        this.canvasStack.selectLayer(layerId);
        this.delegate?.documentDidChangeLayers();
    }

    public renameLayer(layerId: string, name: string): void {
        const layer = this.canvasStack.layerForId(layerId);
        if (!layer) return;
        const before = layer.name;
        this.canvasStack.renameLayer(layerId, name);
        const after = this.canvasStack.layerForId(layerId)?.name;
        if (after !== undefined) this.pushLayerPropertyHistory(layerId, 'name', before, after);
        this.delegate?.documentDidChangeLayers();
    }

    public toggleLayerVisible(layerId: string): void {
        const layer = this.canvasStack.layerForId(layerId);
        if (!layer) return;
        const before = layer.visible;
        this.canvasStack.setLayerVisible(layerId, !layer.visible);
        this.pushLayerPropertyHistory(layerId, 'visible', before, !before);
        this.delegate?.documentDidChangeLayers();
    }

    public toggleLayerLocked(layerId: string): void {
        const layer = this.canvasStack.layerForId(layerId);
        if (!layer) return;
        const before = layer.locked;
        this.canvasStack.setLayerLocked(layerId, !layer.locked);
        this.pushLayerPropertyHistory(layerId, 'locked', before, !before);
        this.delegate?.documentDidChangeLayers();
    }

    public toggleLayerAlphaLock(layerId: string): void {
        const layer = this.canvasStack.layerForId(layerId);
        if (!layer) return;
        const before = layer.alphaLock;
        this.canvasStack.setLayerAlphaLock(layerId, !layer.alphaLock);
        this.pushLayerPropertyHistory(layerId, 'alphaLock', before, !before);
        this.delegate?.documentDidChangeLayers();
    }

    public setLayerOpacity(layerId: string, opacity: number, recordHistory: boolean = true): void {
        const before = this.canvasStack.layerForId(layerId)?.opacity;
        this.canvasStack.setLayerOpacity(layerId, opacity);
        const after = this.canvasStack.layerForId(layerId)?.opacity;
        if (recordHistory && before !== undefined && after !== undefined) {
            this.pushLayerPropertyHistory(layerId, 'opacity', before, after);
        }
        this.delegate?.documentDidChangeLayers();
    }

    public previewLayerOpacity(layerId: string, opacity: number): void {
        this.canvasStack.setLayerOpacity(layerId, opacity, false);
    }

    public commitLayerOpacity(layerId: string, before: number, after: number): void {
        this.pushLayerPropertyHistory(layerId, 'opacity', before, after);
        this.delegate?.documentDidChangeLayers();
    }

    public setLayerBlendMode(layerId: string, blendMode: LayerBlendMode): void {
        const before = this.canvasStack.layerForId(layerId)?.blendMode;
        this.canvasStack.setLayerBlendMode(layerId, blendMode);
        const after = this.canvasStack.layerForId(layerId)?.blendMode;
        if (before !== undefined && after !== undefined) {
            this.pushLayerPropertyHistory(layerId, 'blendMode', before, after);
        }
        this.delegate?.documentDidChangeLayers();
    }

    public drySelectedLayer(): void {
        const layer = this.selectedLayer;
        if (!layer) return;
        layer.canvas.dry();
        this.history.clearLayerLiquidState(layer.id);
        this.delegate?.documentDidChangeRender();
    }

    public pushCanvasHistory(canvas: Canvas, fixerGroup: FixerGroup): void {
        const layerId = this.canvasStack.layerIdForCanvas(canvas);
        if (!layerId) return;
        this.history.pushDrawing(layerId, fixerGroup);
        this.delegate?.documentDidChangeLayers();
    }

    public pushFloodFillResult(canvas: Canvas, result: CanvasFloodFillResult): void {
        const layerId = this.canvasStack.layerIdForCanvas(canvas);
        if (!layerId) return;

        if (result.fixerGroup) {
            this.history.pushDrawing(layerId, result.fixerGroup);
            this.delegate?.documentDidChangeLayers();
            return;
        }

        if (!result.historyPromise) return;

        result.historyPromise
            .then((history) => {
                if (history.fixerGroup) {
                    this.history.pushDrawing(layerId, history.fixerGroup);
                    this.delegate?.documentDidChangeLayers();
                }
            })
            .catch((error) => console.error('Flood fill history failed', error));
    }

    public async drawLayerThumbnail(layerId: string, target: HTMLCanvasElement): Promise<void> {
        const layer = this.canvasStack.layerForId(layerId);
        if (!layer) return;

        const cached = this.thumbnailCache.get(layerId);
        if (cached && cached.age === layer.canvas.age) {
            this.drawThumbnailDataUrl(target, cached.dataUrl);
            return;
        }

        const renderTarget = layer.canvas.outputRenderTarget;
        const sourceWidth = renderTarget.size.width;
        const sourceHeight = renderTarget.size.height;
        const pixels = await this.context.readPixels(renderTarget, new Rect(0, 0, sourceWidth, sourceHeight));
        const dataUrl = this.layerThumbnailDataUrl(pixels, sourceWidth, sourceHeight, target.width, target.height);

        const latest = this.canvasStack.layerForId(layerId);
        if (!latest || latest.canvas.age !== layer.canvas.age) return;

        this.thumbnailCache.set(layerId, { age: layer.canvas.age, dataUrl });
        this.drawThumbnailDataUrl(target, dataUrl);
    }

    public selectedLayerIsLocked(): boolean {
        return !!this.selectedLayer?.locked;
    }

    public layerCanvas(layerId: string): Canvas | undefined {
        return this.canvasStack.layerForId(layerId)?.canvas;
    }

    public layerExists(layerId: string): boolean {
        return !!this.canvasStack.layerForId(layerId);
    }

    public detachLayer(layerId: string): void {
        this.withoutLayerHistory(() => {
            this.canvasStack.detachLayer(layerId);
        });
    }

    public restoreLayer(layer: CanvasLayer, index: number, select: boolean): void {
        this.withoutLayerHistory(() => {
            this.canvasStack.restoreLayer(layer, index, select);
        });
    }

    public applyLayerProperty(layerId: string, property: 'name' | 'visible' | 'opacity' | 'blendMode' | 'locked' | 'alphaLock', value: string | number | boolean): void {
        this.withoutLayerHistory(() => {
            switch (property) {
                case 'name':
                    this.canvasStack.renameLayer(layerId, String(value));
                    return;
                case 'visible':
                    this.canvasStack.setLayerVisible(layerId, Boolean(value));
                    return;
                case 'opacity':
                    this.canvasStack.setLayerOpacity(layerId, Number(value));
                    return;
                case 'blendMode':
                    this.canvasStack.setLayerBlendMode(layerId, value as LayerBlendMode);
                    return;
                case 'locked':
                    this.canvasStack.setLayerLocked(layerId, Boolean(value));
                    return;
                case 'alphaLock':
                    this.canvasStack.setLayerAlphaLock(layerId, Boolean(value));
                    return;
            }
        });
    }

    public selectLayerIfExists(layerId?: string): void {
        if (!layerId || !this.canvasStack.layerForId(layerId)) return;
        this.canvasStack.selectLayer(layerId);
    }

    public onHistoryChanged(): void {
        this.delegate?.documentDidChangeHistory();
    }

    public onLayerChanged(_layerId: string): void {
        this.delegate?.documentDidChangeLayers();
        this.delegate?.documentDidChangeRender();
    }

    public changeRect(_canvasStack: CanvasStack, _rect: Rect): void {
        this.delegate?.documentDidChangeRender();
    }

    public didReleaseDrawing(canvasStack: CanvasStack, fixerGroup: FixerGroup, canvasIndex: number): void {
        const layer = canvasStack.layerArray[canvasIndex];
        if (!layer) return;
        this.history.pushDrawing(layer.id, fixerGroup);
        this.delegate?.documentDidChangeLayers();
    }

    public didDry(canvasStack: CanvasStack, canvasIndex: number): void {
        const layer = canvasStack.layerArray[canvasIndex];
        if (layer) this.history.clearLayerLiquidState(layer.id);
        this.delegate?.documentDidChangeRender();
    }

    public didChangeLayers(): void {
        this.delegate?.documentDidChangeLayers();
    }

    private pushLayerPropertyHistory(
        layerId: string,
        property: 'name' | 'visible' | 'opacity' | 'blendMode' | 'locked' | 'alphaLock',
        before: string | number | boolean,
        after: string | number | boolean
    ): void {
        if (this.suppressLayerHistory) return;
        this.history.pushLayerProperty(layerId, property, before, after);
    }

    private withoutLayerHistory(work: () => void): void {
        const previous = this.suppressLayerHistory;
        this.suppressLayerHistory = true;
        try {
            work();
        } finally {
            this.suppressLayerHistory = previous;
        }
    }

    private drawThumbnailDataUrl(target: HTMLCanvasElement, dataUrl: string): void {
        if (!dataUrl) return;
        const image = new Image();
        image.onload = () => {
            const ctx = target.getContext('2d');
            if (!ctx) return;
            ctx.clearRect(0, 0, target.width, target.height);
            ctx.drawImage(image, 0, 0, target.width, target.height);
        };
        image.src = dataUrl;
    }

    private layerThumbnailDataUrl(pixels: Uint8Array, sourceWidth: number, sourceHeight: number, thumbWidth: number, thumbHeight: number): string {
        const source = document.createElement('canvas');
        source.width = sourceWidth;
        source.height = sourceHeight;
        const sourceCtx = source.getContext('2d');
        if (!sourceCtx) return '';
        sourceCtx.putImageData(new ImageData(new Uint8ClampedArray(pixels), sourceWidth, sourceHeight), 0, 0);

        const preview = document.createElement('canvas');
        preview.width = thumbWidth;
        preview.height = thumbHeight;
        const previewCtx = preview.getContext('2d');
        if (!previewCtx) return '';

        previewCtx.clearRect(0, 0, preview.width, preview.height);
        const scale = Math.min(preview.width / sourceWidth, preview.height / sourceHeight);
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const x = Math.round((preview.width - width) * 0.5);
        const y = Math.round((preview.height - height) * 0.5);
        previewCtx.drawImage(source, x, y, width, height);

        return preview.toDataURL('image/png');
    }
}
