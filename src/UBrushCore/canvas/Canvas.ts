import { Size } from "../common/Size";
import { Point } from "../common/Point";
import { Stylus } from "../common/Stylus";
import { LineDriver, LineDriverDelegate } from "../driver/LineDriver";
import { Dot } from "../common/Dot";
import { WGPUContext } from "../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../gpu/webgpu/WGPURenderTarget";
import { DrawingEngine } from "../engine/DrawingEngine";
import { Rect } from "../common/Rect";
import { IBrush, DryType, DotBlendmode, EdgeStyle } from "../common/IBrush";
import { Common } from "../common/Common";
import { AffineTransform } from "../common/AffineTransform";
import { Color } from "../common/Color";
import { WGPUProgramManager } from "../program/webgpu/WGPUProgramManager";
import { RenderObjectBlend } from "../gpu/RenderObject";
import { Fixer, FixerRenderTarget } from "../common/Fixer";
import { FixerGroup } from "../common/FixerGroup";
import { FloodFillTuningMode } from "../program/webgpu/WGPUFloodFillProgram";

export interface CanvasDelegate {
    
    changeRect(canvas: Canvas, rect: Rect): void;
    didReleaseDrawingWithFixerGroup(canvas: Canvas, fixerGroup: FixerGroup): void;
    didDryCanvas(canvas: Canvas): void;

}

export interface CanvasFloodFillResult {
    fixerGroup: FixerGroup | null;
    historyPromise?: Promise<{
        fixerGroup: FixerGroup | null;
        historyMs: number;
        readbackMs: number;
    }>;
    metrics: {
        mode: 'fast-empty' | 'flood';
        iterations: number;
        dispatchIterations: number;
        substeps: number;
        tileSize: number;
        batchSize: number;
        tuningMode: FloodFillTuningMode;
        gpuMs: number;
        sourceCopyMs: number;
        postProcessMs: number;
        historyMs: number;
        readbackMs: number;
        dryMs: number;
        updateMs: number;
        totalMs: number;
        bounds: Rect;
    };
}

export class Canvas implements LineDriverDelegate {

    public outputRenderTarget: WGPURenderTarget;
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
    private strokeBatchingEnabled: boolean = false;
    private lineRect: Rect | null = null;
    private size: Size;
    private context: WGPUContext;
    private alphaLock: boolean = false;
    private alphaMaskRenderTarget?: WGPURenderTarget;
    private transform: AffineTransform = new AffineTransform();
    private hasContent: boolean = false;
    private needsDry: boolean = false;

    constructor(context: WGPUContext, size: Size) {

        this.lineDriver.setDelegate(this);
        this.outputRenderTarget = context.createRenderTarget(size);
        this.size = size;
        this.context = context;
        this.drawingEngine = new DrawingEngine(context, size);

    }

