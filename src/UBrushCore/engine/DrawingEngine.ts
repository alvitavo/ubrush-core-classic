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
import { LayerBlendmode } from "../common/IBrush";
import { Color } from "../common/Color";

const maxSmudgingLength = 1000;

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

    public drawingRenderTarget: RenderTarget; //최초에 그림이 그려지는 버퍼
    public smudging1CopyRenderTarget: RenderTarget; //스머징을 위해 실시간으로 레이어의 최종모습을 복사해두는 버퍼
    public smudging0CopyRenderTarget: RenderTarget; //
    public liquidRenderTarget: RenderTarget; //liquid 효과의 undo를 위해 drawing이 끝난후 릴리즈 하는 버퍼
    public dryRenderTarget: RenderTarget; //dry명령후 liquid 레이어의 내용을 픽스하는 버퍼 

    // layer effect
    public layerOpacity: number = 1;
    public useLayerTinting: boolean = false;
    public useLayerWetEdge: boolean = false;
    public liquidLayerBlendmode: LayerBlendmode | string = LayerBlendmode.NORMAL;
    public brushColor: Color = new Color();

    constructor(context: UBrushContext, size: Size) {

        this.size = size;

        this.drawingRenderTarget = context.createRenderTarget(size);
        this.smudging1CopyRenderTarget = context.createRenderTarget(size);
        this.smudging0CopyRenderTarget = context.createRenderTarget(size);
        this.liquidRenderTarget = context.createRenderTarget(size);
        this.dryRenderTarget = context.createRenderTarget(size);

        this.tipTexture = context.createTexture();
        this.patternTexture = context.createTexture();
        this.dualTipTexture = context.createTexture();

        this.context = context;

    }

    public destroy(): void {

        // TODO: delete drawingRenderTarget ...

    }

    public set useSmudging(value: boolean) {

        this._useSmudging = value;
        this.smudging0Dot = undefined;
        this.smudgingDot = undefined;
        
    }

    public get useSmudging(): boolean {

        return this._useSmudging;
        
    }

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
    
    public setupWithRenderTarget(renderTarget: RenderTarget): void {

        this.context.clearRenderTarget(this.liquidRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.drawingRenderTarget, Color.clear());
        
        ProgramManager.getInstance().fillRectProgram.fill(
            this.dryRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: renderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );

        ProgramManager.getInstance().fillRectProgram.fill(
            this.smudging0CopyRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: renderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );

        ProgramManager.getInstance().fillRectProgram.fill(
            this.smudging1CopyRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: renderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );
        
    }

    public drawDots(dots: Dot[]): Rect | null {

        if (this.useSmudging) {

            let n = 0;

            let rect: Rect | null = null;

            while (n < dots.length) {

                const pack: Dot[] = [];

                for (let i = 0; i < maxSmudgingLength; i++) {

                    if (n < dots.length) pack.push(dots[n ++]);

                }

                const partsRect: Rect | null = this.renderMultiDots(pack);

                if (partsRect) {

                    rect = Rect.union(rect ?? partsRect, partsRect);

                }
                
            }

            return rect;
            
        } else {

            return this.renderMultiDots(dots);

        }
        
    }

    public printToRenderTarget(renderTarget: RenderTarget, rect: Rect, transform: AffineTransform): void {
    
        ProgramManager.getInstance().highLowCutProgram.fill(
            renderTarget,
            {

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
                wetEdge: this.useLayerWetEdge

            }

        );

    }

    public releaseDrawing() {

        this.smudging0Dot = undefined;
        this.smudgingDot = undefined;
    
        ProgramManager.getInstance().fillRectProgram.fill(
            this.liquidRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: this.drawingRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );
        
    }

    public cancelDrawing() {
    
        ProgramManager.getInstance().fillRectProgram.fill(
            this.drawingRenderTarget,
            {

                targetRect: Common.stageRect(),
                source: this.liquidRenderTarget.texture,
                sourceRect: Common.stageRect(),
                canvasRect: Common.stageRect(),
                transform: new AffineTransform(),
                blend: RenderObjectBlend.None

            }

        );

    }

    public dry() {

        const tempRenderTarget = this.context.createRenderTarget(this.size);

        ProgramManager.getInstance().highLowCutProgram.fill(
            tempRenderTarget,
            {

                targetRect: Common.stageRect(),
                drySource: this.dryRenderTarget.texture,
                liquidSource: this.liquidRenderTarget.texture,
                sourceRect: Common.stageRect(),
                transform: new AffineTransform(),
                liquidSourceBlendmode: this.liquidLayerBlendmode,
                canvasRect: Common.stageRect(),
                opacity: this.layerOpacity,
                lowCut: this.liquidCutMin,
                highCut: this.liquidCutMax,
                liquidColor: this.brushColor,
                liquidTinting: this.useLayerTinting,
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

        if (this.useSmudging) {

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging0CopyRenderTarget,
                {

                    targetRect: Common.stageRect(),
                    source: this.dryRenderTarget.texture,
                    sourceRect: Common.stageRect(),
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
                }

            );

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
        this.context.clearRenderTarget(this.smudging0CopyRenderTarget, Color.clear());
        this.context.clearRenderTarget(this.smudging1CopyRenderTarget, Color.clear());

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

            ProgramManager.getInstance().highLowCutProgram.fill(
                tempRenderTarget,
                {

                    targetRect: partRectByPixel,
                    drySource: this.dryRenderTarget.texture,
                    liquidSource: this.liquidRenderTarget.texture,
                    sourceRect: partRectByPixel,
                    transform: new AffineTransform(),
                    liquidSourceBlendmode: this.liquidLayerBlendmode,
                    canvasRect: canvasRect,
                    opacity: this.layerOpacity,
                    lowCut: this.liquidCutMin,
                    highCut: this.liquidCutMax,
                    liquidColor: this.brushColor,
                    liquidTinting: this.useLayerTinting,
                    wetEdge: this.useLayerWetEdge

                }

            );

        }

        const patchImageUrl = this.context.readPixelsByDataURL(tempRenderTarget, partRectByPixel);

        return new Fixer(partRectByPixel, rect, fixerRenderTarget, patchImageUrl);

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

        if (this.useSmudging) {
            
            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging1CopyRenderTarget,
                {
    
                    targetRect: canvasRect,
                    source: this.dryRenderTarget.texture,
                    sourceRect: canvasRect,
                    canvasRect: canvasRect,
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
    
                }
    
            );

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging1CopyRenderTarget,
                {
    
                    targetRect: canvasRect,
                    source: this.drawingRenderTarget.texture,
                    sourceRect: canvasRect,
                    canvasRect: canvasRect,
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.Normal
    
                }
    
            );

            ProgramManager.getInstance().fillRectProgram.fill(
                this.smudging0CopyRenderTarget,
                {
    
                    targetRect: canvasRect,
                    source: this.smudging1CopyRenderTarget.texture,
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

    // protected

    protected renderMultiDots(dots: Dot[]): Rect | null {

        if (dots.length === 0) {

            return null;
        
        }

        let rect: Rect | null = null;

        const firstDot: Dot = dots[0];
        const lastDot: Dot = dots[dots.length - 1];
        this.layerOpacity = firstDot.layerOpacity;

        if (this.useSmudging) {

            if (this.smudgingDot === undefined) {

                this.smudging0Dot = firstDot;
                this.smudgingDot = firstDot;

            }

            rect = this.renderDots(dots, false);

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
                this.smudging0CopyRenderTarget,
                {
    
                    targetRect: rect,
                    source: this.smudging1CopyRenderTarget.texture,
                    sourceRect: rect,
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
    
                }
    
            );

            ProgramManager.getInstance().highLowCutProgram.fill(
                this.smudging1CopyRenderTarget,
                {

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
                    wetEdge: this.useLayerWetEdge

                }

            );

            // ProgramManager.getInstance().fillRectProgram.fill(
            //     this.smudging0CopyRenderTarget,
            //     {
    
            //         targetRect: Common.stageRect(),
            //         source: this.smudging1CopyRenderTarget.texture,
            //         sourceRect: Common.stageRect(),
            //         canvasRect: Common.stageRect(),
            //         transform: new AffineTransform(),
            //         blend: RenderObjectBlend.None
    
            //     }
    
            // );

            // ProgramManager.getInstance().highLowCutProgram.fill(
            //     this.smudging1CopyRenderTarget,
            //     {

            //         targetRect: Common.stageRect(),
            //         drySource: this.dryRenderTarget.texture,
            //         liquidSource: this.drawingRenderTarget.texture,
            //         sourceRect: Common.stageRect(),
            //         transform: new AffineTransform(),
            //         liquidSourceBlendmode: this.liquidLayerBlendmode,
            //         canvasRect: Common.stageRect(),
            //         opacity: this.layerOpacity,
            //         lowCut: this.liquidCutMin,
            //         highCut: this.liquidCutMax,
            //         liquidColor: this.brushColor,
            //         liquidTinting: this.useLayerTinting,
            //         wetEdge: this.useLayerWetEdge

            //     }

            // );

        }

        return rect;

    }

    protected renderDots(dots: Dot[], useDualTip: boolean): Rect | null {

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

        let rectX1: number = Infinity;
        let rectX2: number = -Infinity;
        let rectY1: number = Infinity;
        let rectY2: number = -Infinity;

        for (let i = 0; i < numberOfDots; i++) {

            const dot: Dot = dots[i];

            const dhw: number = dot.width * 0.5;
            const dhh: number = dot.height * 0.5;

            const sinR: number = Math.sin(dot.rotation); //+ => clockwise
            const conR: number = Math.cos(dot.rotation);
            const xsinR: number = dhw * sinR;
            const ysinR: number = dhh * sinR;
            const xcosR: number = dhw * conR;
            const ycosR: number = dhh * conR;

            let rp1: Point = new Point(dot.centerX - xcosR + ysinR, dot.centerY - xsinR - ycosR);
            let rp2: Point = new Point(dot.centerX + xcosR + ysinR, dot.centerY + xsinR - ycosR);
            let rp3: Point = new Point(dot.centerX - xcosR - ysinR, dot.centerY - xsinR + ycosR);
            let rp4: Point = new Point(dot.centerX + xcosR - ysinR, dot.centerY + xsinR + ycosR);

            let p1: Point = Common.pointInStage(rp1, this.size);
            let p2: Point = Common.pointInStage(rp2, this.size);
            let p3: Point = Common.pointInStage(rp3, this.size);
            let p4: Point = Common.pointInStage(rp4, this.size);

            points[i * 8 + 0] = p1.x;
            points[i * 8 + 1] = p1.y;
            points[i * 8 + 2] = p2.x;
            points[i * 8 + 3] = p2.y;
            points[i * 8 + 4] = p3.x;
            points[i * 8 + 5] = p3.y;
            points[i * 8 + 6] = p4.x;
            points[i * 8 + 7] = p4.y;

            rectX1 = Math.min(rectX1, Math.min(p1.x, Math.min(p2.x, Math.min(p3.x, p4.x))));
            rectX2 = Math.max(rectX2, Math.max(p1.x, Math.max(p2.x, Math.max(p3.x, p4.x))));
            rectY1 = Math.min(rectY1, Math.min(p1.y, Math.min(p2.y, Math.min(p3.y, p4.y))));
            rectY2 = Math.max(rectY2, Math.max(p1.y, Math.max(p2.y, Math.max(p3.y, p4.y))));
            
            //tip
            tipTextureCoordinates[i * 8 + 0] = dot.textureL;
            tipTextureCoordinates[i * 8 + 1] = dot.textureT;
            tipTextureCoordinates[i * 8 + 2] = dot.textureR;
            tipTextureCoordinates[i * 8 + 3] = dot.textureT;
            tipTextureCoordinates[i * 8 + 4] = dot.textureL;
            tipTextureCoordinates[i * 8 + 5] = dot.textureB;
            tipTextureCoordinates[i * 8 + 6] = dot.textureR;
            tipTextureCoordinates[i * 8 + 7] = dot.textureB;

            //pattern
            const patternSize: Size = new Size((dot.patternWidth > 0) ? dot.patternWidth : this.size.width, (dot.patternHeight > 0) ? dot.patternHeight : this.size.height);

            p1 = Common.pointInTexture(rp1, patternSize);
            p2 = Common.pointInTexture(rp2, patternSize);
            p3 = Common.pointInTexture(rp3, patternSize);
            p4 = Common.pointInTexture(rp4, patternSize);

            const patternOffsetX: number = dot.patternOffsetX;
            const patternOffsetXcomplement: number = 1.0 - patternOffsetX;

            const patternOffsetY: number = dot.patternOffsetY;
            const patternOffsetYcomplement: number = 1.0 - patternOffsetY;

            patternTextureCoordinates[i * 8 + 0] = p1.x * patternOffsetX + tipTextureCoordinates[i * 8 + 0] * patternOffsetXcomplement;
            patternTextureCoordinates[i * 8 + 1] = p1.y * patternOffsetY + tipTextureCoordinates[i * 8 + 1] * patternOffsetYcomplement;
            patternTextureCoordinates[i * 8 + 2] = p2.x * patternOffsetX + tipTextureCoordinates[i * 8 + 2] * patternOffsetXcomplement;
            patternTextureCoordinates[i * 8 + 3] = p2.y * patternOffsetY + tipTextureCoordinates[i * 8 + 3] * patternOffsetYcomplement;
            patternTextureCoordinates[i * 8 + 4] = p3.x * patternOffsetX + tipTextureCoordinates[i * 8 + 4] * patternOffsetXcomplement;
            patternTextureCoordinates[i * 8 + 5] = p3.y * patternOffsetY + tipTextureCoordinates[i * 8 + 5] * patternOffsetYcomplement;
            patternTextureCoordinates[i * 8 + 6] = p4.x * patternOffsetX + tipTextureCoordinates[i * 8 + 6] * patternOffsetXcomplement;
            patternTextureCoordinates[i * 8 + 7] = p4.y * patternOffsetY + tipTextureCoordinates[i * 8 + 7] * patternOffsetYcomplement;

            //smudging

            if (this.useSmudging && this.smudgingDot && this.smudging0Dot) {

                const sinR: number = Math.sin(this.smudgingDot.rotation); //+ => clockwise
                const conR: number = Math.cos(this.smudgingDot.rotation);
                const xsinR: number = dhw * sinR;
                const ysinR: number = dhh * sinR;
                const xcosR: number = dhw * conR;
                const ycosR: number = dhh * conR;

                rp1 = new Point(this.smudgingDot.centerX - xcosR + ysinR, this.smudgingDot.centerY - xsinR - ycosR);
                rp2 = new Point(this.smudgingDot.centerX + xcosR + ysinR, this.smudgingDot.centerY + xsinR - ycosR);
                rp3 = new Point(this.smudgingDot.centerX - xcosR - ysinR, this.smudgingDot.centerY - xsinR + ycosR);
                rp4 = new Point(this.smudgingDot.centerX + xcosR - ysinR, this.smudgingDot.centerY + xsinR + ycosR);

                p1 = Common.pointInTexture(rp1, this.size);
                p2 = Common.pointInTexture(rp2, this.size);
                p3 = Common.pointInTexture(rp3, this.size);
                p4 = Common.pointInTexture(rp4, this.size);

                smudgingTexturePositions[i * 8 + 0] = p1.x;
                smudgingTexturePositions[i * 8 + 1] = p1.y;
                smudgingTexturePositions[i * 8 + 2] = p2.x;
                smudgingTexturePositions[i * 8 + 3] = p2.y;
                smudgingTexturePositions[i * 8 + 4] = p3.x;
                smudgingTexturePositions[i * 8 + 5] = p3.y;
                smudgingTexturePositions[i * 8 + 6] = p4.x;
                smudgingTexturePositions[i * 8 + 7] = p4.y;

                rp1 = new Point(this.smudging0Dot.centerX - xcosR + ysinR, this.smudging0Dot.centerY - xsinR - ycosR);
                rp2 = new Point(this.smudging0Dot.centerX + xcosR + ysinR, this.smudging0Dot.centerY + xsinR - ycosR);
                rp3 = new Point(this.smudging0Dot.centerX - xcosR - ysinR, this.smudging0Dot.centerY - xsinR + ycosR);
                rp4 = new Point(this.smudging0Dot.centerX + xcosR - ysinR, this.smudging0Dot.centerY + xsinR + ycosR);

                p1 = Common.pointInTexture(rp1, this.size);
                p2 = Common.pointInTexture(rp2, this.size);
                p3 = Common.pointInTexture(rp3, this.size);
                p4 = Common.pointInTexture(rp4, this.size);
                
                smudging0TexturePositions[i * 8 + 0] = p1.x;
                smudging0TexturePositions[i * 8 + 1] = p1.y;
                smudging0TexturePositions[i * 8 + 2] = p2.x;
                smudging0TexturePositions[i * 8 + 3] = p2.y;
                smudging0TexturePositions[i * 8 + 4] = p3.x;
                smudging0TexturePositions[i * 8 + 5] = p3.y;
                smudging0TexturePositions[i * 8 + 6] = p4.x;
                smudging0TexturePositions[i * 8 + 7] = p4.y;

            } else {

                smudgingTexturePositions[i * 8 + 0] = 0.0;
                smudgingTexturePositions[i * 8 + 1] = 0.0;
                smudgingTexturePositions[i * 8 + 2] = 0.0;
                smudgingTexturePositions[i * 8 + 3] = 0.0;
                smudgingTexturePositions[i * 8 + 4] = 0.0;
                smudgingTexturePositions[i * 8 + 5] = 0.0;
                smudgingTexturePositions[i * 8 + 6] = 0.0;
                smudgingTexturePositions[i * 8 + 7] = 0.0;

                smudging0TexturePositions[i * 8 + 0] = 0.0;
                smudging0TexturePositions[i * 8 + 1] = 0.0;
                smudging0TexturePositions[i * 8 + 2] = 0.0;
                smudging0TexturePositions[i * 8 + 3] = 0.0;
                smudging0TexturePositions[i * 8 + 4] = 0.0;
                smudging0TexturePositions[i * 8 + 5] = 0.0;
                smudging0TexturePositions[i * 8 + 6] = 0.0;
                smudging0TexturePositions[i * 8 + 7] = 0.0;

            }

            //index
            indexData[i * 6 + 0] = i * 4 + 0;
            indexData[i * 6 + 1] = i * 4 + 1;
            indexData[i * 6 + 2] = i * 4 + 2;
            indexData[i * 6 + 3] = i * 4 + 3;
            indexData[i * 6 + 4] = i * 4 + 2;
            indexData[i * 6 + 5] = i * 4 + 1;

            //color //opacity
            for (let j = 0; j < 4; j++) {

                colors[i * 16 + j * 4 + 0] = dot.tintRed;               //red
                colors[i * 16 + j * 4 + 1] = dot.tintGreen;             //green
                colors[i * 16 + j * 4 + 2] = dot.tintBlue;              //blue
                colors[i * 16 + j * 4 + 3] = dot.tinting;               //alpha

                opacities[i * 16 + j * 4 + 0] = dot.opacity;            //
                opacities[i * 16 + j * 4 + 1] = dot.patternOpacity;     //
                opacities[i * 16 + j * 4 + 2] = dot.mixingOpacity;      //
                opacities[i * 16 + j * 4 + 3] = i / numberOfDots;       //

            }
        }

        this.excuteDotProgram({

            points: points,
            indexData: indexData,
            tipTextureCoordinates: tipTextureCoordinates,
            patternTextureCoordinates: patternTextureCoordinates,
            smudging0TexturePositions: smudging0TexturePositions,
            smudgingTexturePositions: smudgingTexturePositions,
            colors: colors,
            opacities: opacities,
            numberOfPoints: 6 * numberOfDots,
            useDualTip: useDualTip

        });

        return new Rect(rectX1, rectY1, rectX2 - rectX1, rectY2 - rectY1);

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

        ProgramManager.getInstance().drawDotProgram.drawRects(this.drawingRenderTarget, {

            tipTexture: this.tipTexture,
            patternTexture: this.patternTexture,
            smudging0Texture: this.smudging0CopyRenderTarget.texture,
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

}