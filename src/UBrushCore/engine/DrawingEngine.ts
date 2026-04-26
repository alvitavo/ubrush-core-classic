import { Dot } from "../common/Dot";
import { Rect } from "../common/Rect";
import { RenderTarget } from "../gpu/RenderTarget";
import { Point } from "../common/Point";
import { Size } from "../common/Size";
import { Common } from "../common/Common";
import { UBrushContext } from "../gpu/UBrushContext";
import { Texture } from "../gpu/Texture";
import { ProgramManager } from "../program/ProgramManager";
import { RenderObjectBlend } from "../gpu/RenderObject";
import { AffineTransform } from "../common/AffineTransform";
import { Fixer, FixerRenderTarget } from "../common/Fixer";
import { LayerBlendmode, DotBlendmode, EdgeStyle } from "../common/IBrush";
import { Color } from "../common/Color";

const maxSmudgingLength = 1000;

export type DrawingTargetType = 'plain' | 'effect' | 'mask';

export class DrawingEngine {

    protected context: UBrushContext;

    protected tipTexture: Texture;
    protected patternTexture: Texture;
    protected dualTipTexture: Texture;

    protected smudging0Dot?: Dot;
    protected smudgingDot?: Dot;

    protected _useSmudging: boolean = false;
    protected _layerLowCut: number = 0;
    protected _layerHighCut: number = 1;
    protected liquidCutMin: number = 0.0;
    protected liquidCutMax: number = 1.0;

    public readonly size: Size;

    // ---- independent flags (Swift parity) ----
    private _alphaSmudgingMode: boolean = false;
    private _useSecondaryMask: boolean = false;

    // ---- core render targets (always allocated) ----
    public drawingRenderTarget: RenderTarget;
    public smudging1CopyRenderTarget: RenderTarget;
    public smudging0CopyRenderTarget: RenderTarget;
    public liquidRenderTarget: RenderTarget;
    public dryRenderTarget: RenderTarget;

    // ---- smudging render targets (lazily allocated on first use) ----
    private drawingAlphaRenderTarget?: RenderTarget;
    private smudging1CopyAlphaRenderTarget?: RenderTarget;
    private smudging1CopyColorRenderTarget?: RenderTarget;
    private smudging0CopyAlphaRenderTarget?: RenderTarget;
    private smudging0CopyColorRenderTarget?: RenderTarget;

    // ---- water render targets (lazily allocated on first use) ----
    private maskDrawingRenderTarget?: RenderTarget;
    private maskLiquidRenderTarget?: RenderTarget;

    // ---- layer effects ----
    public layerOpacity: number = 1;
    public useLayerTinting: boolean = false;
    public edgeStyle: EdgeStyle | string = EdgeStyle.NONE;
    public dualTipEdgeStyle: EdgeStyle | string = EdgeStyle.NONE;
    public liquidLayerBlendmode: LayerBlendmode | string = LayerBlendmode.NORMAL;
    public brushColor: Color = new Color();
    public dotBlendmode: DotBlendmode | string = DotBlendmode.NORMAL;
    public maskDotBlendmode: DotBlendmode | string = DotBlendmode.NORMAL;

    constructor(context: UBrushContext, size: Size) {
        this.context = context;
        this.size = size;

        this.drawingRenderTarget = context.createRenderTarget(size);
        this.smudging1CopyRenderTarget = context.createRenderTarget(size);
        this.smudging0CopyRenderTarget = context.createRenderTarget(size);
        this.liquidRenderTarget = context.createRenderTarget(size);
        this.dryRenderTarget = context.createRenderTarget(size);

        this.tipTexture = context.createTexture();
        this.patternTexture = context.createTexture();
        this.dualTipTexture = context.createTexture();
    }

    public destroy(): void {
        // TODO: delete render targets
    }

    // ---- alphaSmudgingMode / useSecondaryMask (Swift parity) ----

    public set alphaSmudgingMode(value: boolean) {
        if (this._alphaSmudgingMode === value) return;
        this._alphaSmudgingMode = value;
        if (value) this._ensureSmudgingTargets();
        this._resyncDynamicBuffersForMode();
    }

    public get alphaSmudgingMode(): boolean {
        return this._alphaSmudgingMode;
    }

    public set useSecondaryMask(value: boolean) {
        if (this._useSecondaryMask === value) return;
        this._useSecondaryMask = value;
        if (value) this._ensureWaterTargets();
    }

    public get useSecondaryMask(): boolean {
        return this._useSecondaryMask;
    }

    public get debuggingRenderTarget(): RenderTarget | undefined {
        return this._alphaSmudgingMode ? this.drawingAlphaRenderTarget : undefined;
    }

    /**
     * Swift `updateAlphaSmugingMode` 대응. `alphaSmudgingMode` 전환 시 호출되며,
     * 동적 버퍼를 해당 모드의 기대 상태로 재-초기화한다.
     */
    private _resyncDynamicBuffersForMode(): void {
        const s = Common.stageRect();
        if (this._alphaSmudgingMode) {
            // liquidRenderTarget 을 source 로 alpha/color 분리 세팅
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.drawingAlphaRenderTarget!, this.drawingRenderTarget,
                { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
            );
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging1CopyAlphaRenderTarget!, this.smudging1CopyColorRenderTarget!,
                { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
            );
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging0CopyAlphaRenderTarget!, this.smudging0CopyColorRenderTarget!,
                { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
            );
        } else {
            // non-smudging 기대치로 복구: drawing/maskDrawing 클리어, smudging copy 버퍼를 dry 로 채움
            this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
            this._fill(this.smudging0CopyRenderTarget, this.dryRenderTarget.texture);
            this._fill(this.smudging1CopyRenderTarget, this.dryRenderTarget.texture);
            if (this._useSecondaryMask && this.maskDrawingRenderTarget) {
                this.context.clearRenderTarget(this.maskDrawingRenderTarget, Color.clear());
            }
        }
    }

