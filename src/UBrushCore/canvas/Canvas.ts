import { Size } from "../common/Size";
import { Point } from "../common/Point";
import { Stylus } from "../common/Stylus";
import { LineDriver, LineDriverDelegate } from "../driver/LineDriver";
import { Dot } from "../common/Dot";
import { UBrushContext } from "../gpu/UBrushContext";
import { RenderTarget } from "../gpu/RenderTarget";
import { DrawingEngine, DrawingMode } from "../engine/DrawingEngine";
import { Rect } from "../common/Rect";
import { IBrush, DryType } from "../common/IBrush";
import { Common } from "../common/Common";
import { AffineTransform } from "../common/AffineTransform";
import { Color } from "../common/Color";
import { ProgramManager } from "../program/ProgramManager";
import { RenderObjectBlend } from "../gpu/RenderObject";
import { Fixer, FixerRenderTarget } from "../common/Fixer";
import { FixerGroup } from "../common/FixerGroup";

export interface CanvasDelegate {
    
    changeRect(canvas: Canvas, rect: Rect): void;
    didReleaseDrawingWithFixerGroup(canvas: Canvas, fixerGroup: FixerGroup): void;
    didDryCanvas(canvas: Canvas): void;

}

export class Canvas implements LineDriverDelegate {

    public outputRenderTarget: RenderTarget;
    public useFixer: boolean = true;
    public age: number = 0;
    public brush?: IBrush;
    public delegate?: CanvasDelegate;
    public readonly lineDriver: LineDriver = new LineDriver();

    // flag
    public selected: boolean = false;
    public temporary: boolean = false;

    private autoDry: boolean = false;
    private drawingEngine: DrawingEngine;
    private dots: Dot[] = [];
    private lineRect: Rect | null = null;
    private size: Size;
    private context: UBrushContext;
    private alphaLock: boolean = false;
    private alphaMaskRenderTarget?: RenderTarget;
    private transform: AffineTransform = new AffineTransform();
    
    constructor(context: UBrushContext, size: Size) {

        this.lineDriver.setDelegate(this);
        this.outputRenderTarget = context.createRenderTarget(size);
        this.size = size;
        this.context = context;
        this.drawingEngine = new DrawingEngine(context, size);

    }

    public getDebuggingTarget(): RenderTarget | undefined {

        return this.drawingEngine.debuggingRenderTarget;

    }

    public debugging(pt: Point, size: number = 20) {

        const dot = new Dot();
        dot.prepareX = pt.x;
        dot.prepareY = pt.y;
        dot.prepareSize = size;
        dot.prepareProgressLength = 0;
        dot.prepareLevel = 0;
        dot.preparePressure = NaN;
        dot.prepareAltitudeAngle = NaN;
        dot.prepareAzimuthAngle = NaN;
        dot.centerX = pt.x;
        dot.centerY = pt.y;
        dot.width = size;
        dot.height = size;
        dot.isMask = false;
        dot.textureL = 0;
        dot.textureR = 1;
        dot.textureT = 0;
        dot.textureB = 1;
        dot.rotation = 0;
        dot.patternOffsetX = 1;
        dot.patternOffsetY = 1;
        dot.patternWidth = 128;
        dot.patternHeight = 128;
        dot.layerOpacity = 1;
        dot.opacity = 1;
        dot.mixingOpacity = 0;
        dot.patternOpacity = 0;
        dot.tintRed = 0;
        dot.tintGreen = 0;
        dot.tintBlue = 0;
        dot.tinting = 1;

        this.dots.push(dot);

    }