    public getDebuggingTarget(): WGPURenderTarget | undefined {

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

        // Swift parity: alphaSmudgingMode 먼저 → useSecondaryMask 나중 순서로 대입.
        // alphaSmudgingMode setter가 _resyncDynamicBuffersForMode 를 호출하므로
        // useSecondaryMask가 이미 설정된 상태에서 alphaSmudgingMode가 뒤늦게 바뀌면 버퍼 정합성이 깨진다.
        //
        // 가드: useDualTip 이 꺼져 있으면 secondary dot 이 0개라 maskDrawingRenderTarget 이
        // 비어있는데, MaskAndCutProgram 이 mask=0 픽셀을 모두 cut 으로 처리해 화면이 비게 된다.
        // useDualTip 없는 브러시는 useSecondaryMask 효과 자체가 의미 없으므로 무효화한다.
        // (Swift 는 동일 시나리오에서 maskAndCut 이 dualTipBlendmode=Normal 일 때 mask 를 무시해
        //  자동으로 통과되지만, watercolor 류 브러시가 maskDotBlendmode=Normal + useDualTip=true 인
        //  케이스에서 mask 효과가 핵심이므로 셰이더는 건드리지 않는다.)
        this.drawingEngine.alphaSmudgingMode = brush?.alphaSmudgingMode ?? false;
        this.drawingEngine.useSecondaryMask  = (brush?.useSecondaryMask ?? false) && (brush?.useDualTip ?? false);

        if (brush) {
            this.drawingEngine.useSmudging = brush.useSmudging;
            this.drawingEngine.layerLowCut = brush.layerLowCut;
            this.drawingEngine.layerHighCut = brush.layerHighCut;
            this.drawingEngine.useLayerTinting = brush.useLayerTinting;
            this.drawingEngine.edgeStyle = brush.edgeStyle ?? EdgeStyle.NONE;
            this.drawingEngine.dualTipEdgeStyle = brush.dualTipEdgeStyle ?? EdgeStyle.NONE;
            this.drawingEngine.liquidLayerBlendmode = brush.layerBlendmode;
            this.drawingEngine.dotBlendmode = brush.dotBlendmode ?? DotBlendmode.NORMAL;
            this.drawingEngine.maskDotBlendmode = brush.maskDotBlendmode ?? DotBlendmode.NORMAL;

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
            
            WGPUProgramManager.getInstance().fillRectProgram.fill(
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

        // Batch mode: defer flushDots/updateCanvasInRect until endLine.
        // Caller asserts the active brush is non-smudging (smudging is order-sensitive).
        if (this.strokeBatchingEnabled) return;

        const changeRect: Rect | null = this.flushDots();

        if (changeRect) {

            this.updateCanvasInRect(changeRect);
            this.lineRect = Rect.union(this.lineRect ?? changeRect, changeRect);
            this.hasContent = true;
            this.needsDry = true;

        }

    }

    public brushUsesSmudging(): boolean {
        return !!this.brush?.useSmudging;
    }

    public setStrokeBatchingEnabled(value: boolean): void {
        this.strokeBatchingEnabled = value;
    }

    public replaceActiveLineWithStraightLine(start: Point, end: Point, startStylus: Stylus, endStylus: Stylus, options: { disableSmudging?: boolean } = {}): void {
        const distance = Common.distance(start, end);
        const steps = Math.max(1, Math.ceil(distance / 8));
        const samples: Array<{ point: Point; stylus: Stylus }> = [{ point: start, stylus: startStylus }];
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            samples.push({
                point: Common.interpolatePoint(start, end, t),
                stylus: this.interpolateStylus(startStylus, endStylus, t)
            });
        }

        this.replaceActiveLineWithPath(samples, options);
    }

    public replaceActiveLineWithPath(samples: Array<{ point: Point; stylus: Stylus }>, options: { disableSmudging?: boolean; followAcceleration?: number; randomSeed?: number } = {}): void {
        if (samples.length === 0) return;

        const previousLineRect = this.lineRect;
        const previousUseSmudging = this.drawingEngine.useSmudging;

        this.dots = [];
        this.drawingEngine.cancelDrawing();

        if (options.disableSmudging) {
            this.drawingEngine.useSmudging = false;
        }

        let changeRect: Rect | null = null;
        const drawPath = () => {
            const first = samples[0];
            this.lineDriver.moveTo(first.point, first.stylus);

            for (let i = 1; i < samples.length; i++) {
                this.lineDriver.lineTo(samples[i].point, samples[i].stylus);
            }

            const last = samples[samples.length - 1];
            this.lineDriver.endLine(last.point, last.stylus);

            changeRect = this.flushDots();
        };

        const drawWithFollowAcceleration = () => {
            if (options.followAcceleration !== undefined) {
                this.lineDriver.withFollowAcceleration(options.followAcceleration, drawPath);
            } else {
                drawPath();
            }
        };

        try {
            if (options.randomSeed !== undefined) {
                Common.withRandomSeed(options.randomSeed, drawWithFollowAcceleration);
            } else {
                drawWithFollowAcceleration();
            }
        } finally {
            this.drawingEngine.useSmudging = previousUseSmudging;
        }

        const dirtyRect = changeRect
            ? Rect.union(previousLineRect ?? changeRect, changeRect)
            : previousLineRect;

        this.lineRect = changeRect;

        if (dirtyRect) {
            this.updateCanvasInRect(dirtyRect);
            this.hasContent = true;
            this.needsDry = true;
        }
    }

    public async captureActiveLineForStraightening(): Promise<FixerGroup> {
        const fixerGroup = new FixerGroup();
        const rect = Common.stageRect();

        if (this.autoDry) {
            fixerGroup.undoFixer = (await this.drawingEngine.activeMergedFixer(rect)) || undefined;
        } else {
            fixerGroup.undoFixerLiquid = (await this.drawingEngine.activeDrawingFixer(rect)) || undefined;
        }

        return fixerGroup;
    }

    public async prepareActiveLineForStraightening(strokeGroup: FixerGroup): Promise<FixerGroup> {
        const straightenGroup = new FixerGroup();
        const rect = Common.stageRect();

        if (this.autoDry) {
            const curveFixer = (await this.drawingEngine.activeMergedFixer(rect)) || undefined;
            strokeGroup.redoFixer = curveFixer;
            straightenGroup.undoFixer = curveFixer;
            return straightenGroup;
        }

        this.drawingEngine.releaseDrawing();
        const curveFixer = (await this.liquidFixer(rect)) || undefined;
        strokeGroup.redoFixerLiquid = curveFixer;
        straightenGroup.undoFixerLiquid = curveFixer;

        if (strokeGroup.undoFixerLiquid) {
            await this.fix(strokeGroup.undoFixerLiquid, true);
        }

        return straightenGroup;
    }

    public async captureLineStartForStraightening(): Promise<FixerGroup> {
        const fixerGroup = new FixerGroup();
        const rect = Common.stageRect();

        if (this.autoDry) {
            fixerGroup.undoFixer = (await this.fixer(rect)) || undefined;
        } else {
            fixerGroup.undoFixerLiquid = (await this.liquidFixer(rect)) || undefined;
        }

        return fixerGroup;
    }

    public async commitStraightenedLine(fixerGroup: FixerGroup): Promise<FixerGroup> {
        const rect = Common.stageRect();

        if (this.autoDry) {
            this.drawingEngine.releaseDrawing();
            this.engineDry();
            fixerGroup.redoFixer = (await this.fixer(rect)) || undefined;
        } else {
            this.drawingEngine.releaseDrawing();
            fixerGroup.redoFixerLiquid = (await this.liquidFixer(rect)) || undefined;
        }

        this.lineRect = null;
        this.hasContent = true;
        this.needsDry = !this.autoDry;
        this.age++;

        return fixerGroup;
    }

    public async endLine(pt: Point, stylus: Stylus): Promise<void> {

        this.lineDriver.endLine(pt, stylus);

        const changeRect = this.flushDots();

        if (changeRect) {

            this.updateCanvasInRect(changeRect);
            this.lineRect = Rect.union(this.lineRect ?? changeRect, changeRect);
            this.hasContent = true;
            this.needsDry = true;

        }

        if (this.useFixer && this.delegate?.didReleaseDrawingWithFixerGroup) {

            const fixerGroup = new FixerGroup();

            if (this.autoDry) {

                fixerGroup.undoFixer = (await this.fixer(this.lineRect || undefined)) || undefined;
                this.drawingEngine.releaseDrawing();
                this.engineDry();
                fixerGroup.redoFixer = (await this.fixer(this.lineRect || undefined)) || undefined;

            } else {

                fixerGroup.undoFixerLiquid = (await this.liquidFixer(this.lineRect || undefined)) || undefined;
                fixerGroup.undoFixer = (await this.fixer(this.lineRect || undefined)) || undefined;
                this.drawingEngine.releaseDrawing();
                fixerGroup.redoFixerLiquid = (await this.liquidFixer(this.lineRect || undefined)) || undefined;
                fixerGroup.redoFixer = (await this.fixer(this.lineRect || undefined)) || undefined;

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

    public async floodFill(seed: Point, color: Color, tolerance: number, edgeThreshold: number, tuningMode: FloodFillTuningMode = 'auto'): Promise<CanvasFloodFillResult | null> {
        if (this.drawingEngine.alphaSmudgingMode) return null;

        const start = performance.now();
        const dryStart = performance.now();
        if (this.needsDry) this.engineDry();
        const dryMs = performance.now() - dryStart;

        const result = await this.drawingEngine.floodFillDry(seed, color, tolerance, edgeThreshold, !this.hasContent, tuningMode);
        const updateStart = performance.now();
        this.updateCanvasInRect(result.rect);
        const updateMs = performance.now() - updateStart;

        const fixerGroup = new FixerGroup();
        fixerGroup.undoFixer = result.undoFixer;
        fixerGroup.redoFixer = result.redoFixer;
        const hasHistory = !!(fixerGroup.undoFixer && fixerGroup.redoFixer);
        if (hasHistory || result.historyPromise) this.hasContent = true;
        this.age++;

        return {
            fixerGroup: hasHistory ? fixerGroup : null,
            historyPromise: result.historyPromise?.then((history) => {
                if (!history.undoFixer || !history.redoFixer) {
                    return { fixerGroup: null, historyMs: history.historyMs, readbackMs: history.readbackMs };
                }
                const group = new FixerGroup();
                group.undoFixer = history.undoFixer;
                group.redoFixer = history.redoFixer;
                return { fixerGroup: group, historyMs: history.historyMs, readbackMs: history.readbackMs };
            }),
            metrics: {
                ...result.metrics,
                dryMs,
                updateMs,
                totalMs: performance.now() - start,
                bounds: result.pixelBounds
            }
        };
    }

    // image and fixer

    // public swapImage:(UIImage *)image;
    // public swapImage:(UIImage *)image stageRect:(CGRect)stageRect;
    // public swapImage:(UIImage *)image pixelRect:(CGRect)pixelRect;

    // - (UIImage *)image;
    // - (UIImage *)imageForSize:(CGSize)size;
    // - (UIImage *)imageWithStageRect:(CGRect)stageRect;
    // - (UIImage *)imageWithPixelRect:(CGRect)pixelRect;

    public async fix(fixer: Fixer, toLiquidLayer: boolean, update: boolean = true): Promise<void> {

        if (!fixer) return;

        const changeRect = await this.drawingEngine.fix(fixer, toLiquidLayer);
        if (toLiquidLayer) this.needsDry = true;

        if (update && changeRect) {

            this.updateCanvasInRect(changeRect);

        }

        this.age++;

    }

    public async fixStable(fixer: Fixer): Promise<void> {

        if (!fixer) return;

        const changeRect = await this.drawingEngine.fix(fixer, false);
        const pixelCount = fixer.patchRect.size.width * fixer.patchRect.size.height * 4;
        const clearPixels = new Uint8Array(pixelCount);
        const clearLiquidFixer = new Fixer(
            fixer.patchRect,
            fixer.patchStageRect,
            FixerRenderTarget.Liquid,
            clearPixels,
            clearPixels
        );
        await this.drawingEngine.fix(clearLiquidFixer, true);
        this.needsDry = false;

        if (changeRect) {

            this.updateCanvasInRect(changeRect);

        }

        this.age++;

    }

    public async fixer(rect: Rect = Common.stageRect()): Promise<Fixer | null> {

        return this.drawingEngine.fixer(FixerRenderTarget.Merged, rect);

    }

    public async liquidFixer(rect: Rect = Common.stageRect()): Promise<Fixer | null> {

        if (this.autoDry) return null;

        return this.drawingEngine.fixer(FixerRenderTarget.Liquid, rect);

    }

    // function

    public async pixelBoundsForStageRect(): Promise<Rect> {

        const resultRect: Rect = await this.pixelBounds();

        resultRect.origin.x    = (resultRect.origin.x / this.size.width) * 2.0 - 1.0;
        resultRect.origin.y    = (resultRect.origin.y / this.size.height) * 2.0 - 1.0;
        resultRect.size.width  = (resultRect.size.width / this.size.width) * 2.0;
        resultRect.size.height = (resultRect.size.height / this.size.height) * 2.0;

        return resultRect;

    }

    public async pixelBounds(): Promise<Rect> {

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
        this.hasContent = false;
        this.needsDry = false;

        this.age ++;

    }

    public syncFromOutputRenderTarget(): void {

        this.engineSetupWithRenderTarget(this.outputRenderTarget);
        this.updateCanvas();
        this.age++;

    }

    // private

    private flushDots(): Rect | null {

        if (this.dots.length === 0) return null;

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

            WGPUProgramManager.getInstance().maskProgram.fill(
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

    private engineSetupWithRenderTarget(renderTarget: WGPURenderTarget): void {

        this.drawingEngine.setupWithRenderTarget(renderTarget);
        this.needsDry = false;

        if (this.delegate?.didDryCanvas) {

            this.delegate.didDryCanvas(this);

        }

    }

    private engineDry(): void {

        this.drawingEngine.dry();
        this.needsDry = false;

        if (this.delegate?.didDryCanvas) {

            this.delegate.didDryCanvas(this);

        }
        
    }

    // LineDriverDelegate

    public lineDriverMakeDot(dot: Dot): void {

        this.dots.push(dot);

    }

    private interpolateStylus(a: Stylus, b: Stylus, t: number): Stylus {
        const interpolate = (start: number, end: number): number => {
            if (!Number.isFinite(start) || !Number.isFinite(end)) return end;
            return start + (end - start) * t;
        };

        return new Stylus(
            interpolate(a.pressure, b.pressure),
            interpolate(a.altitudeAngle, b.altitudeAngle),
            interpolate(a.azimuthAngle, b.azimuthAngle)
        );
    }

}