    private _ensureSmudgingTargets(): void {
        if (this.drawingAlphaRenderTarget) return;
        this.drawingAlphaRenderTarget = this.context.createRenderTarget(this.size);
        this.smudging1CopyAlphaRenderTarget = this.context.createRenderTarget(this.size);
        this.smudging1CopyColorRenderTarget = this.context.createRenderTarget(this.size);
        this.smudging0CopyAlphaRenderTarget = this.context.createRenderTarget(this.size);
        this.smudging0CopyColorRenderTarget = this.context.createRenderTarget(this.size);
    }

    private _ensureWaterTargets(): void {
        if (this.maskDrawingRenderTarget) return;
        this.maskDrawingRenderTarget = this.context.createRenderTarget(this.size);
        this.maskLiquidRenderTarget = this.context.createRenderTarget(this.size);
    }

    // ---- useSmudging ----

    public set useSmudging(value: boolean) {
        this._useSmudging = value;
        this.smudging0Dot = undefined;
        this.smudgingDot = undefined;

        if (this._alphaSmudgingMode && value) {
            const s = Common.stageRect();
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging1CopyAlphaRenderTarget!,
                this.smudging1CopyColorRenderTarget!,
                { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
            );
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging0CopyAlphaRenderTarget!,
                this.smudging0CopyColorRenderTarget!,
                { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
            );
        }
    }

    public get useSmudging(): boolean {
        return this._useSmudging;
    }

    // ---- layerLowCut / layerHighCut ----

    public set layerLowCut(value: number) {
        this._layerLowCut = value;
        this.liquidCutMin = value;
        this.liquidCutMax = Math.max(this.liquidCutMin + 0.001, this._layerHighCut);
    }

    public get layerLowCut(): number {
        return this._layerLowCut;
    }

    public set layerHighCut(value: number) {
        this._layerHighCut = value;
        this.liquidCutMin = this._layerLowCut;
        this.liquidCutMax = Math.max(this.liquidCutMin + 0.001, this._layerHighCut);
    }

    public get layerHighCut(): number {
        return this._layerHighCut;
    }

    // ---- textures ----

    public async setTipTextureImageBase64(base64?: string): Promise<void> {
        if (base64) {
            await this.tipTexture.loadFromBase64((base64.search("data:image") === 0) ? base64 : ("data:image/png;base64," + base64));
        } else {
            this.tipTexture.setEmpty();
        }
    }

    public async setPatternTextureImageBase64(base64?: string): Promise<void> {
        if (base64) {
            await this.patternTexture.loadFromBase64((base64.search("data:image") === 0) ? base64 : ("data:image/png;base64," + base64));
        } else {
            this.patternTexture.setEmpty();
        }
    }

    public async setDualTipTextureImageBase64(base64?: string): Promise<void> {
        if (base64) {
            await this.dualTipTexture.loadFromBase64((base64.search("data:image") === 0) ? base64 : ("data:image/png;base64," + base64));
        } else {
            this.dualTipTexture.setEmpty();
        }
    }

    // ---- setupWithRenderTarget ----

