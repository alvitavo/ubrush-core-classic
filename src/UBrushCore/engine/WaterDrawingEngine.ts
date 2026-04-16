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

export class WaterDrawingEngine extends DrawingEngine {

    public maskDrawingRenderTarget: RenderTarget;
    public maskLiquidRenderTarget: RenderTarget;

    private currentRenderTarget: RenderTarget;

    constructor(context: UBrushContext, size: Size) {

        super(context, size);

        this.maskDrawingRenderTarget = context.createRenderTarget(size);
        this.maskLiquidRenderTarget = context.createRenderTarget(size);
        
        this.currentRenderTarget = this.drawingRenderTarget;

    }

    public destroy(): void {

        // TODO: delete drawingRenderTarget ...

    }
    
    public setupWithRenderTarget(renderTarget: RenderTarget): void {

        super.setupWithRenderTarget(renderTarget);
        
        this.context.clearRenderTarget(this.maskDrawingRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.maskLiquidRenderTarget, Color.clear());

    }

    public printToRenderTarget(renderTarget: RenderTarget, rect: Rect, transform: AffineTransform): void {
    
        ProgramManager.getInstance().maskAndCutProgram.fill(
            renderTarget,
            {

                targetRect: rect,
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.drawingRenderTarget.texture,
                maskSource: this.maskDrawingRenderTarget.texture,
                sourceRect: rect,
                transform: transform, 
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect: Common.stageRect(),
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                wetEdge: this.useLayerWetEdge
                
            }

        );

    }

    public releaseDrawing() {

        super.releaseDrawing();

        ProgramManager.getInstance().fillRectProgram.fill(
            this.maskLiquidRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: this.maskDrawingRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );
        
    }

    public cancelDrawing() {
    
        super.cancelDrawing();
    
        ProgramManager.getInstance().fillRectProgram.fill(
            this.maskDrawingRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: this.maskLiquidRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );

    }

    public dry() {
        
        const tempRenderTarget = this.context.createRenderTarget(this.size);

        ProgramManager.getInstance().maskAndCutProgram.fill(
            tempRenderTarget,
            {

                targetRect: Common.stageRect(),
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.liquidRenderTarget.texture,
                maskSource: this.maskLiquidRenderTarget.texture,
                sourceRect: Common.stageRect(),
                transform: new AffineTransform(), 
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect: Common.stageRect(),
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                wetEdge: this.useLayerWetEdge
                
            }
        );
        
        ProgramManager.getInstance().fillRectProgram.fill(
            this.dryRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: tempRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );
        
        this.context.deleteRenderTarget(tempRenderTarget);

        this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.maskLiquidRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.maskDrawingRenderTarget, Color.clear());
        
