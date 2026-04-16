import { Size } from "../common/Size";
import { UBrushContext } from "../gpu/UBrushContext";
import { DrawingEngine } from "./DrawingEngine";
import { ProgramManager } from "../program/ProgramManager";
import { RenderTarget } from "../gpu/RenderTarget";
import { AffineTransform } from "../common/AffineTransform";
import { RenderObjectBlend } from "../gpu/RenderObject";
import { Dot } from "../common/Dot";
import { Rect } from "../common/Rect";
import { Color } from "../common/Color";
import { Common } from "../common/Common";
import { FixerRenderTarget, Fixer } from "../common/Fixer";
import { Point } from "../common/Point";

export class SmudgingDrawingEngine extends DrawingEngine {

    public drawingAlphaRenderTarget: RenderTarget;
    public drawingColorRenderTarget: RenderTarget;
    public smudging1CopyAlphaRenderTarget: RenderTarget;
    public smudging1CopyColorRenderTarget: RenderTarget;
    public smudging0CopyAlphaRenderTarget: RenderTarget;
    public smudging0CopyColorRenderTarget: RenderTarget;

    constructor(context: UBrushContext, size: Size) {

        super(context, size);

        this.drawingAlphaRenderTarget = context.createRenderTarget(size);
        this.drawingColorRenderTarget = this.drawingRenderTarget;
        this.smudging1CopyAlphaRenderTarget = context.createRenderTarget(size);
        this.smudging1CopyColorRenderTarget = context.createRenderTarget(size);//this.smudging1CopyRenderTarget;
        this.smudging0CopyAlphaRenderTarget = context.createRenderTarget(size);
        this.smudging0CopyColorRenderTarget = context.createRenderTarget(size);//this.smudging0CopyRenderTarget;

    }

    public destroy(): void {

        // TODO: delete drawingRenderTarget ...

    }
    
    public set useSmudging(value: boolean) {

        this._useSmudging = value;
        this.smudging0Dot = undefined;
        this.smudgingDot = undefined;
        
        if (this._useSmudging) {

            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging1CopyAlphaRenderTarget,
                this.smudging1CopyColorRenderTarget,
                {

                    targetRect: Common.stageRect(),
                    source: this.liquidRenderTarget.texture,
                    sourceRect: Common.stageRect(),
                    canvasRect: Common.stageRect()

                }

            );

            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging0CopyAlphaRenderTarget,
                this.smudging0CopyColorRenderTarget,
                {

                    targetRect: Common.stageRect(),
                    source: this.liquidRenderTarget.texture,
                    sourceRect: Common.stageRect(),
                    canvasRect: Common.stageRect()

                }

            );

        }

    }

    public get useSmudging(): boolean {
        
        return this._useSmudging;
        
    }

    public setupWithRenderTarget(renderTarget: RenderTarget): void {

        ProgramManager.getInstance().fillRectProgram.fill(
            this.liquidRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: renderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }
        );

        ProgramManager.getInstance().separateLayersProgram.separate(
            this.drawingAlphaRenderTarget,
            this.drawingColorRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: renderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect()

            }
        );

        ProgramManager.getInstance().separateLayersProgram.separate(
            this.smudging1CopyAlphaRenderTarget,
            this.smudging1CopyColorRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: renderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect()

            }
        );
        
        ProgramManager.getInstance().separateLayersProgram.separate(
            this.smudging0CopyAlphaRenderTarget,
            this.smudging0CopyColorRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: renderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect()

            }
        );

    }

    public printToRenderTarget(renderTarget: RenderTarget, rect: Rect, transform: AffineTransform): void {
    
        ProgramManager.getInstance().mergeLayersProgram.merge(
            renderTarget,
            {
                targetRect: rect,
                alphaSource: this.drawingAlphaRenderTarget.texture,
                colorSource: this.drawingColorRenderTarget.texture,
                sourceRect: rect,
                canvasRect: Common.stageRect(),
                transform: new AffineTransform()
            }

        );

    }

    public releaseDrawing() {

        this.smudging0Dot = undefined;
        this.smudgingDot = undefined;
    
        ProgramManager.getInstance().mergeLayersProgram.merge(
            this.liquidRenderTarget,
            {

                targetRect: Common.stageRect(),
                alphaSource: this.drawingAlphaRenderTarget.texture,
                colorSource: this.drawingColorRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform()

            }

        );
        
    }

    public cancelDrawing() {
    
        ProgramManager.getInstance().separateLayersProgram.separate(
            this.drawingAlphaRenderTarget,
            this.drawingColorRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: this.liquidRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect()

            }
        );
        
        if (this.useSmudging) {

            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging1CopyAlphaRenderTarget,
                this.smudging1CopyColorRenderTarget,
                {
    
                    targetRect: Common.stageRect(),
                    source: this.liquidRenderTarget.texture,
                    sourceRect: Common.stageRect(),
                    canvasRect: Common.stageRect()
    
                }
            );

            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging0CopyAlphaRenderTarget,
                this.smudging0CopyColorRenderTarget,
                {
    
                    targetRect: Common.stageRect(),
                    source: this.liquidRenderTarget.texture,
                    sourceRect: Common.stageRect(),
                    canvasRect: Common.stageRect()
    
                }
            );

        }

    }

    public dry() {

        // do nothing

    }

    public clear() {

        this.context.clearRenderTarget(this.dryRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.drawingAlphaRenderTarget, Color.black());
        this.context.clearRenderTarget(this.drawingColorRenderTarget, Color.black());
        this.context.clearRenderTarget(this.smudging1CopyAlphaRenderTarget, Color.black());
        this.context.clearRenderTarget(this.smudging1CopyColorRenderTarget, Color.black());
        this.context.clearRenderTarget(this.smudging0CopyAlphaRenderTarget, Color.black());
        this.context.clearRenderTarget(this.smudging0CopyColorRenderTarget, Color.black());

    }

    protected renderMultiDots(dots: Dot[]): Rect | null {

        if (dots.length === 0) {
            return null;
        }

        let rect: Rect | null = null;

        const firstDot: Dot = dots[0];
        const lastDot: Dot = dots[dots.length - 1];
        
        if (this.useSmudging) {

            if (this.smudgingDot === undefined) {

                const tempDots = dots.concat();
                this.smudging0Dot = firstDot;
                this.smudgingDot = firstDot;
                tempDots.splice(0, 1);
                rect = this.renderDots(tempDots, false);

            } else {

                rect = this.renderDots(dots, false);

            }

            this.smudging0Dot = this.smudgingDot;
            this.smudgingDot = lastDot;

        } else {

            rect = this.renderDots(dots, false);

        }

        if (rect === null) {

            return null;

        }

        if (this.useSmudging) {

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging0CopyAlphaRenderTarget,
                {

                    targetRect: rect,
                    source: this.smudging1CopyAlphaRenderTarget.texture,
                    sourceRect: rect,
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
                    
                }
            );

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging0CopyColorRenderTarget,
                {

                    targetRect: rect,
                    source: this.smudging1CopyColorRenderTarget.texture,
                    sourceRect: rect,
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
                    
                }
            );

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging1CopyAlphaRenderTarget,
                {

                    targetRect: rect,
                    source: this.drawingAlphaRenderTarget.texture,
                    sourceRect: rect,
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
                    
                }
            );

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging1CopyColorRenderTarget,
                {

                    targetRect: rect,
                    source: this.drawingColorRenderTarget.texture,
                    sourceRect: rect,
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
                    
                }
            );

        }

        return rect;

    }