    public setupWithRenderTarget(renderTarget: RenderTarget): void {
        const s = Common.stageRect();

        if (this._alphaSmudgingMode) {
            this._fill(this.liquidRenderTarget, renderTarget.texture);
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.drawingAlphaRenderTarget!, this.drawingRenderTarget,
                { targetRect: s, source: renderTarget.texture, sourceRect: s, canvasRect: s }
            );
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging1CopyAlphaRenderTarget!, this.smudging1CopyColorRenderTarget!,
                { targetRect: s, source: renderTarget.texture, sourceRect: s, canvasRect: s }
            );
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging0CopyAlphaRenderTarget!, this.smudging0CopyColorRenderTarget!,
                { targetRect: s, source: renderTarget.texture, sourceRect: s, canvasRect: s }
            );
        } else {
            this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
            this._fill(this.dryRenderTarget, renderTarget.texture);
            this._fill(this.smudging0CopyRenderTarget, renderTarget.texture);
            this._fill(this.smudging1CopyRenderTarget, renderTarget.texture);

            if (this._useSecondaryMask) {
                this.context.clearRenderTarget(this.maskDrawingRenderTarget!, Color.clear());
                this.context.clearRenderTarget(this.maskLiquidRenderTarget!, Color.clear());
            }
        }
    }

    // ---- drawDots ----

    public drawDots(dots: Dot[]): Rect | null {
        if (this._useSmudging) {
            let n = 0;
            let rect: Rect | null = null;
            while (n < dots.length) {
                const pack: Dot[] = [];
                for (let i = 0; i < maxSmudgingLength; i++) {
                    if (n < dots.length) pack.push(dots[n++]);
                }
                const partsRect = this.renderMultiDots(pack);
                if (partsRect) rect = Rect.union(rect ?? partsRect, partsRect);
            }
            return rect;
        } else {
            return this.renderMultiDots(dots);
        }
    }

    // ---- printToRenderTarget ----

    public printToRenderTarget(renderTarget: RenderTarget, rect: Rect, transform: AffineTransform): void {
        if (this._alphaSmudgingMode) {
            ProgramManager.getInstance().mergeLayersProgram.merge(renderTarget, {
                targetRect: rect,
                alphaSource: this.drawingAlphaRenderTarget!.texture,
                colorSource: this.drawingRenderTarget.texture,
                sourceRect: rect,
                canvasRect: Common.stageRect(),
                transform: new AffineTransform()
            });
        } else if (this._useSecondaryMask) {
            ProgramManager.getInstance().maskAndCutProgram.fill(renderTarget, {
                targetRect: rect,
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.drawingRenderTarget.texture,
                maskSource: this.maskDrawingRenderTarget!.texture,
                sourceRect: rect,
                transform: transform,
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect: Common.stageRect(),
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                edgeStyle: this.edgeStyle,
                maskEdgeStyle: this.dualTipEdgeStyle,
                maskBlendmode: this.maskDotBlendmode
            });
        } else {
            ProgramManager.getInstance().highLowCutProgram.fill(renderTarget, {
                targetRect: rect,
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.drawingRenderTarget.texture,
                sourceRect: rect,
                transform: transform,
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect: Common.stageRect(),
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                liquidColor: this.brushColor,
                liquidTinting: this.useLayerTinting,
                edgeStyle: this.edgeStyle
            });
        }
    }

    // ---- releaseDrawing ----

    public releaseDrawing(): void {
        this.smudging0Dot = undefined;
        this.smudgingDot = undefined;
        const s = Common.stageRect();

        if (this._alphaSmudgingMode) {
            ProgramManager.getInstance().mergeLayersProgram.merge(this.liquidRenderTarget, {
                targetRect: s,
                alphaSource: this.drawingAlphaRenderTarget!.texture,
                colorSource: this.drawingRenderTarget.texture,
                sourceRect: s,
                canvasRect: s,
                transform: new AffineTransform()
            });
        } else {
            this._fill(this.liquidRenderTarget, this.drawingRenderTarget.texture);

            if (this._useSecondaryMask) {
                this._fill(this.maskLiquidRenderTarget!, this.maskDrawingRenderTarget!.texture);
            }
        }
    }

    // ---- cancelDrawing ----

    public cancelDrawing(): void {
        const s = Common.stageRect();

        if (this._alphaSmudgingMode) {
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.drawingAlphaRenderTarget!, this.drawingRenderTarget,
                { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
            );
            if (this._useSmudging) {
                ProgramManager.getInstance().separateLayersProgram.separate(
                    this.smudging1CopyAlphaRenderTarget!, this.smudging1CopyColorRenderTarget!,
                    { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
                );
                ProgramManager.getInstance().separateLayersProgram.separate(
                    this.smudging0CopyAlphaRenderTarget!, this.smudging0CopyColorRenderTarget!,
                    { targetRect: s, source: this.liquidRenderTarget.texture, sourceRect: s, canvasRect: s }
                );
            }
        } else {
            this._fill(this.drawingRenderTarget, this.liquidRenderTarget.texture);

            if (this._useSecondaryMask) {
                this._fill(this.maskDrawingRenderTarget!, this.maskLiquidRenderTarget!.texture);
            }
        }
    }

    // ---- dry ----

    public dry(): void {
        if (this._alphaSmudgingMode) return;

        const s = Common.stageRect();
        const tempRenderTarget = this.context.createRenderTarget(this.size);

        if (this._useSecondaryMask) {
            ProgramManager.getInstance().maskAndCutProgram.fill(tempRenderTarget, {
                targetRect: s,
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.liquidRenderTarget.texture,
                maskSource: this.maskLiquidRenderTarget!.texture,
                sourceRect: s,
                transform: new AffineTransform(),
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect: s,
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                edgeStyle: this.edgeStyle,
                maskEdgeStyle: this.dualTipEdgeStyle,
                maskBlendmode: this.maskDotBlendmode
            });
        } else {
            ProgramManager.getInstance().highLowCutProgram.fill(tempRenderTarget, {
                targetRect: s,
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.liquidRenderTarget.texture,
                sourceRect: s,
                transform: new AffineTransform(),
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect: s,
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                liquidColor: this.brushColor,
                liquidTinting: this.useLayerTinting,
                edgeStyle: this.edgeStyle
            });
        }

        this._fill(this.dryRenderTarget, tempRenderTarget.texture);
        this.context.deleteRenderTarget(tempRenderTarget);

        this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());

        if (this._useSecondaryMask) {
            this.context.clearRenderTarget(this.maskLiquidRenderTarget!, Color.clear());
            this.context.clearRenderTarget(this.maskDrawingRenderTarget!, Color.clear());
            if (this._useSmudging) {
                this._fill(this.smudging1CopyRenderTarget, this.dryRenderTarget.texture);
            }
        } else {
            if (this._useSmudging) {
                this._fill(this.smudging0CopyRenderTarget, this.dryRenderTarget.texture);
                this._fill(this.smudging1CopyRenderTarget, this.dryRenderTarget.texture);
            }
        }
    }

    // ---- clear ----

    public clear(): void {
        if (this._alphaSmudgingMode) {
            this.context.clearRenderTarget(this.dryRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.drawingAlphaRenderTarget!, Color.black());
            this.context.clearRenderTarget(this.drawingRenderTarget, Color.black());
            this.context.clearRenderTarget(this.smudging1CopyAlphaRenderTarget!, Color.black());
            this.context.clearRenderTarget(this.smudging1CopyColorRenderTarget!, Color.black());
            this.context.clearRenderTarget(this.smudging0CopyAlphaRenderTarget!, Color.black());
            this.context.clearRenderTarget(this.smudging0CopyColorRenderTarget!, Color.black());
        } else if (this._useSecondaryMask) {
            this.context.clearRenderTarget(this.dryRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.maskLiquidRenderTarget!, Color.clear());
            this.context.clearRenderTarget(this.maskDrawingRenderTarget!, Color.clear());
            this.context.clearRenderTarget(this.smudging1CopyRenderTarget, Color.clear());
        } else {
            this.context.clearRenderTarget(this.dryRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.smudging0CopyRenderTarget, Color.clear());
            this.context.clearRenderTarget(this.smudging1CopyRenderTarget, Color.clear());
        }
    }

    // ---- fixer ----

    public fixer(fixerRenderTarget: FixerRenderTarget, rect: Rect): Fixer | null {
        if (this._alphaSmudgingMode) {
            if (fixerRenderTarget === FixerRenderTarget.Liquid) return null;
            return this._buildFixer(FixerRenderTarget.Liquid, rect, false);
        }
        return this._buildFixer(fixerRenderTarget, rect, this._useSecondaryMask);
    }

    private _buildFixer(fixerRenderTarget: FixerRenderTarget, rect: Rect, withMask: boolean): Fixer | null {
        const p1 = rect.origin.clone();
        const p2 = new Point(p1.x + rect.size.width, p1.y + rect.size.height);

        p1.x = Math.floor(((p1.x + 1.0) * 0.5) * this.size.width);
        p1.y = Math.floor(((p1.y + 1.0) * 0.5) * this.size.height);
        p2.x = Math.ceil(((p2.x + 1.0) * 0.5) * this.size.width);
        p2.y = Math.ceil(((p2.y + 1.0) * 0.5) * this.size.height);

        const partRectByPixel = new Rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);

        if (partRectByPixel.size.width === 0.0 || partRectByPixel.size.height === 0.0) return null;

        const canvasRect = new Rect(0, 0, this.size.width, this.size.height);
        const tempRenderTarget = this.context.createRenderTarget(this.size);

        if (fixerRenderTarget === FixerRenderTarget.Liquid) {
            ProgramManager.getInstance().fillRectProgram.fill(tempRenderTarget, {
                targetRect: partRectByPixel, source: this.liquidRenderTarget.texture,
                sourceRect: partRectByPixel, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
        } else if (fixerRenderTarget === FixerRenderTarget.Dry) {
            ProgramManager.getInstance().fillRectProgram.fill(tempRenderTarget, {
                targetRect: partRectByPixel, source: this.dryRenderTarget.texture,
                sourceRect: partRectByPixel, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
        } else if (withMask) {
            ProgramManager.getInstance().maskAndCutProgram.fill(tempRenderTarget, {
                targetRect: partRectByPixel,
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.liquidRenderTarget.texture,
                maskSource: this.maskLiquidRenderTarget!.texture,
                sourceRect: partRectByPixel,
                transform: new AffineTransform(),
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect,
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                edgeStyle: this.edgeStyle,
                maskEdgeStyle: this.dualTipEdgeStyle,
                maskBlendmode: this.maskDotBlendmode
            });
        } else {
            ProgramManager.getInstance().highLowCutProgram.fill(tempRenderTarget, {
                targetRect: partRectByPixel,
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.liquidRenderTarget.texture,
                sourceRect: partRectByPixel,
                transform: new AffineTransform(),
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect,
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                liquidColor: this.brushColor,
                liquidTinting: this.useLayerTinting,
                edgeStyle: this.edgeStyle
            });
        }

        const patchImageUrl = this.context.readPixelsByDataURL(tempRenderTarget, partRectByPixel);

        let patchMaskImageUrl: string | undefined;
        if (withMask && fixerRenderTarget === FixerRenderTarget.Liquid) {
            ProgramManager.getInstance().fillRectProgram.fill(tempRenderTarget, {
                targetRect: partRectByPixel, source: this.maskLiquidRenderTarget!.texture,
                sourceRect: partRectByPixel, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
            patchMaskImageUrl = this.context.readPixelsByDataURL(tempRenderTarget, partRectByPixel);
        }

        return new Fixer(partRectByPixel, rect, fixerRenderTarget, patchImageUrl, patchMaskImageUrl);
    }

    // ---- fix ----

    public async fix(fixer: Fixer, toLiquidLayer: boolean): Promise<Rect> {
        if (fixer.patchImageUrl === undefined) return new Rect();

        const canvasRect = new Rect(0, 0, this.size.width, this.size.height);
        const texture = this.context.createTexture();
        await texture.loadFromBase64(fixer.patchImageUrl);

        if (this._alphaSmudgingMode) {
            ProgramManager.getInstance().fillRectProgram.fill(this.liquidRenderTarget, {
                targetRect: fixer.patchRect, source: texture,
                sourceRect: canvasRect, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
            ProgramManager.getInstance().separateLayersProgram.separate(
                this.drawingAlphaRenderTarget!, this.drawingRenderTarget,
                { targetRect: fixer.patchRect, source: texture, sourceRect: canvasRect, canvasRect }
            );
            if (this._useSmudging) {
                ProgramManager.getInstance().separateLayersProgram.separate(
                    this.smudging1CopyAlphaRenderTarget!, this.smudging1CopyColorRenderTarget!,
                    { targetRect: fixer.patchRect, source: texture, sourceRect: canvasRect, canvasRect }
                );
                ProgramManager.getInstance().separateLayersProgram.separate(
                    this.smudging0CopyAlphaRenderTarget!, this.smudging0CopyColorRenderTarget!,
                    { targetRect: fixer.patchRect, source: texture, sourceRect: canvasRect, canvasRect }
                );
            }
        } else if (toLiquidLayer) {
            ProgramManager.getInstance().fillRectProgram.fill(this.liquidRenderTarget, {
                targetRect: fixer.patchRect, source: texture,
                sourceRect: canvasRect, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
            ProgramManager.getInstance().fillRectProgram.fill(this.drawingRenderTarget, {
                targetRect: fixer.patchRect, source: texture,
                sourceRect: canvasRect, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });

            if (this._useSecondaryMask && fixer.patchMaskImageUrl) {
                const maskTexture = this.context.createTexture();
                await maskTexture.loadFromBase64(fixer.patchMaskImageUrl);
                ProgramManager.getInstance().fillRectProgram.fill(this.maskLiquidRenderTarget!, {
                    targetRect: fixer.patchRect, source: maskTexture,
                    sourceRect: canvasRect, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
                });
                ProgramManager.getInstance().fillRectProgram.fill(this.maskDrawingRenderTarget!, {
                    targetRect: fixer.patchRect, source: maskTexture,
                    sourceRect: canvasRect, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
                });
            }
        } else {
            ProgramManager.getInstance().fillRectProgram.fill(this.dryRenderTarget, {
                targetRect: fixer.patchRect, source: texture,
                sourceRect: canvasRect, canvasRect, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
        }

        if (this._useSmudging && !this._alphaSmudgingMode) {
            const s = new Rect(0, 0, this.size.width, this.size.height);
            ProgramManager.getInstance().fillRectProgram.fill(this.smudging1CopyRenderTarget, {
                targetRect: s, source: this.dryRenderTarget.texture,
                sourceRect: s, canvasRect: s, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
            ProgramManager.getInstance().fillRectProgram.fill(this.smudging1CopyRenderTarget, {
                targetRect: s, source: this.drawingRenderTarget.texture,
                sourceRect: s, canvasRect: s, transform: new AffineTransform(), blend: RenderObjectBlend.Normal
            });
            ProgramManager.getInstance().fillRectProgram.fill(this.smudging0CopyRenderTarget, {
                targetRect: s, source: this.smudging1CopyRenderTarget.texture,
                sourceRect: s, canvasRect: s, transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
        }

        let p1 = new Point(fixer.patchRect.origin.x - 1, fixer.patchRect.origin.y - 1);
        let p2 = new Point(p1.x + fixer.patchRect.size.width + 2, p1.y + fixer.patchRect.size.height + 2);
        p1 = Common.pointInStage(p1, this.size);
        p2 = Common.pointInStage(p2, this.size);

        return new Rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    }

    // ---- renderMultiDots ----

    protected renderMultiDots(dots: Dot[]): Rect | null {
        if (dots.length === 0) return null;
        const drawingDots = dots.filter(d => !d.isMask);
        const maskDots = dots.filter(d => d.isMask);
        return this._drawDotsCore(drawingDots, maskDots, dots);
    }

    private _drawDotsCore(primaryDots: Dot[], secondaryDots: Dot[], allDots: Dot[]): Rect | null {
        // Swift §1.2 표 (preview=false 행만)
        const primaryType: DrawingTargetType = this._alphaSmudgingMode ? 'plain' : 'effect';
        const secondaryType: DrawingTargetType = this._alphaSmudgingMode
            ? 'plain'
            : (this._useSecondaryMask ? 'mask' : 'effect');

        // basic 모드만 layerOpacity 갱신 (기존 동작 보존)
        if (!this._alphaSmudgingMode && !this._useSecondaryMask) {
            this.layerOpacity = allDots[0].layerOpacity;
        }

        let rect: Rect | null = null;

        if (primaryDots.length > 0) {
            rect = this._renderPrimaryWithSmudging(primaryDots, allDots, primaryType);
        }

        if (secondaryDots.length > 0) {
            const secondaryRect = this.renderDots(secondaryDots, secondaryType, true);
            if (secondaryRect !== null) {
                rect = rect === null ? secondaryRect : Rect.union(rect, secondaryRect);
            }
        }

        if (rect === null) return null;

        if (this._useSmudging) {
            if (this._alphaSmudgingMode) this._rotateSmudgingBuffersAlphaSmudging(rect);
            else if (this._useSecondaryMask) this._rotateSmudgingBuffersWater(rect);
            else this._rotateSmudgingBuffersBasic(rect);
        }

        return rect;
    }

    private _renderPrimaryWithSmudging(primaryDots: Dot[], allDots: Dot[], type: DrawingTargetType): Rect | null {
        if (!this._useSmudging) {
            return this.renderDots(primaryDots, type, false);
        }

        // water: 첫 점 skip 부트스트랩 + smudging dots = primaryDots.last
        if (this._useSecondaryMask) {
            let rect: Rect | null;
            if (!this.smudgingDot) {
                const tempDots = primaryDots.concat();
                this.smudging0Dot = primaryDots[0];
                this.smudgingDot = primaryDots[0];
                tempDots.splice(0, 1);
                rect = this.renderDots(tempDots, type, false);
            } else {
                rect = this.renderDots(primaryDots, type, false);
            }
            const last = primaryDots[primaryDots.length - 1];
            this.smudging0Dot = last;
            this.smudgingDot = last;
            return rect;
        }

        // alphaSmudging: 첫 점 skip 부트스트랩
        if (this._alphaSmudgingMode) {
            let rect: Rect | null;
            if (this.smudgingDot === undefined) {
                const tempDots = primaryDots.concat();
                this.smudging0Dot = allDots[0];
                this.smudgingDot = allDots[0];
                tempDots.splice(0, 1);
                rect = this.renderDots(tempDots, type, false);
            } else {
                rect = this.renderDots(primaryDots, type, false);
            }
            this.smudging0Dot = this.smudgingDot;
            this.smudgingDot = allDots[allDots.length - 1];
            return rect;
        }

        // basic: 첫 점 그대로 그림
        if (this.smudgingDot === undefined) {
            this.smudging0Dot = allDots[0];
            this.smudgingDot = allDots[0];
        }
        const rect = this.renderDots(primaryDots, type, false);
        this.smudging0Dot = this.smudgingDot;
        this.smudgingDot = allDots[allDots.length - 1];
        return rect;
    }

    private _rotateSmudgingBuffersBasic(rect: Rect): void {
        ProgramManager.getInstance().fillRectProgram.fill(this.smudging0CopyRenderTarget, {
            targetRect: rect, source: this.smudging1CopyRenderTarget.texture,
            sourceRect: rect, canvasRect: Common.stageRect(), transform: new AffineTransform(), blend: RenderObjectBlend.None
        });
        ProgramManager.getInstance().highLowCutProgram.fill(this.smudging1CopyRenderTarget, {
            targetRect: rect,
            drySource: this.dryRenderTarget.texture,
            liquidSource: this.drawingRenderTarget.texture,
            sourceRect: rect,
            transform: new AffineTransform(),
            liquidSourceBlendmode: this.liquidLayerBlendmode,
            canvasRect: Common.stageRect(),
            opacity: this.layerOpacity,
            lowCut: this.liquidCutMin,
            highCut: this.liquidCutMax,
            liquidColor: this.brushColor,
            liquidTinting: this.useLayerTinting,
            edgeStyle: this.edgeStyle
        });
    }

    private _rotateSmudgingBuffersAlphaSmudging(rect: Rect): void {
        const fill = (dst: RenderTarget, src: Texture): void => {
            ProgramManager.getInstance().fillRectProgram.fill(dst, {
                targetRect: rect, source: src,
                sourceRect: rect, canvasRect: Common.stageRect(), transform: new AffineTransform(), blend: RenderObjectBlend.None
            });
        };
        fill(this.smudging0CopyAlphaRenderTarget!, this.smudging1CopyAlphaRenderTarget!.texture);
        fill(this.smudging0CopyColorRenderTarget!, this.smudging1CopyColorRenderTarget!.texture);
        fill(this.smudging1CopyAlphaRenderTarget!, this.drawingAlphaRenderTarget!.texture);
        fill(this.smudging1CopyColorRenderTarget!, this.drawingRenderTarget.texture);
    }

    private _rotateSmudgingBuffersWater(rect: Rect): void {
        ProgramManager.getInstance().maskAndCutProgram.fill(this.smudging1CopyRenderTarget, {
            targetRect: rect,
            drySource: this.dryRenderTarget.texture,
            liquidSource: this.drawingRenderTarget.texture,
            maskSource: this.maskDrawingRenderTarget!.texture,
            sourceRect: rect,
            transform: new AffineTransform(),
            liquidSourceBlendmode: this.liquidLayerBlendmode,
            canvasRect: Common.stageRect(),
            opacity: this.layerOpacity,
            lowCut: this.liquidCutMin,
            highCut: this.liquidCutMax,
            edgeStyle: this.edgeStyle,
            maskEdgeStyle: this.dualTipEdgeStyle,
            maskBlendmode: this.maskDotBlendmode
        });
    }

    // ---- renderDots (geometry + texture coord building) ----

    protected renderDots(dots: Dot[], type: DrawingTargetType, useDualTip: boolean): Rect | null {
        const numberOfDots: number = dots.length;
        if (numberOfDots === 0) return null;

        const indexData: number[] = [];
        const points: number[] = [];
        const colors: number[] = [];
        const tipTextureCoordinates: number[] = [];
        const patternTextureCoordinates: number[] = [];
        const smudging0TexturePositions: number[] = [];
        const smudgingTexturePositions: number[] = [];
        const opacities: number[] = [];
        const corrosions: number[] = [];

        let rectX1 = Infinity, rectX2 = -Infinity;
        let rectY1 = Infinity, rectY2 = -Infinity;

        for (let i = 0; i < numberOfDots; i++) {
            const dot: Dot = dots[i];

            const dhw = dot.width * 0.5;
            const dhh = dot.height * 0.5;
            const sinR = Math.sin(dot.rotation);
            const conR = Math.cos(dot.rotation);
            const xsinR = dhw * sinR, ysinR = dhh * sinR;
            const xcosR = dhw * conR, ycosR = dhh * conR;

            let rp1 = new Point(dot.centerX - xcosR + ysinR, dot.centerY - xsinR - ycosR);
            let rp2 = new Point(dot.centerX + xcosR + ysinR, dot.centerY + xsinR - ycosR);
            let rp3 = new Point(dot.centerX - xcosR - ysinR, dot.centerY - xsinR + ycosR);
            let rp4 = new Point(dot.centerX + xcosR - ysinR, dot.centerY + xsinR + ycosR);

            let p1 = Common.pointInStage(rp1, this.size);
            let p2 = Common.pointInStage(rp2, this.size);
            let p3 = Common.pointInStage(rp3, this.size);
            let p4 = Common.pointInStage(rp4, this.size);

            points[i * 8 + 0] = p1.x; points[i * 8 + 1] = p1.y;
            points[i * 8 + 2] = p2.x; points[i * 8 + 3] = p2.y;
            points[i * 8 + 4] = p3.x; points[i * 8 + 5] = p3.y;
            points[i * 8 + 6] = p4.x; points[i * 8 + 7] = p4.y;

            rectX1 = Math.min(rectX1, Math.min(p1.x, Math.min(p2.x, Math.min(p3.x, p4.x))));
            rectX2 = Math.max(rectX2, Math.max(p1.x, Math.max(p2.x, Math.max(p3.x, p4.x))));
            rectY1 = Math.min(rectY1, Math.min(p1.y, Math.min(p2.y, Math.min(p3.y, p4.y))));
            rectY2 = Math.max(rectY2, Math.max(p1.y, Math.max(p2.y, Math.max(p3.y, p4.y))));

            tipTextureCoordinates[i * 8 + 0] = dot.textureL;
            tipTextureCoordinates[i * 8 + 1] = dot.textureT;
            tipTextureCoordinates[i * 8 + 2] = dot.textureR;
            tipTextureCoordinates[i * 8 + 3] = dot.textureT;
            tipTextureCoordinates[i * 8 + 4] = dot.textureL;
            tipTextureCoordinates[i * 8 + 5] = dot.textureB;
            tipTextureCoordinates[i * 8 + 6] = dot.textureR;
            tipTextureCoordinates[i * 8 + 7] = dot.textureB;

            const patternSize = new Size(
                (dot.patternWidth > 0) ? dot.patternWidth : this.size.width,
                (dot.patternHeight > 0) ? dot.patternHeight : this.size.height
            );
            p1 = Common.pointInTexture(rp1, patternSize);
            p2 = Common.pointInTexture(rp2, patternSize);
            p3 = Common.pointInTexture(rp3, patternSize);
            p4 = Common.pointInTexture(rp4, patternSize);

            const pox = dot.patternOffsetX, poxc = 1.0 - pox;
            const poy = dot.patternOffsetY, poyc = 1.0 - poy;

            patternTextureCoordinates[i * 8 + 0] = p1.x * pox + tipTextureCoordinates[i * 8 + 0] * poxc;
            patternTextureCoordinates[i * 8 + 1] = p1.y * poy + tipTextureCoordinates[i * 8 + 1] * poyc;
            patternTextureCoordinates[i * 8 + 2] = p2.x * pox + tipTextureCoordinates[i * 8 + 2] * poxc;
            patternTextureCoordinates[i * 8 + 3] = p2.y * poy + tipTextureCoordinates[i * 8 + 3] * poyc;
            patternTextureCoordinates[i * 8 + 4] = p3.x * pox + tipTextureCoordinates[i * 8 + 4] * poxc;
            patternTextureCoordinates[i * 8 + 5] = p3.y * poy + tipTextureCoordinates[i * 8 + 5] * poyc;
            patternTextureCoordinates[i * 8 + 6] = p4.x * pox + tipTextureCoordinates[i * 8 + 6] * poxc;
            patternTextureCoordinates[i * 8 + 7] = p4.y * poy + tipTextureCoordinates[i * 8 + 7] * poyc;

            const jx = dot.textureJitterOffsetX;
            const jy = dot.textureJitterOffsetY;
            patternTextureCoordinates[i * 8 + 0] += jx; patternTextureCoordinates[i * 8 + 1] += jy;
            patternTextureCoordinates[i * 8 + 2] += jx; patternTextureCoordinates[i * 8 + 3] += jy;
            patternTextureCoordinates[i * 8 + 4] += jx; patternTextureCoordinates[i * 8 + 5] += jy;
            patternTextureCoordinates[i * 8 + 6] += jx; patternTextureCoordinates[i * 8 + 7] += jy;

            if (this._useSmudging && this.smudgingDot && this.smudging0Dot) {
                const sr = Math.sin(this.smudgingDot.rotation), cr = Math.cos(this.smudgingDot.rotation);
                const sxs = dhw * sr, sys = dhh * sr, sxc = dhw * cr, syc = dhh * cr;

                rp1 = new Point(this.smudgingDot.centerX - sxc + sys, this.smudgingDot.centerY - sxs - syc);
                rp2 = new Point(this.smudgingDot.centerX + sxc + sys, this.smudgingDot.centerY + sxs - syc);
                rp3 = new Point(this.smudgingDot.centerX - sxc - sys, this.smudgingDot.centerY - sxs + syc);
                rp4 = new Point(this.smudgingDot.centerX + sxc - sys, this.smudgingDot.centerY + sxs + syc);

                p1 = Common.pointInTexture(rp1, this.size);
                p2 = Common.pointInTexture(rp2, this.size);
                p3 = Common.pointInTexture(rp3, this.size);
                p4 = Common.pointInTexture(rp4, this.size);

                smudgingTexturePositions[i * 8 + 0] = p1.x; smudgingTexturePositions[i * 8 + 1] = p1.y;
                smudgingTexturePositions[i * 8 + 2] = p2.x; smudgingTexturePositions[i * 8 + 3] = p2.y;
                smudgingTexturePositions[i * 8 + 4] = p3.x; smudgingTexturePositions[i * 8 + 5] = p3.y;
                smudgingTexturePositions[i * 8 + 6] = p4.x; smudgingTexturePositions[i * 8 + 7] = p4.y;

                rp1 = new Point(this.smudging0Dot.centerX - sxc + sys, this.smudging0Dot.centerY - sxs - syc);
                rp2 = new Point(this.smudging0Dot.centerX + sxc + sys, this.smudging0Dot.centerY + sxs - syc);
                rp3 = new Point(this.smudging0Dot.centerX - sxc - sys, this.smudging0Dot.centerY - sxs + syc);
                rp4 = new Point(this.smudging0Dot.centerX + sxc - sys, this.smudging0Dot.centerY + sxs + syc);

                p1 = Common.pointInTexture(rp1, this.size);
                p2 = Common.pointInTexture(rp2, this.size);
                p3 = Common.pointInTexture(rp3, this.size);
                p4 = Common.pointInTexture(rp4, this.size);

                smudging0TexturePositions[i * 8 + 0] = p1.x; smudging0TexturePositions[i * 8 + 1] = p1.y;
                smudging0TexturePositions[i * 8 + 2] = p2.x; smudging0TexturePositions[i * 8 + 3] = p2.y;
                smudging0TexturePositions[i * 8 + 4] = p3.x; smudging0TexturePositions[i * 8 + 5] = p3.y;
                smudging0TexturePositions[i * 8 + 6] = p4.x; smudging0TexturePositions[i * 8 + 7] = p4.y;
            } else {
                for (let k = 0; k < 8; k++) {
                    smudgingTexturePositions[i * 8 + k] = 0.0;
                    smudging0TexturePositions[i * 8 + k] = 0.0;
                }
            }

            indexData[i * 6 + 0] = i * 4 + 0;
            indexData[i * 6 + 1] = i * 4 + 1;
            indexData[i * 6 + 2] = i * 4 + 2;
            indexData[i * 6 + 3] = i * 4 + 3;
            indexData[i * 6 + 4] = i * 4 + 2;
            indexData[i * 6 + 5] = i * 4 + 1;

            for (let j = 0; j < 4; j++) {
                colors[i * 16 + j * 4 + 0] = dot.tintRed;
                colors[i * 16 + j * 4 + 1] = dot.tintGreen;
                colors[i * 16 + j * 4 + 2] = dot.tintBlue;
                colors[i * 16 + j * 4 + 3] = dot.tinting;

                opacities[i * 16 + j * 4 + 0] = dot.opacity;
                opacities[i * 16 + j * 4 + 1] = dot.patternOpacity;
                opacities[i * 16 + j * 4 + 2] = dot.mixingOpacity;
                opacities[i * 16 + j * 4 + 3] = i / numberOfDots;

                corrosions[i * 16 + j * 4 + 0] = dot.tipCorrosion;
                corrosions[i * 16 + j * 4 + 1] = dot.textureCorrosion;
                corrosions[i * 16 + j * 4 + 2] = dot.tipCorrosionSize;
                corrosions[i * 16 + j * 4 + 3] = dot.textureCorrosionSize;
            }
        }

        this.executeDotProgram({
            points, indexData, tipTextureCoordinates, patternTextureCoordinates,
            smudging0TexturePositions, smudgingTexturePositions, colors, opacities, corrosions,
            numberOfPoints: 6 * numberOfDots, useDualTip
        }, type);

        return new Rect(rectX1, rectY1, rectX2 - rectX1, rectY2 - rectY1);
    }

    // ---- excuteDotProgram ----

    protected executeDotProgram(param: {
        points: number[],
        indexData: number[],
        tipTextureCoordinates: number[],
        patternTextureCoordinates: number[],
        smudging0TexturePositions: number[],
        smudgingTexturePositions: number[],
        colors: number[],
        opacities: number[],
        corrosions: number[],
        numberOfPoints: number,
        useDualTip: boolean
    }, type: DrawingTargetType): void {
        if (type === 'plain') {
            // alphaSmudging 경로: alpha + color 두 RT 동시 그리기
            ProgramManager.getInstance().smudgingDotProgram.drawRects(
                this.drawingAlphaRenderTarget!,
                this.drawingRenderTarget,
                {
                    tipTexture: this.tipTexture,
                    patternTexture: this.patternTexture,
                    smudging0CopyAlphaTexture: this.smudging0CopyAlphaRenderTarget!.texture,
                    smudging0CopyColorFramebuffer: this.smudging0CopyColorRenderTarget!.texture,
                    smudgingCopyAlphaTexture: this.smudging1CopyAlphaRenderTarget!.texture,
                    smudgingCopyColorFramebuffer: this.smudging1CopyColorRenderTarget!.texture,
                    dualTipTexture: this.dualTipTexture,
                    points: param.points,
                    indexData: param.indexData,
                    tipTextureCoordinates: param.tipTextureCoordinates,
                    patternTextureCoordinates: param.patternTextureCoordinates,
                    smudging0TexturePositions: param.smudging0TexturePositions,
                    smudgingTexturePositions: param.smudgingTexturePositions,
                    colors: param.colors,
                    opacities: param.opacities,
                    corrosions: param.corrosions,
                    numberOfPoints: param.numberOfPoints,
                    useDualTip: param.useDualTip
                }
            );
            return;
        }

        // type === 'effect' | 'mask'
        const renderTarget = type === 'mask'
            ? this.maskDrawingRenderTarget!
            : this.drawingRenderTarget;
        const blend = this._dotBlendToRenderObjectBlend(
            type === 'mask' ? this.maskDotBlendmode : this.dotBlendmode
        );
        // water 경로(useSecondaryMask=true)에서는 smudging1Copy 를 0/1 양쪽에 재사용
        const smudging0Texture = this._useSecondaryMask
            ? this.smudging1CopyRenderTarget.texture
            : this.smudging0CopyRenderTarget.texture;

        ProgramManager.getInstance().drawDotProgram.drawRects(renderTarget, {
            tipTexture: this.tipTexture,
            patternTexture: this.patternTexture,
            smudging0Texture,
            smudgingTexture: this.smudging1CopyRenderTarget.texture,
            dualTipTexture: this.dualTipTexture,
            points: param.points,
            indexData: param.indexData,
            tipTextureCoordinates: param.tipTextureCoordinates,
            patternTextureCoordinates: param.patternTextureCoordinates,
            smudging0TexturePositions: param.smudging0TexturePositions,
            smudgingTexturePositions: param.smudgingTexturePositions,
            colors: param.colors,
            opacities: param.opacities,
            corrosions: param.corrosions,
            numberOfPoints: param.numberOfPoints,
            useDualTip: param.useDualTip,
            blend
        });
    }

    // ---- private helpers ----

    private _dotBlendToRenderObjectBlend(mode: DotBlendmode | string): RenderObjectBlend {
        if (mode === DotBlendmode.ADD) return RenderObjectBlend.Add;
        if (mode === DotBlendmode.SCREEN) return RenderObjectBlend.Screen;
        if (mode === DotBlendmode.MAX) return RenderObjectBlend.Max;
        return RenderObjectBlend.Normal;
    }

    private _fill(dst: RenderTarget, src: Texture): void {
        ProgramManager.getInstance().fillRectProgram.fill(dst, {
            targetRect: Common.stageRect(),
            source: src,
            sourceRect: Common.stageRect(),
            canvasRect: Common.stageRect(),
            transform: new AffineTransform(),
            blend: RenderObjectBlend.None
        });
    }

}
