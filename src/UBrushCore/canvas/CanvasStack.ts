import { Size } from "../common/Size";
import { WGPURenderTarget } from "../gpu/webgpu/WGPURenderTarget";
import { WGPUContext } from "../gpu/webgpu/WGPUContext";
import { IBrush } from "../common/IBrush";
import { Canvas, CanvasDelegate } from "./Canvas";
import { Color } from "../common/Color";
import { Common } from "../common/Common";
import { Rect } from "../common/Rect";
import { FixerGroup } from "../common/FixerGroup";
import { WGPUProgramManager } from "../program/webgpu/WGPUProgramManager";
import { RenderObjectBlend } from "../gpu/RenderObject";
import { AffineTransform } from "../common/AffineTransform";

export type LayerBlendMode = 'normal' | 'add' | 'screen' | 'max';

export interface CanvasLayer {
    id: string;
    name: string;
    canvas: Canvas;
    visible: boolean;
    opacity: number;
    blendMode: LayerBlendMode;
    locked: boolean;
}

export interface CanvasStackDelegate {
    changeRect(canvasStack: CanvasStack, rect: Rect): void;
    didReleaseDrawing?(canvasStack: CanvasStack, fixerGroup: FixerGroup, canvasIndex: number): void;
    didDry?(canvasStack: CanvasStack, canvasIndex: number): void;
    willChangeCanvases?(canvasStack: CanvasStack, canvasArray: Canvas[]): void;
    didChangeCanvases?(canvasStack: CanvasStack, canvasArray: Canvas[]): void;
    didChangeLayers?(canvasStack: CanvasStack, layers: CanvasLayer[]): void;
}

export class CanvasStack implements CanvasDelegate {
    public delegate?: CanvasStackDelegate;
    public outputRenderTarget: WGPURenderTarget;
    public brush?: IBrush;
    public selectedCanvas?: Canvas;
    public updatelock: boolean = false;

    private size: Size;
    private context: WGPUContext;
    private layers: CanvasLayer[] = [];
    private backgroundColor: Color = Color.white();
    private nextLayerNumber = 1;

    private _brushSize: number = 1;
    private _brushOpacity: number = 1;
    private _color: Color = new Color();

    constructor(context: WGPUContext, size: Size) {
        this.outputRenderTarget = context.createRenderTarget(size);
        this.size = size;
        this.context = context;
    }

    public get layerArray(): CanvasLayer[] {
        return this.layers.concat();
    }

    public set brushSize(v: number) {
        this._brushSize = v;
        this.selectedCanvas?.lineDriver.setBrushSize(v);
    }

    public get brushSize(): number {
        return this._brushSize;
    }

    public set brushOpacity(v: number) {
        this._brushOpacity = v;
        this.selectedCanvas?.lineDriver.setBrushOpacity(v);
    }

    public get brushOpacity(): number {
        return this._brushOpacity;
    }

    public set color(v: Color) {
        this._color = v;
        this.selectedCanvas?.setColor(v.clone());
    }

    public get color(): Color {
        return this._color;
    }

    public setBrush(brush?: IBrush): void {
        this.brush = brush;
        void this.selectedCanvas?.setBrush(brush);
    }

    public createLayer(name?: string, index: number = this.layers.length): CanvasLayer {
        const canvas = new Canvas(this.context, this.size);
        canvas.clearOutputRenderTarget();
        const layer: CanvasLayer = {
            id: this.createLayerId(),
            name: name ?? `Layer ${this.nextLayerNumber++}`,
            canvas,
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: false
        };
        this.insertLayer(layer, index);
        this.selectLayer(layer.id);
        this.updateCanvas();
        return layer;
    }