    public async setBrush(brush?: IBrush): Promise<void> {

        if (this.brush === brush) return;

        this.brush = brush;

        this.lineDriver.setBrush(brush);

        const mode: DrawingMode = brush?.alphaSmudgingMode ? 'smudging'
            : brush?.useSecondaryMask ? 'water'
            : 'basic';
        this.drawingEngine.mode = mode;

        if (brush) {
            this.drawingEngine.useSmudging = brush.useSmudging;
            this.drawingEngine.layerLowCut = brush.layerLowCut;
            this.drawingEngine.layerHighCut = brush.layerHighCut;
            this.drawingEngine.useLayerTinting = brush.useLayerTinting;
            this.drawingEngine.useLayerWetEdge = brush.useLayerWetEdge;
            this.drawingEngine.liquidLayerBlendmode = brush.layerBlendmode;

            await this.drawingEngine.setTipTextureImageBase64(brush.tipSource);
            await this.drawingEngine.setDualTipTextureImageBase64(brush.dualTipSource);
            await this.drawingEngine.setPatternTextureImageBase64(brush.textureSource);

            this.drawingEngine.layerOpacity = 1;
            this.drawingEngine.brushColor = this.lineDriver.getColor();
        }

        this.engineSetupWithRenderTarget(this.outputRenderTarget);

        this.autoDry = (brush?.dryType === DryType.AUTO);

    }

    public setAlphaLock(alphaLock: boolean): void {
        
        this.alphaLock = alphaLock;

        if (this.alphaMaskRenderTarget) {

            this.context.deleteRenderTarget(this.alphaMaskRenderTarget);
            this.alphaMaskRenderTarget = undefined;

        }
        
        if (alphaLock) {

            this.alphaMaskRenderTarget = this.context.createRenderTarget(this.size);
            
            ProgramManager.getInstance().fillRectProgram.fill(
                this.alphaMaskRenderTarget,
                {
                    targetRect: Common.stageRect(),
                    source: this.outputRenderTarget.texture,
                    sourceRect: Common.stageRect(),
                    canvasRect: Common.stageRect(),
                    transform: new AffineTransform(),
                    blend: RenderObjectBlend.None
                }
            );

        } else {

            this.engineSetupWithRenderTarget(this.outputRenderTarget);

        }

    }

    public updateCanvas(): void {

        this.updateCanvasInRect(Common.stageRect());

    }

    public updateCanvasInRect(rect: Rect): void {

        this.drawRect(rect);
        
        if (this.delegate?.changeRect) {

            this.delegate.changeRect(this, rect);

        }

    }

    public clearOutputRenderTarget(): void {

        this.context.clearRenderTarget(this.outputRenderTarget, Color.clear());

    }
    
    // tansform

    public setTransform(transform: AffineTransform): void {

        this.transform = transform;

    }

    public clearTransform(): void {

        this.transform.set();
    
        this.engineSetupWithRenderTarget(this.outputRenderTarget);
        this.updateCanvas();
        
        this.age ++;

    }

    // drawing

    public moveTo(pt: Point, stylus: Stylus): void {

        this.lineDriver.moveTo(pt, stylus);

    }
    
    public lineTo(pt: Point, stylus: Stylus): void {

        this.lineDriver.lineTo(pt, stylus);

        const changeRect: Rect | null = this.flushDots();
        
        if (changeRect) {
            
            this.updateCanvasInRect(changeRect);
            this.lineRect = Rect.union(this.lineRect ?? changeRect, changeRect);
            
        }

    }

    public endLine(pt: Point, stylus: Stylus): void {

        this.lineDriver.endLine(pt, stylus);

        const changeRect = this.flushDots();

        if (changeRect) {
            
            this.updateCanvasInRect(changeRect);
            this.lineRect = Rect.union(this.lineRect ?? changeRect, changeRect);

        }
        
        if (this.useFixer && this.delegate?.didReleaseDrawingWithFixerGroup) {

            const fixerGroup = new FixerGroup();
            
            if (this.autoDry) {

                fixerGroup.undoFixer = this.fixer(this.lineRect || undefined) || undefined;
                this.drawingEngine.releaseDrawing();
                this.engineDry();

            } else {

                fixerGroup.undoFixerLiquid = this.liquidFixer(this.lineRect || undefined) || undefined;
                fixerGroup.undoFixer = this.fixer(this.lineRect || undefined) || undefined;
                this.drawingEngine.releaseDrawing();

            }

            this.delegate.didReleaseDrawingWithFixerGroup(this, fixerGroup);

        } else {

            if (this.autoDry) {

                this.drawingEngine.releaseDrawing();
                this.engineDry();

            } else {

                this.drawingEngine.releaseDrawing();

            }
        }
        
        this.lineRect = null;
        this.age ++;

    }