//!!!!!!
    protected excuteDotProgram(param: {
        points: number[],
        indexData: number[],
        tipTextureCoordinates: number[],
        patternTextureCoordinates: number[],
        smudging0TexturePositions: number[],
        smudgingTexturePositions: number[],
        colors: number[],
        opacities: number[],
        numberOfPoints: number,
        useDualTip: boolean
    }): void {

        ProgramManager.getInstance().smudgingDotProgram.drawRects(
            this.drawingAlphaRenderTarget, 
            this.drawingColorRenderTarget, 
        {

            tipTexture: this.tipTexture,
            patternTexture: this.patternTexture,
            smudging0CopyAlphaTexture: this.smudging0CopyAlphaRenderTarget.texture,
            smudging0CopyColorFramebuffer: this.smudging0CopyColorRenderTarget.texture,
            smudgingCopyAlphaTexture: this.smudging1CopyAlphaRenderTarget.texture,
            smudgingCopyColorFramebuffer: this.smudging1CopyColorRenderTarget.texture,
            dualTipTexture: this.dualTipTexture,
            points: param.points,
            indexData: param.indexData,
            tipTextureCoordinates: param.tipTextureCoordinates,
            patternTextureCoordinates: param.patternTextureCoordinates,
            smudging0TexturePositions: param.smudging0TexturePositions,
            smudgingTexturePositions: param.smudgingTexturePositions,
            colors: param.colors,
            opacities: param.opacities,
            numberOfPoints: param.numberOfPoints,
            useDualTip: param.useDualTip

        });

    }

    public fixer(fixerRenderTarget: FixerRenderTarget, rect: Rect): Fixer | null {

        if (fixerRenderTarget === FixerRenderTarget.Liquid) return null;

        return super.fixer(FixerRenderTarget.Liquid, rect);

    }

    public async fix(fixer: Fixer, toLiquidLayer: boolean): Promise<Rect> {
        
        if (fixer.patchImageUrl === undefined) return new Rect();

        const canvasRect = new Rect(0, 0, this.size.width, this.size.height);
        const texture = this.context.createTexture();

        await texture.loadFromBase64(fixer.patchImageUrl);
        
        ProgramManager.getInstance().fillRectProgram.fill(
            this.liquidRenderTarget,
            {

                targetRect: fixer.patchRect,
                source: texture,
                sourceRect: canvasRect,
                canvasRect: canvasRect,
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );

        ProgramManager.getInstance().separateLayersProgram.separate(
            this.drawingAlphaRenderTarget,
            this.drawingColorRenderTarget,
            {

                targetRect: fixer.patchRect,
                source: texture,
                sourceRect: canvasRect,
                canvasRect: canvasRect

            }

        );
        
        if (this._useSmudging) {

            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging1CopyAlphaRenderTarget,
                this.smudging1CopyColorRenderTarget,
                {
    
                    targetRect: fixer.patchRect,
                    source: texture,
                    sourceRect: canvasRect,
                    canvasRect: canvasRect
    
                }
    
            );

            ProgramManager.getInstance().separateLayersProgram.separate(
                this.smudging0CopyAlphaRenderTarget,
                this.smudging0CopyColorRenderTarget,
                {
    
                    targetRect: fixer.patchRect,
                    source: texture,
                    sourceRect: canvasRect,
                    canvasRect: canvasRect
    
                }
    
            );

        }
        
        let p1 = new Point(fixer.patchRect.origin.x - 1, fixer.patchRect.origin.y - 1);
        let p2 = new Point(p1.x + fixer.patchRect.size.width + 2, p1.y + fixer.patchRect.size.height + 2);
        p1 = Common.pointInStage(p1, this.size);
        p2 = Common.pointInStage(p2, this.size);
        
        return new Rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);

    }

}