        if (this.useSmudging) {

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging1CopyRenderTarget,
                {
    
                    targetRect: Common.stageRect(),
                    source: this.dryRenderTarget.texture,
                    sourceRect: Common.stageRect(),
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
    
                }
    
            );

        }

    }

    public clear() {

        this.context.clearRenderTarget(this.dryRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.maskLiquidRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.maskDrawingRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.smudging1CopyRenderTarget, Color.clear());

    }

    protected renderMultiDots(dots: Dot[]): Rect | null {

        if (dots.length === 0) {
            return null;
        }

        let rect: Rect | null = null;

        const maskDots: Dot[] = [];
        const drawingDots: Dot[] = [];

        for (let i = 0; i < dots.length; i++) {

            const dot = dots[i];
            if (dot.isMask) {

                maskDots.push(dot);

            } else {

                drawingDots.push(dot);

            }

        }

        // set currentRenderTarget
        this.currentRenderTarget = this.drawingRenderTarget;

        if (this.useSmudging) {

            if (!this.smudgingDot && drawingDots.length > 0) {

                const tempDots = drawingDots.concat();
                this.smudging0Dot = drawingDots[0];
                this.smudgingDot = drawingDots[0];
                tempDots.splice(0, 1);
                
                rect = this.renderDots(tempDots, false);
            
            } else {

                rect = this.renderDots(drawingDots, false);

            }
            
            if (drawingDots.length > 0) {

                this.smudging0Dot = drawingDots[drawingDots.length - 1];
                this.smudgingDot = drawingDots[drawingDots.length - 1];

            }

        } else {

            rect = this.renderDots(drawingDots, false);
            
        }

        // set currentRenderTarget
        this.currentRenderTarget = this.maskDrawingRenderTarget;
        
        const maskRect: Rect | null = this.renderDots(maskDots, true);
    
        if (rect !== null && maskRect !== null) {

            rect = Rect.union(rect, maskRect);

        } else if (maskRect !== null) {

            rect = maskRect;

        }
        
        if (rect === null) return null;
        
        if (this.useSmudging) {

            ProgramManager.getInstance().maskAndCutProgram.fill(
                this.smudging1CopyRenderTarget,
                {

                    targetRect: rect,
                    drySource: this.dryRenderTarget.texture,
                    liquidSource: this.drawingRenderTarget.texture,
                    maskSource: this.maskDrawingRenderTarget.texture,
                    sourceRect: rect,
                    transform: new AffineTransform(), 
                    liquidSourceBlendmode: this.liquidLayerBlendmode,
                    canvasRect: Common.stageRect(),
                    opacity: this.layerOpacity,
                    lowCut: this.liquidCutMin,
                    highCut: this.liquidCutMax,
                    wetEdge: this.useLayerWetEdge
                    
                }
            );

        }
        
        return rect;

    }

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

        ProgramManager.getInstance().drawDotProgram.drawRects(this.currentRenderTarget, {

            tipTexture: this.tipTexture,
            patternTexture: this.patternTexture,
            smudging0Texture: this.smudging1CopyRenderTarget.texture,
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
            numberOfPoints: param.numberOfPoints,
            useDualTip: param.useDualTip

        });

    }


    public fixer(fixerRenderTarget: FixerRenderTarget, rect: Rect): Fixer | null {

        const p1 = rect.origin.clone();
        const p2 = new Point(p1.x + rect.size.width, p1.y + rect.size.height);

        p1.x = Math.floor(((p1.x + 1.0) * 0.5) * this.size.width);
        p1.y = Math.floor(((p1.y + 1.0) * 0.5) * this.size.height);
        p2.x = Math.ceil(((p2.x + 1.0) * 0.5) * this.size.width);
        p2.y = Math.ceil(((p2.y + 1.0) * 0.5) * this.size.height);
        
        const partRectByPixel = new Rect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
        
        if (partRectByPixel.size.width === 0.0 || partRectByPixel.size.height === 0.0) {

            return null;

        }
        
        const canvasRect = new Rect(0, 0, this.size.width, this.size.height);
        
        const tempRenderTarget = this.context.createRenderTarget(this.size);
            
        if (fixerRenderTarget === FixerRenderTarget.Liquid) {

            ProgramManager.getInstance().fillRectProgram.fill(
                tempRenderTarget,
                {

                    targetRect: partRectByPixel,
                    source: this.liquidRenderTarget.texture,
                    sourceRect: partRectByPixel,
                    canvasRect: canvasRect,
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None

                }

            );

        } else if (fixerRenderTarget === FixerRenderTarget.Dry) {
            
            ProgramManager.getInstance().fillRectProgram.fill(
                tempRenderTarget,
                {

                    targetRect: partRectByPixel,
                    source: this.dryRenderTarget.texture,
                    sourceRect: partRectByPixel,
                    canvasRect: canvasRect,
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None

                }

            );

        } else {

            ProgramManager.getInstance().maskAndCutProgram.fill(
                tempRenderTarget,
                {

                    targetRect: partRectByPixel,
                    drySource: this.dryRenderTarget.texture,
                    liquidSource: this.liquidRenderTarget.texture,
                    maskSource: this.maskLiquidRenderTarget.texture,
                    sourceRect: partRectByPixel,
                    transform: new AffineTransform(),
                    liquidSourceBlendmode: this.liquidLayerBlendmode,
                    canvasRect: canvasRect,
                    opacity: this.layerOpacity,
                    lowCut: this.liquidCutMin,
                    highCut: this.liquidCutMax,
                    wetEdge: this.useLayerWetEdge

                }

            );

        }

        const patchImageUrl = this.context.readPixelsByDataURL(tempRenderTarget, partRectByPixel);
        
        let patchMaskImageUrl: string | undefined;

        if (fixerRenderTarget === FixerRenderTarget.Liquid) {
            
            ProgramManager.getInstance().fillRectProgram.fill(
                tempRenderTarget,
                {

                    targetRect: partRectByPixel,
                    source: this.maskLiquidRenderTarget.texture,
                    sourceRect: partRectByPixel,
                    canvasRect: canvasRect,
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None

                }

            );

            patchMaskImageUrl = this.context.readPixelsByDataURL(tempRenderTarget, partRectByPixel);

        }

        return new Fixer(partRectByPixel, rect, fixerRenderTarget, patchImageUrl, patchMaskImageUrl);

    }
    
    public async fix(fixer: Fixer, toLiquidLayer: boolean): Promise<Rect> {
    
        if (fixer.patchImageUrl === undefined) return new Rect();
        
        const canvasRect = new Rect(0, 0, this.size.width, this.size.height);
        const texture = this.context.createTexture();
        
        await texture.loadFromBase64(fixer.patchImageUrl);
        
        if (toLiquidLayer) {

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
            
            ProgramManager.getInstance().fillRectProgram.fill(
                this.drawingRenderTarget,
                {
    
                    targetRect: fixer.patchRect,
                    source: texture,
                    sourceRect: canvasRect,
                    canvasRect: canvasRect,
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
    
                }
    
            );

            if (fixer.patchMaskImageUrl) {
                
                const maskTexture = this.context.createTexture();
                await maskTexture.loadFromBase64(fixer.patchMaskImageUrl);

                ProgramManager.getInstance().fillRectProgram.fill(
                    this.maskLiquidRenderTarget,
                    {
        
                        targetRect: fixer.patchRect,
                        source: maskTexture,
                        sourceRect: canvasRect,
                        canvasRect: canvasRect,
                        transform: new AffineTransform(),
                        blend: RenderObjectBlend.None
        
                    }
        
                );

                ProgramManager.getInstance().fillRectProgram.fill(
                    this.maskDrawingRenderTarget,
                    {
        
                        targetRect: fixer.patchRect,
                        source: maskTexture,
                        sourceRect: canvasRect,
                        canvasRect: canvasRect,
                        transform: new AffineTransform(),
                        blend: RenderObjectBlend.None
        
                    }
        
                );

            }

        } else {
            
            ProgramManager.getInstance().fillRectProgram.fill(
                this.dryRenderTarget,
                {
    
                    targetRect: fixer.patchRect,
                    source: texture,
                    sourceRect: canvasRect,
                    canvasRect: canvasRect,
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
    
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