    public cancelLine(): void {

        this.drawingEngine.cancelDrawing();
    
        if (this.lineRect) {
            this.updateCanvasInRect(this.lineRect);
        }

        this.lineRect = null;
        
    }

    public dry(): void {

        this.engineDry();

    }

    // image and fixer

    // public swapImage:(UIImage *)image;
    // public swapImage:(UIImage *)image stageRect:(CGRect)stageRect;
    // public swapImage:(UIImage *)image pixelRect:(CGRect)pixelRect;

    // - (UIImage *)image;
    // - (UIImage *)imageForSize:(CGSize)size;
    // - (UIImage *)imageWithStageRect:(CGRect)stageRect;
    // - (UIImage *)imageWithPixelRect:(CGRect)pixelRect;

    public async fix(fixer: Fixer, toLiquidLayer: boolean): Promise<void> {

        if (!fixer) return;

        const changeRect = await this.drawingEngine.fix(fixer, toLiquidLayer);

        if (changeRect) {

            this.updateCanvasInRect(changeRect);

        }

        this.age++;

    }

    public fixer(rect: Rect = Common.stageRect()): Fixer | null {

        return this.drawingEngine.fixer(FixerRenderTarget.Merged, rect);

    }

    public liquidFixer(rect: Rect = Common.stageRect()): Fixer | null {

        if (this.autoDry) return null;

        return this.drawingEngine.fixer(FixerRenderTarget.Liquid, rect);

    }

    // function

    public pixelBoundsForStageRect(): Rect {

        const resultRect: Rect = this.pixelBounds();
    
        resultRect.origin.x    = (resultRect.origin.x / this.size.width) * 2.0 - 1.0;
        resultRect.origin.y    = (resultRect.origin.y / this.size.height) * 2.0 - 1.0;
        resultRect.size.width  = (resultRect.size.width / this.size.width) * 2.0;
        resultRect.size.height = (resultRect.size.height / this.size.height) * 2.0;
        
        return resultRect;

    }

    public pixelBounds(): Rect {

        return this.context.pixelBound(this.outputRenderTarget);
        
    }

    public setColor(color: Color): void {

        if (this.drawingEngine) {
            
            if (this.drawingEngine.useLayerTinting) {

                this.engineDry();
    
            }

            this.drawingEngine.brushColor = color.clone();

        }
        
        this.lineDriver.setColor(color.clone());

    }

    public clear(): void {

        this.clearOutputRenderTarget();
        this.drawingEngine.clear();
        this.updateCanvas();
        
        this.age ++;

    }

    // private

    private flushDots(): Rect | null {

        if (!this.brush) {
            this.dots = [];
            return null;
        }

        const changedRect: Rect | null = this.drawingEngine.drawDots(this.dots);
        this.dots = [];

        return changedRect;

    }

    private drawRect(rect: Rect): void {

        if (this.alphaLock) {

            const tempRenderTarget = this.context.createRenderTarget(this.size);

            this.drawingEngine.printToRenderTarget(tempRenderTarget, rect, new AffineTransform());

            ProgramManager.getInstance().maskProgram.fill(
                this.outputRenderTarget,
                {

                    targetRect: rect,
                    source: tempRenderTarget.texture,
                    maskSource: this.alphaMaskRenderTarget!.texture,
                    sourceRect: rect,
                    transform: this.transform, 
                    canvasRect: Common.stageRect()

                }

            );

            this.context.deleteRenderTarget(tempRenderTarget);

        } else {
            
            this.drawingEngine.printToRenderTarget(this.outputRenderTarget, rect, new AffineTransform());

        }

    }

    // -----------------------------

    private engineSetupWithRenderTarget(renderTarget: RenderTarget): void {

        this.drawingEngine.setupWithRenderTarget(renderTarget);

        if (this.delegate?.didDryCanvas) {

            this.delegate.didDryCanvas(this);

        }

    }

    private engineDry(): void {

        this.drawingEngine.dry();

        if (this.delegate?.didDryCanvas) {

            this.delegate.didDryCanvas(this);

        }
        
    }

    // LineDriverDelegate

    public lineDriverMakeDot(dot: Dot): void {

        this.dots.push(dot);

    }

}