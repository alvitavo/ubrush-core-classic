import { Canvas } from '../../../canvas/Canvas';
import { CanvasLayer, CanvasStack, CanvasStackDelegate, LayerBlendMode } from '../../../canvas/CanvasStack';
import { Color } from '../../../common/Color';
import { FixerGroup } from '../../../common/FixerGroup';
import { IBrush } from '../../../common/IBrush';
import { Rect } from '../../../common/Rect';
import { Size } from '../../../common/Size';
import { WGPUContext } from '../../../gpu/webgpu/WGPUContext';
import { HistoryController, HistoryLayerProvider } from './HistoryController';

export interface DocumentControllerDelegate {
    documentDidChangeLayers(): void;
    documentDidChangeHistory(): void;
    documentDidChangeRender(): void;
}

export class DocumentController implements CanvasStackDelegate, HistoryLayerProvider {
    public readonly canvasStack: CanvasStack;
    public readonly history: HistoryController;
    public delegate?: DocumentControllerDelegate;

    private currentColor = Color.black();
    private currentBrushSize = 0.1;
    private currentBrushOpacity = 1;
    private thumbnailCache = new Map<string, { age: number; dataUrl: string }>();

    constructor(private context: WGPUContext, size: Size) {
        this.canvasStack = new CanvasStack(context, size);
        this.canvasStack.delegate = this;
        this.history = new HistoryController(this);

        this.canvasStack.createLayer('Layer 1');
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

    public async setBrush(brush?: IBrush): Promise<void> {
        this.canvasStack.setBrush(brush ? JSON.parse(JSON.stringify(brush)) : undefined);
    }

    public setBrushSize(size: number): void {
        this.currentBrushSize = size;
        this.canvasStack.brushSize = size;
    }

    public setBrushOpacity(opacity: number): void {
        this.currentBrushOpacity = opacity;
        this.canvasStack.brushOpacity = opacity;
    }

    public setColor(color: Color): void {
        this.currentColor = color.clone();
        this.canvasStack.color = color.clone();
    }

    public addLayer(): void {
        this.canvasStack.createLayer();
        this.delegate?.documentDidChangeLayers();
    }

    public deleteSelectedLayer(): void {
        const layer = this.selectedLayer;
        if (!layer || this.layers.length <= 1) return;
        this.canvasStack.removeLayer(layer.id);
        this.delegate?.documentDidChangeLayers();
    }

    public selectLayer(layerId: string): void {
        this.canvasStack.selectLayer(layerId);
        this.delegate?.documentDidChangeLayers();
    }

    public toggleLayerVisible(layerId: string): void {
        const layer = this.canvasStack.layerForId(layerId);
        if (!layer) return;
        this.canvasStack.setLayerVisible(layerId, !layer.visible);
        this.delegate?.documentDidChangeLayers();
    }

    public toggleLayerLocked(layerId: string): void {
        const layer = this.canvasStack.layerForId(layerId);
        if (!layer) return;
        this.canvasStack.setLayerLocked(layerId, !layer.locked);
        this.delegate?.documentDidChangeLayers();
    }

    public setLayerOpacity(layerId: string, opacity: number): void {
        this.canvasStack.setLayerOpacity(layerId, opacity);
        this.delegate?.documentDidChangeLayers();
    }

    public setLayerBlendMode(layerId: string, blendMode: LayerBlendMode): void {
        this.canvasStack.setLayerBlendMode(layerId, blendMode);
        this.delegate?.documentDidChangeLayers();
    }

    public drySelectedLayer(): void {
        const layer = this.selectedLayer;
        if (!layer) return;
        layer.canvas.dry();
        this.history.clearLayerLiquidState(layer.id);
        this.delegate?.documentDidChangeRender();
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