    public removeLayer(id: string): CanvasLayer | null {
        if (this.layers.length <= 1) return null;
        const index = this.layers.findIndex((layer) => layer.id === id);
        if (index < 0) return null;

        const [removed] = this.layers.splice(index, 1);
        removed.canvas.delegate = undefined;
        this.context.deleteRenderTarget(removed.canvas.outputRenderTarget);

        const next = this.layers[Math.min(index, this.layers.length - 1)];
        if (next) this.selectLayer(next.id);
        this.notifyLayersChanged();
        this.updateCanvas();
        return removed;
    }

    public selectLayer(id: string): void {
        const layer = this.layers.find((candidate) => candidate.id === id);
        if (!layer) return;

        this.selectedCanvas = layer.canvas;
        for (const item of this.layers) {
            if (item.canvas === this.selectedCanvas) {
                void item.canvas.setBrush(this.brush);
                item.canvas.selected = true;
            } else {
                item.canvas.dry();
                void item.canvas.setBrush(undefined);
                item.canvas.selected = false;
            }
        }
        this.selectedCanvas.lineDriver.setBrushSize(this.brushSize);
        this.selectedCanvas.lineDriver.setBrushOpacity(this.brushOpacity);
        this.selectedCanvas.setColor(this.color.clone());
        this.notifyLayersChanged();
    }

    public selectedLayer(): CanvasLayer | undefined {
        return this.layers.find((layer) => layer.canvas === this.selectedCanvas);
    }

    public layerForCanvas(canvas: Canvas): CanvasLayer | undefined {
        return this.layers.find((layer) => layer.canvas === canvas);
    }

    public layerForId(id: string): CanvasLayer | undefined {
        return this.layers.find((layer) => layer.id === id);
    }

    public layerIdForCanvas(canvas: Canvas): string | undefined {
        return this.layerForCanvas(canvas)?.id;
    }

    public selectedCanvasIndex(): number {
        return this.selectedCanvas ? this.layers.findIndex((layer) => layer.canvas === this.selectedCanvas) : -1;
    }

    public setLayerVisible(id: string, visible: boolean): void {
        const layer = this.layerForId(id);
        if (!layer) return;
        layer.visible = visible;
        this.notifyLayersChanged();
        this.updateCanvas();
    }

    public setLayerOpacity(id: string, opacity: number): void {
        const layer = this.layerForId(id);
        if (!layer) return;
        layer.opacity = Math.max(0, Math.min(1, opacity));
        this.notifyLayersChanged();
        this.updateCanvas();
    }

    public setLayerBlendMode(id: string, blendMode: LayerBlendMode): void {
        const layer = this.layerForId(id);
        if (!layer) return;
        layer.blendMode = blendMode;
        this.notifyLayersChanged();
        this.updateCanvas();
    }

    public setLayerLocked(id: string, locked: boolean): void {
        const layer = this.layerForId(id);
        if (!layer) return;
        layer.locked = locked;
        this.notifyLayersChanged();
    }

    public renameLayer(id: string, name: string): void {
        const layer = this.layerForId(id);
        if (!layer) return;
        const trimmed = name.trim();
        layer.name = trimmed.length > 0 ? trimmed : layer.name;
        this.notifyLayersChanged();
    }

    public moveLayer(id: string, direction: -1 | 1): void {
        const fromIndex = this.layers.findIndex((layer) => layer.id === id);
        if (fromIndex < 0) return;
        const toIndex = fromIndex + direction;
        if (toIndex < 0 || toIndex >= this.layers.length) return;
        this.insertCanvasFromIndex(fromIndex, toIndex);
    }

    public setLayerOrder(layerIdsBottomToTop: string[]): void {
        if (layerIdsBottomToTop.length !== this.layers.length) return;
        const byId = new Map(this.layers.map((layer) => [layer.id, layer]));
        const nextLayers: CanvasLayer[] = [];
        for (const id of layerIdsBottomToTop) {
            const layer = byId.get(id);
            if (!layer) return;
            nextLayers.push(layer);
        }
        this.delegate?.willChangeCanvases?.(this, this.layers.map((layer) => layer.canvas));
        this.layers = nextLayers;
        this.delegate?.didChangeCanvases?.(this, this.layers.map((layer) => layer.canvas));
        this.notifyLayersChanged();
        this.updateCanvas();
    }

    public setBackgroundColor(backgroundColor: Color): void {
        this.backgroundColor = backgroundColor;
        this.updateCanvas();
    }

    public addCanvas(canvas: Canvas): void {
        this.insertCanvas(canvas, this.layers.length);
    }

    public insertCanvas(canvas: Canvas, index: number): void {
        const layer: CanvasLayer = {
            id: this.createLayerId(),
            name: `Layer ${this.nextLayerNumber++}`,
            canvas,
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: false
        };
        this.insertLayer(layer, index);
    }

    public removeCanvas(canvas: Canvas): void {
        const layer = this.layerForCanvas(canvas);
        if (layer) this.removeLayer(layer.id);
    }

    public insertCanvasFromIndex(fromIndex: number, toIndex: number): void {
        if (fromIndex < 0 || fromIndex >= this.layers.length || toIndex < 0 || toIndex >= this.layers.length) return;
        this.delegate?.willChangeCanvases?.(this, this.layers.map((layer) => layer.canvas));
        const [layer] = this.layers.splice(fromIndex, 1);
        this.layers.splice(toIndex, 0, layer);
        this.delegate?.didChangeCanvases?.(this, this.layers.map((item) => item.canvas));
        this.notifyLayersChanged();
        this.updateCanvas();
    }

    public updateCanvas(): void {
        this.updateCanvasInRect(Common.stageRect());
    }

    public updateCanvasInRect(rect: Rect): void {
        if (this.updatelock) return;

        this.context.clearRenderTarget(this.outputRenderTarget, this.backgroundColor);

        const layerComposite = WGPUProgramManager.getInstance().layerCompositeProgram;
        for (const layer of this.layers) {
            if (!layer.visible || layer.opacity <= 0) continue;
            layerComposite.fill(this.outputRenderTarget, {
                targetRect: Common.stageRect(),
                source: layer.canvas.outputRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: this.renderBlendForLayer(layer),
                opacity: layer.opacity
            });
        }

        this.delegate?.changeRect(this, rect);
    }

    public changeRect(canvas: Canvas, rect: Rect): void {
        const layer = this.layerForCanvas(canvas);
        if (!layer || !layer.visible) return;
        this.updateCanvasInRect(rect);
    }

    public didReleaseDrawingWithFixerGroup(canvas: Canvas, fixerGroup: FixerGroup): void {
        const index = this.layers.findIndex((layer) => layer.canvas === canvas);
        this.delegate?.didReleaseDrawing?.(this, fixerGroup, index);
    }

    public didDryCanvas(canvas: Canvas): void {
        const index = this.layers.findIndex((layer) => layer.canvas === canvas);
        this.delegate?.didDry?.(this, index);
        this.updateCanvas();
    }

    private insertLayer(layer: CanvasLayer, index: number): void {
        const safeIndex = Math.max(0, Math.min(index, this.layers.length));
        this.delegate?.willChangeCanvases?.(this, this.layers.map((item) => item.canvas));
        layer.canvas.useFixer = true;
        layer.canvas.delegate = this;
        this.layers.splice(safeIndex, 0, layer);
        this.delegate?.didChangeCanvases?.(this, this.layers.map((item) => item.canvas));
        this.notifyLayersChanged();
    }

    private createLayerId(): string {
        return `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    private renderBlendForLayer(layer: CanvasLayer): RenderObjectBlend {
        switch (layer.blendMode) {
            case 'add': return RenderObjectBlend.Add;
            case 'screen': return RenderObjectBlend.Screen;
            case 'max': return RenderObjectBlend.Max;
            case 'normal':
            default: return RenderObjectBlend.Normal;
        }
    }

    private notifyLayersChanged(): void {
        this.delegate?.didChangeLayers?.(this, this.layerArray);
    }
}
