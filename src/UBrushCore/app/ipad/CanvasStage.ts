import { Canvas, CanvasFloodFillResult } from '../../canvas/Canvas';
import { Color } from '../../common/Color';
import { Common } from '../../common/Common';
import { Point } from '../../common/Point';
import { Size } from '../../common/Size';
import { Stylus } from '../../common/Stylus';
import { RenderObjectBlend } from '../../gpu/RenderObject';
import { WGPUContext } from '../../gpu/webgpu/WGPUContext';
import { bootstrapWebGPU } from '../../gpu/webgpu/bootstrap';
import { WGPUProgramManager } from '../../program/webgpu/WGPUProgramManager';
import { AffineTransform } from '../../common/AffineTransform';
import { DocumentController } from './controllers/DocumentController';
import { FixerGroup } from '../../common/FixerGroup';
import { Rect } from '../../common/Rect';
import { Fixer } from '../../common/Fixer';
import { FloodFillTuningMode } from '../../program/webgpu/WGPUFloodFillProgram';

const STRAIGHTEN_MORPH_MS = 180;
const SHAPE_ASSIST_EDIT_MORPH_MS = 90;
const SHAPE_ASSIST_HOLD_MS = 1200;

interface StrokeSample {
    point: Point;
    stylus: Stylus;
}

type ShapeAssistMode = 'line' | 'bezier' | 'fit' | 'polyline' | 'ellipse' | 'circle';

interface ShapeAssistHandles {
    start: Point;
    control1: Point;
    control2: Point;
    end: Point;
    anchors: Point[];
}

type ShapeAssistHandleKey = 'start' | 'control1' | 'control2' | 'end' | 'ellipseCenter' | `anchor:${number}`;

interface ShapeAssistSnapshot {
    mode: ShapeAssistMode;
    handles: ShapeAssistHandles;
    randomSeed: number;
}

interface FloodFillSnapshot {
    tolerance: number;
    edgeSensitivity: number;
}

export interface CanvasStageDelegate {
    stageDidCreateDocument(document: DocumentController): void;
    stageDidFail(error: string): void;
}

export class CanvasStage {
    public readonly element = document.createElement('div');
    public readonly canvas = document.createElement('canvas');

    private context?: WGPUContext;
    private document?: DocumentController;
    private canvasSize = new Size(1, 1);
    private lastPoint = new Point();
    private lastStylus = new Stylus();
    private stylusEventCount = 0;
    private resizeObserver?: ResizeObserver;
    private straightLineTimer: number | null = null;
    private straightLineToken = 0;
    private straightLinePreviewActive = false;
    private straightLineActivating = false;
    private straightLineActivationPromise: Promise<void> | null = null;
    private straightLineStartPos: Point | null = null;
    private straightLineStartStylus: Stylus | null = null;
    private straightLineSamples: StrokeSample[] = [];
    private straightLineStrokeGroup: FixerGroup | null = null;
    private straightLineUndoGroup: FixerGroup | null = null;
    private shapeAssistCurveSamples: StrokeSample[] = [];
    private shapeAssistMode: ShapeAssistMode = 'line';
    private shapeAssistHandles: ShapeAssistHandles | null = null;
    private shapeAssistEditingContext = false;
    private shapeAssistRibbonEl: HTMLElement | null = null;
    private shapeAssistHandlesEl: HTMLElement | null = null;
    private shapeAssistDragKey: ShapeAssistHandleKey | null = null;
    private shapeAssistDragStartSnapshot: ShapeAssistSnapshot | null = null;
    private shapeAssistPreviewAnimationToken = 0;
    private shapeAssistRenderedSamples: StrokeSample[] = [];
    private shapeAssistUndoStack: ShapeAssistSnapshot[] = [];
    private shapeAssistRedoStack: ShapeAssistSnapshot[] = [];
    private shapeAssistRandomSeed = 0;
    private fillTolerance = 32;
    private fillEdgeSensitivity = 25;
    private fillTuningMode: FloodFillTuningMode = 'auto';
    private fillInProgress = false;
    private floodFillEditingContext = false;
    private floodFillRibbonEl: HTMLElement | null = null;
    private floodFillToleranceInputEl: HTMLInputElement | null = null;
    private floodFillEdgeInputEl: HTMLInputElement | null = null;
    private floodFillSeed: Point | null = null;
    private floodFillBaselineFixer: Fixer | null = null;
    private floodFillPreviewResult: CanvasFloodFillResult | null = null;
    private floodFillPreviewToken = 0;
    private floodFillPreviewQueued = false;
    private floodFillPreviewPromise: Promise<void> | null = null;
    private floodFillUndoStack: FloodFillSnapshot[] = [];
    private floodFillRedoStack: FloodFillSnapshot[] = [];

    constructor(private delegate: CanvasStageDelegate) {
        this.element.className = 'ub-ipad-stage';
        this.canvas.className = 'ub-ipad-canvas';
        this.element.appendChild(this.canvas);
    }

    public async init(): Promise<void> {
        this.resizeCanvas();

        let bootstrap;
        try {
            bootstrap = await bootstrapWebGPU(this.canvas);
        } catch (error) {
            this.delegate.stageDidFail(error instanceof Error ? error.message : String(error));
            return;
        }

        this.context = new WGPUContext(bootstrap.device, bootstrap.presentationContext, bootstrap.presentationFormat, this.canvasSize);
        WGPUProgramManager.init(this.context);

        this.document = new DocumentController(this.context, this.canvasSize);
        this.delegate.stageDidCreateDocument(this.document);

        this.attachEvents();
        this.loop();
    }

    private attachEvents(): void {
        this.canvas.addEventListener('mousedown', this.onPointerDown);
        this.canvas.addEventListener('touchstart', this.onPointerDown, { passive: false });
        window.addEventListener('resize', () => this.resizeCanvas());
        if ('ResizeObserver' in window) {
            this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
            this.resizeObserver.observe(this.element);
        }
    }

    private resizeCanvas(): void {
        const rect = this.element.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width || window.innerWidth));
        const height = Math.max(1, Math.floor(rect.height || window.innerHeight));
        const scale = Math.min(2, window.devicePixelRatio || 1);
        this.canvas.width = Math.floor(width * scale);
        this.canvas.height = Math.floor(height * scale);
        this.canvasSize = new Size(this.canvas.width, this.canvas.height);
    }

    private loop(): void {
        this.render();
        requestAnimationFrame(() => this.loop());
    }

    private render(): void {
        if (!this.context || !this.document) return;

        this.context.clearRenderTarget(null, new Color(0.79, 0.79, 0.76, 1));
        this.document.canvasStack.compositeIfNeeded();

        WGPUProgramManager.getInstance().fillRectProgram.fill(null, {
            targetRect: Common.stageRect(),
            source: this.document.canvasStack.outputRenderTarget.texture,
            sourceRect: Common.stageRect(),
            canvasRect: Common.stageRect(),
            transform: new AffineTransform(),
            blend: RenderObjectBlend.Normal
        });
    }

    private onPointerDown = async (e: MouseEvent | TouchEvent): Promise<void> => {
        e.preventDefault();
        if (!this.document || this.document.selectedLayerIsLocked()) return;

        if (this.shapeAssistEditingContext) {
            await this.commitShapeAssistContext();
        }
        if (this.floodFillEditingContext) {
            await this.commitFloodFillContext();
        }

        const canvas = this.document.selectedCanvas;
        if (!canvas) return;

        this.stylusEventCount = 0;
        this.lastPoint = this.eventPoint(e);
        this.lastStylus = this.eventStylus(e);

        if (this.document.tool === 'fill') {
            await this.startFloodFillContext(this.lastPoint);
            this.document.setTool('brush');
            return;
        }

        this.resetShapeAssistState(false);
        this.straightLineStartPos = this.lastPoint.clone();
        this.straightLineStartStylus = new Stylus(
            this.lastStylus.pressure,
            this.lastStylus.altitudeAngle,
            this.lastStylus.azimuthAngle
        );
        this.straightLineSamples = [{
            point: this.lastPoint.clone(),
            stylus: this.cloneStylus(this.lastStylus)
        }];
        this.straightLineStrokeGroup = await canvas.captureLineStartForStraightening();
        canvas.moveTo(this.lastPoint, this.lastStylus);
        this.startStraightLineTimer();

        if (e instanceof MouseEvent) {
            document.addEventListener('mousemove', this.onPointerMove);
            document.addEventListener('mouseup', this.onPointerUp);
        } else {
            document.addEventListener('touchmove', this.onPointerMove, { passive: false });
            document.addEventListener('touchend', this.onPointerUp);
        }
    };

    private onPointerMove = (e: MouseEvent | TouchEvent): void => {
        e.preventDefault();
        const canvas = this.activeCanvas();
        if (!canvas) return;

        this.lastPoint = this.eventPoint(e);
        this.lastStylus = this.eventStylus(e);
        if (this.straightLinePreviewActive && this.straightLineStartPos && this.straightLineStartStylus) {
            if (!this.shapeAssistEditingContext) {
                this.updateShapeAssistEnd(this.lastPoint, this.lastStylus);
            }
            this.renderShapeAssistPreview();
            return;
        }

        if (!this.straightLineActivating) {
            this.straightLineSamples.push({
                point: this.lastPoint.clone(),
                stylus: this.cloneStylus(this.lastStylus)
            });
            canvas.lineTo(this.lastPoint, this.lastStylus);
        }
    };

    private onPointerUp = async (e: MouseEvent | TouchEvent): Promise<void> => {
        e.preventDefault();
        this.clearStraightLineTimer();
        if (this.straightLineActivationPromise) {
            await this.straightLineActivationPromise;
        }

        const canvas = this.activeCanvas();
        if (canvas && this.straightLinePreviewActive && this.straightLineUndoGroup && this.straightLineStartPos && this.straightLineStartStylus) {
            this.renderShapeAssistPreview();
            this.shapeAssistEditingContext = true;
            this.showShapeAssistUI();
            this.updateShapeAssistHandles();
        } else if (canvas) {
            await canvas.endLine(this.lastPoint, this.lastStylus);
            this.resetShapeAssistState(false);
        }

        document.removeEventListener('mousemove', this.onPointerMove);
        document.removeEventListener('mouseup', this.onPointerUp);
        document.removeEventListener('touchmove', this.onPointerMove);
        document.removeEventListener('touchend', this.onPointerUp);
    };

    private activeCanvas(): Canvas | undefined {
        return this.document?.selectedCanvas;
    }

    private startStraightLineTimer(): void {
        const token = ++this.straightLineToken;
        this.straightLineTimer = window.setTimeout(() => {
            this.straightLineActivationPromise = this.activateStraightLinePreview(token);
        }, SHAPE_ASSIST_HOLD_MS);
    }

    private clearStraightLineTimer(): void {
        if (this.straightLineTimer === null) return;
        window.clearTimeout(this.straightLineTimer);
        this.straightLineTimer = null;
    }

    private async activateStraightLinePreview(token: number): Promise<void> {
        const canvas = this.activeCanvas();
        if (!canvas || !this.straightLineStartPos || !this.straightLineStartStylus) return;
        if (token !== this.straightLineToken) return;
        if (this.straightLinePreviewActive || this.straightLineActivating) return;

        this.straightLineActivating = true;
        try {
            const curveSamples = this.cloneStrokeSamples(this.straightLineSamples);
            this.shapeAssistCurveSamples = curveSamples;
            this.shapeAssistRandomSeed = Common.nextRandomSeed();
            this.shapeAssistMode = this.chooseShapeAssistMode(curveSamples);
            this.shapeAssistHandles = this.createShapeAssistHandles(this.shapeAssistMode);
            const strokeGroup = this.straightLineStrokeGroup ?? await canvas.captureLineStartForStraightening();
            const undoGroup = await canvas.prepareActiveLineForStraightening(strokeGroup);
            this.straightLineStrokeGroup = strokeGroup;
            if (token !== this.straightLineToken || !this.straightLineStartPos || !this.straightLineStartStylus) return;

            this.straightLineUndoGroup = undoGroup;
            await this.animateStraightLineMorph(token, curveSamples, this.shapeAssistMode);
            if (token !== this.straightLineToken || !this.straightLineStartPos || !this.straightLineStartStylus) return;

            this.straightLinePreviewActive = true;
            this.renderShapeAssistPreview();
        } catch (error) {
            console.error('Shape assist preview failed', error);
        } finally {
            this.straightLineActivating = false;
        }
    }

    private async animateStraightLineMorph(token: number, curveSamples: StrokeSample[], mode: ShapeAssistMode): Promise<void> {
        const canvas = this.activeCanvas();
        if (!canvas || curveSamples.length < 2) return;

        const disableSmudging = canvas.brushUsesSmudging();
        const startedAt = performance.now();

        await new Promise<void>((resolve) => {
            const frame = (now: number) => {
                const activeCanvas = this.activeCanvas();
                if (token !== this.straightLineToken || !activeCanvas) {
                    resolve();
                    return;
                }

                const rawT = Math.min(1, (now - startedAt) / STRAIGHTEN_MORPH_MS);
                const t = rawT * rawT * (3 - 2 * rawT);
                const targetSamples = this.buildShapeAssistSamples(mode, curveSamples.length);
                const samples = this.buildMorphSamples(curveSamples, targetSamples, t);
                activeCanvas.replaceActiveLineWithPath(samples, {
                    disableSmudging,
                    followAcceleration: 1,
                    randomSeed: this.shapeAssistRandomSeed
                });

                if (rawT >= 1) {
                    resolve();
                } else {
                    requestAnimationFrame(frame);
                }
            };
            requestAnimationFrame(frame);
        });
    }

    private renderShapeAssistPreview(animated: boolean = false): void {
        if (!this.shapeAssistHandles) return;
        const targetSamples = this.buildShapeAssistSamples(this.shapeAssistMode, Math.max(2, this.shapeAssistCurveSamples.length));
        this.updateShapeAssistHandles();

        if (!animated || this.shapeAssistRenderedSamples.length < 2) {
            this.shapeAssistPreviewAnimationToken++;
            this.applyShapeAssistPreviewSamples(targetSamples);
            return;
        }

        this.animateShapeAssistPreview(targetSamples);
    }

    private applyShapeAssistPreviewSamples(samples: StrokeSample[]): void {
        const canvas = this.activeCanvas();
        if (!canvas) return;
        canvas.replaceActiveLineWithPath(samples, {
            disableSmudging: canvas.brushUsesSmudging(),
            followAcceleration: 1,
            randomSeed: this.shapeAssistRandomSeed
        });
        this.shapeAssistRenderedSamples = this.cloneStrokeSamples(samples);
    }

    private animateShapeAssistPreview(targetSamples: StrokeSample[]): void {
        const token = ++this.shapeAssistPreviewAnimationToken;
        const sourceSamples = this.cloneStrokeSamples(this.shapeAssistRenderedSamples);
        const startedAt = performance.now();

        const frame = (now: number) => {
            if (token !== this.shapeAssistPreviewAnimationToken) return;

            const rawT = Math.min(1, (now - startedAt) / SHAPE_ASSIST_EDIT_MORPH_MS);
            const t = rawT * rawT * (3 - 2 * rawT);
            const samples = this.buildMorphSamples(sourceSamples, targetSamples, t);
            this.applyShapeAssistPreviewSamples(samples);

            if (rawT >= 1) {
                this.applyShapeAssistPreviewSamples(targetSamples);
            } else {
                requestAnimationFrame(frame);
            }
        };

        requestAnimationFrame(frame);
    }

    private buildMorphSamples(curveSamples: StrokeSample[], targetSamples: StrokeSample[], t: number): StrokeSample[] {
        const maxIndex = Math.max(1, curveSamples.length - 1);
        const targetMaxIndex = Math.max(1, targetSamples.length - 1);
        return curveSamples.map((sample, index) => {
            const target = targetSamples[Math.min(targetSamples.length - 1, Math.round((index / maxIndex) * targetMaxIndex))];
            return {
                point: Common.interpolatePoint(sample.point, target.point, t),
                stylus: this.interpolateStylus(sample.stylus, target.stylus, t)
            };
        });
    }

    private buildShapeAssistSamples(mode: ShapeAssistMode, count: number): StrokeSample[] {
        if (!this.shapeAssistHandles || !this.straightLineStartStylus) return [];
        if (mode === 'ellipse' || mode === 'circle') return this.buildEllipseSamples(count);
        if (mode === 'polyline') return this.buildPolylineSamples(count);
        if (mode === 'fit') return this.buildFitSamples(count);
        if (mode === 'bezier') return this.buildBezierSamples(count);
        return this.buildLineSamples(count);
    }

    private buildLineSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const startStylus = this.straightLineStartStylus!;
        const lastIndex = Math.max(1, count - 1);
        return Array.from({ length: Math.max(2, count) }, (_, index) => {
            const t = index / lastIndex;
            return {
                point: Common.interpolatePoint(handles.start, handles.end, t),
                stylus: this.interpolateStylus(startStylus, this.lastStylus, t)
            };
        });
    }

    private buildBezierSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const startStylus = this.straightLineStartStylus!;
        const lastIndex = Math.max(1, count - 1);
        return Array.from({ length: Math.max(2, count) }, (_, index) => {
            const t = index / lastIndex;
            return {
                point: this.cubicBezierPoint(handles.start, handles.control1, handles.control2, handles.end, t),
                stylus: this.interpolateStylus(startStylus, this.lastStylus, t)
            };
        });
    }

    private buildFitSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const points = [handles.start, ...handles.anchors, handles.end];
        if (points.length <= 2) return this.buildLineSamples(count);
        const startStylus = this.straightLineStartStylus!;
        const sampleCount = Math.max(2, count);
        const lastIndex = sampleCount - 1;
        return Array.from({ length: sampleCount }, (_, index) => {
            const t = index / lastIndex;
            return {
                point: this.catmullRomPoint(points, t),
                stylus: this.interpolateStylus(startStylus, this.lastStylus, t)
            };
        });
    }

    private buildPolylineSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const points = [handles.start, ...handles.anchors, handles.end];
        if (points.length <= 2) return this.buildLineSamples(count);

        const startStylus = this.straightLineStartStylus!;
        const sampleCount = Math.max(points.length, count);
        const lastIndex = sampleCount - 1;
        const lengths: number[] = [];
        let totalLength = 0;
        for (let i = 1; i < points.length; i++) {
            totalLength += Common.distance(points[i - 1], points[i]);
            lengths.push(totalLength);
        }
        if (totalLength <= 0.001) return this.buildLineSamples(sampleCount);

        return Array.from({ length: sampleCount }, (_, index) => {
            const t = index / lastIndex;
            const targetLength = totalLength * t;
            let segmentIndex = lengths.findIndex((length) => length >= targetLength);
            if (segmentIndex < 0) segmentIndex = lengths.length - 1;
            const segmentStartLength = segmentIndex === 0 ? 0 : lengths[segmentIndex - 1];
            const segmentLength = Math.max(0.0001, lengths[segmentIndex] - segmentStartLength);
            const localT = Math.max(0, Math.min(1, (targetLength - segmentStartLength) / segmentLength));
            return {
                point: Common.interpolatePoint(points[segmentIndex], points[segmentIndex + 1], localT),
                stylus: this.interpolateStylus(startStylus, this.lastStylus, t)
            };
        });
    }

    private buildEllipseSamples(count: number): StrokeSample[] {
        const handles = this.shapeAssistHandles!;
        const anchors = handles.anchors.length >= 4
            ? handles.anchors
            : this.createEllipseAnchorsFromSamples(this.shapeAssistCurveSamples);
        const axis = this.ellipseAxesFromAnchors(anchors);
        const sampleCount = Math.max(48, count);
        const startStylus = this.straightLineStartStylus!;

        return Array.from({ length: sampleCount + 1 }, (_, index) => {
            const t = index / sampleCount;
            const a = t * Math.PI * 2;
            return {
                point: new Point(
                    axis.center.x + Math.cos(a) * axis.axisA.x + Math.sin(a) * axis.axisB.x,
                    axis.center.y + Math.cos(a) * axis.axisA.y + Math.sin(a) * axis.axisB.y
                ),
                stylus: this.interpolateStylus(startStylus, this.lastStylus, t)
            };
        });
    }

    private createShapeAssistHandles(mode: ShapeAssistMode): ShapeAssistHandles {
        const polylinePoints = mode === 'polyline' ? this.extractPolylinePoints(this.shapeAssistCurveSamples) : null;
        const start = polylinePoints?.[0].clone() ?? this.straightLineStartPos!.clone();
        const end = polylinePoints?.[polylinePoints.length - 1].clone() ?? this.lastPoint.clone();
        const bounds = this.pointsBounds(this.shapeAssistCurveSamples.map((sample) => sample.point));
        const chord = Math.max(1, Common.distance(start, end));
        const startTangent = mode === 'bezier' ? this.strokeTangent(this.shapeAssistCurveSamples, true) : this.unitPoint(start, end);
        const endTangent = mode === 'bezier' ? this.strokeTangent(this.shapeAssistCurveSamples, false) : this.unitPoint(start, end);

        return {
            start,
            control1: new Point(start.x + startTangent.x * chord * 0.35, start.y + startTangent.y * chord * 0.35),
            control2: new Point(end.x - endTangent.x * chord * 0.35, end.y - endTangent.y * chord * 0.35),
            end,
            anchors: mode === 'fit'
                ? this.extractFitAnchors(this.shapeAssistCurveSamples)
                : mode === 'polyline' && polylinePoints
                    ? polylinePoints.slice(1, -1).map((point) => point.clone())
                    : mode === 'ellipse'
                        ? this.createEllipseAnchorsFromSamples(this.shapeAssistCurveSamples)
                        : mode === 'circle'
                            ? this.createCircleAnchorsFromBounds(bounds)
                            : []
        };
    }

    private updateShapeAssistEnd(point: Point, stylus: Stylus): void {
        if (!this.shapeAssistHandles) {
            this.shapeAssistHandles = this.createShapeAssistHandles(this.shapeAssistMode);
        }

        const handles = this.shapeAssistHandles;
        const previousEnd = handles.end;
        const dx = point.x - previousEnd.x;
        const dy = point.y - previousEnd.y;
        handles.end = point.clone();
        handles.control2 = new Point(handles.control2.x + dx, handles.control2.y + dy);
        this.lastStylus = this.cloneStylus(stylus);
    }

    private selectShapeAssistMode(mode: ShapeAssistMode): void {
        if (this.shapeAssistMode === mode) return;
        const previousMode = this.shapeAssistMode;
        const previousHandles = this.shapeAssistHandles ? this.cloneShapeAssistHandles(this.shapeAssistHandles) : null;
        this.shapeAssistMode = mode;
        this.shapeAssistHandles = this.createShapeAssistHandles(mode);
        this.reuseEllipseGeometryForMode(previousMode, previousHandles, mode);
        this.updateShapeAssistRibbon();
        this.renderShapeAssistPreview(true);
        this.pushShapeAssistSnapshot();
    }

    private reuseEllipseGeometryForMode(previousMode: ShapeAssistMode, previousHandles: ShapeAssistHandles | null, mode: ShapeAssistMode): void {
        if (!previousHandles || previousHandles.anchors.length < 4 || !this.shapeAssistHandles) return;
        if ((previousMode !== 'ellipse' && previousMode !== 'circle') || (mode !== 'ellipse' && mode !== 'circle')) return;
        if (previousMode === 'circle' && mode === 'ellipse') return;

        const { center, axisA, axisB } = this.ellipseAxesFromAnchors(previousHandles.anchors);
        if (mode === 'ellipse') {
            this.shapeAssistHandles.anchors = previousHandles.anchors.map((anchor) => anchor.clone());
            return;
        }

        const radius = Math.max(1, (this.pointLength(axisA) + this.pointLength(axisB)) * 0.5);
        const nextAxisA = this.pointWithLength(axisA, radius);
        const nextAxisB = this.orientedPerpendicular(nextAxisA, axisB, radius);
        this.setEllipseAnchors(center, nextAxisA, nextAxisB);
    }

    private chooseShapeAssistMode(samples: StrokeSample[]): ShapeAssistMode {
        if (samples.length < 3) return 'line';
        const pathLength = this.strokePathLength(samples);
        if (pathLength <= 0) return 'line';
        const chord = Common.distance(samples[0].point, samples[samples.length - 1].point);
        if (chord / pathLength > 0.94) return 'line';
        if (this.extractPolylinePoints(samples)) return 'polyline';
        if (this.isClosedStroke(samples, pathLength)) return 'ellipse';
        return 'fit';
    }

    private isClosedStroke(samples: StrokeSample[], pathLength: number): boolean {
        if (samples.length < 8) return false;
        const points = samples.map((sample) => sample.point);
        const bounds = this.pointsBounds(points);
        const diagonal = Math.hypot(bounds.size.width, bounds.size.height);
        if (diagonal <= 1) return false;
        const closeDistance = Common.distance(samples[0].point, samples[samples.length - 1].point);
        return closeDistance <= diagonal * 0.2 && pathLength >= diagonal * 1.8;
    }

    private strokePathLength(samples: StrokeSample[]): number {
        let length = 0;
        for (let i = 1; i < samples.length; i++) {
            length += Common.distance(samples[i - 1].point, samples[i].point);
        }
        return length;
    }

    private extractPolylinePoints(samples: StrokeSample[]): Point[] | null {
        if (samples.length < 4) return null;
        const points = samples.map((sample) => sample.point);
        const bounds = this.pointsBounds(points);
        const diagonal = Math.hypot(bounds.size.width, bounds.size.height);
        if (diagonal <= 1) return null;

        const pathLength = this.strokePathLength(samples);
        const closed = this.isClosedStroke(samples, pathLength);
        const tolerance = Math.max(6, diagonal * 0.035);
        const simplified = closed ? this.simplifyClosedPoints(points, tolerance) : this.simplifyPoints(points, tolerance);
        const segmentCount = Math.max(0, simplified.length - 1);

        if (closed && segmentCount < 3) return null;
        if (!closed && segmentCount < 2) return null;
        if (segmentCount > 6) return null;
        if (this.polylineCornerCount(simplified, closed) < (closed ? 3 : 1)) return null;

        const error = this.polylineFitError(points, simplified);
        if (error.max > tolerance * 2.2 || error.average > tolerance * 0.85) return null;
        return simplified.map((point) => point.clone());
    }

    private simplifyClosedPoints(points: Point[], tolerance: number): Point[] {
        const openPoints = points.slice();
        if (Common.distance(openPoints[0], openPoints[openPoints.length - 1]) <= tolerance * 2) openPoints.pop();
        if (openPoints.length <= 3) return [...openPoints.map((point) => point.clone()), openPoints[0].clone()];

        const first = openPoints[0];
        let splitIndex = 1;
        let splitDistance = -1;
        for (let i = 1; i < openPoints.length; i++) {
            const distance = Common.distance(first, openPoints[i]);
            if (distance > splitDistance) {
                splitDistance = distance;
                splitIndex = i;
            }
        }

        const loop = [...openPoints, first];
        const firstArc = this.simplifyPoints(loop.slice(0, splitIndex + 1), tolerance);
        const secondArc = this.simplifyPoints(loop.slice(splitIndex), tolerance);
        return firstArc.concat(secondArc.slice(1));
    }

    private polylineFitError(points: Point[], polyline: Point[]): { max: number; average: number } {
        let max = 0;
        let total = 0;
        for (const point of points) {
            const distance = this.pointPolylineDistance(point, polyline);
            max = Math.max(max, distance);
            total += distance;
        }
        return { max, average: total / Math.max(1, points.length) };
    }

    private pointPolylineDistance(point: Point, polyline: Point[]): number {
        let best = Infinity;
        for (let i = 1; i < polyline.length; i++) {
            best = Math.min(best, this.pointSegmentDistance(point, polyline[i - 1], polyline[i]));
        }
        return best;
    }

    private polylineCornerCount(points: Point[], closed: boolean): number {
        const end = closed ? points.length - 1 : points.length;
        let count = 0;
        for (let i = closed ? 0 : 1; i < (closed ? end : points.length - 1); i++) {
            const prev = points[(i - 1 + end) % end];
            const current = points[i];
            const next = points[(i + 1) % end];
            if (this.turnAngle(prev, current, next) > 0.38) count++;
        }
        return count;
    }

    private turnAngle(prev: Point, current: Point, next: Point): number {
        const ax = current.x - prev.x;
        const ay = current.y - prev.y;
        const bx = next.x - current.x;
        const by = next.y - current.y;
        const al = Math.hypot(ax, ay);
        const bl = Math.hypot(bx, by);
        if (al <= 0.001 || bl <= 0.001) return 0;
        const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)));
        return Math.acos(dot);
    }

    private extractFitAnchors(samples: StrokeSample[]): Point[] {
        if (samples.length < 3) return [];
        const points = samples.map((sample) => sample.point);
        const bbox = this.pointsBounds(points);
        const tolerance = Math.max(6, Math.hypot(bbox.size.width, bbox.size.height) * 0.045);
        const simplified = this.simplifyPoints(points, tolerance);
        const interior = simplified.slice(1, -1);
        const maxAnchors = 4;

        if (interior.length <= maxAnchors) return interior.map((point) => point.clone());
        return Array.from({ length: maxAnchors }, (_, index) => {
            const sourceIndex = Math.round(((index + 1) / (maxAnchors + 1)) * (interior.length - 1));
            return interior[sourceIndex].clone();
        });
    }

    private simplifyPoints(points: Point[], tolerance: number): Point[] {
        if (points.length <= 2) return points.map((point) => point.clone());

        let bestIndex = -1;
        let bestDistance = -1;
        const first = points[0];
        const last = points[points.length - 1];

        for (let i = 1; i < points.length - 1; i++) {
            const distance = this.pointSegmentDistance(points[i], first, last);
            if (distance > bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }

        if (bestDistance <= tolerance || bestIndex < 0) return [first.clone(), last.clone()];
        const left = this.simplifyPoints(points.slice(0, bestIndex + 1), tolerance);
        const right = this.simplifyPoints(points.slice(bestIndex), tolerance);
        return left.slice(0, -1).concat(right);
    }

    private pointSegmentDistance(point: Point, start: Point, end: Point): number {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq <= 0.0001) return Common.distance(point, start);
        const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
        return Common.distance(point, new Point(start.x + dx * t, start.y + dy * t));
    }

    private pointsBounds(points: Point[]): Rect {
        if (points.length === 0) return new Rect();
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of points) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
        return new Rect(minX, minY, maxX - minX, maxY - minY);
    }

    private createEllipseAnchorsFromBounds(bounds: Rect): Point[] {
        const cx = bounds.origin.x + bounds.size.width * 0.5;
        const cy = bounds.origin.y + bounds.size.height * 0.5;
        return [
            new Point(bounds.origin.x, cy),
            new Point(bounds.origin.x + bounds.size.width, cy),
            new Point(cx, bounds.origin.y + bounds.size.height),
            new Point(cx, bounds.origin.y)
        ];
    }

    private createEllipseAnchorsFromSamples(samples: StrokeSample[]): Point[] {
        const points = samples.map((sample) => sample.point);
        if (points.length < 2) return this.createEllipseAnchorsFromBounds(this.pointsBounds(points));

        let meanX = 0;
        let meanY = 0;
        for (const point of points) {
            meanX += point.x;
            meanY += point.y;
        }
        meanX /= points.length;
        meanY /= points.length;

        let xx = 0;
        let xy = 0;
        let yy = 0;
        for (const point of points) {
            const dx = point.x - meanX;
            const dy = point.y - meanY;
            xx += dx * dx;
            xy += dx * dy;
            yy += dy * dy;
        }

        const axisConfidence = Math.hypot(xx - yy, 2 * xy) / Math.max(0.0001, xx + yy);
        if (axisConfidence < 0.18) return this.createEllipseAnchorsFromBounds(this.pointsBounds(points));

        const angle = Math.abs(xy) <= 0.0001 && Math.abs(xx - yy) <= 0.0001
            ? 0
            : 0.5 * Math.atan2(2 * xy, xx - yy);
        let axisAUnit = new Point(Math.cos(angle), Math.sin(angle));
        let axisBUnit = new Point(-axisAUnit.y, axisAUnit.x);
        let minA = Infinity;
        let maxA = -Infinity;
        let minB = Infinity;
        let maxB = -Infinity;
        for (const point of points) {
            const dx = point.x - meanX;
            const dy = point.y - meanY;
            const a = dx * axisAUnit.x + dy * axisAUnit.y;
            const b = dx * axisBUnit.x + dy * axisBUnit.y;
            minA = Math.min(minA, a);
            maxA = Math.max(maxA, a);
            minB = Math.min(minB, b);
            maxB = Math.max(maxB, b);
        }

        let radiusA = Math.max(1, (maxA - minA) * 0.5);
        let radiusB = Math.max(1, (maxB - minB) * 0.5);
        const centerOffsetA = (minA + maxA) * 0.5;
        const centerOffsetB = (minB + maxB) * 0.5;
        const center = new Point(
            meanX + axisAUnit.x * centerOffsetA + axisBUnit.x * centerOffsetB,
            meanY + axisAUnit.y * centerOffsetA + axisBUnit.y * centerOffsetB
        );

        if (radiusB > radiusA) {
            [radiusA, radiusB] = [radiusB, radiusA];
            [axisAUnit, axisBUnit] = [axisBUnit, new Point(-axisAUnit.x, -axisAUnit.y)];
        }

        const axisA = new Point(axisAUnit.x * radiusA, axisAUnit.y * radiusA);
        const axisB = new Point(axisBUnit.x * radiusB, axisBUnit.y * radiusB);
        return [
            new Point(center.x - axisA.x, center.y - axisA.y),
            new Point(center.x + axisA.x, center.y + axisA.y),
            new Point(center.x + axisB.x, center.y + axisB.y),
            new Point(center.x - axisB.x, center.y - axisB.y)
        ];
    }

    private createCircleAnchorsFromBounds(bounds: Rect): Point[] {
        const cx = bounds.origin.x + bounds.size.width * 0.5;
        const cy = bounds.origin.y + bounds.size.height * 0.5;
        const radius = Math.max(1, Math.max(bounds.size.width, bounds.size.height) * 0.5);
        return [
            new Point(cx - radius, cy),
            new Point(cx + radius, cy),
            new Point(cx, cy + radius),
            new Point(cx, cy - radius)
        ];
    }

    private ellipseAxesFromAnchors(anchors: Point[]): { center: Point; axisA: Point; axisB: Point } {
        const a0 = anchors[0];
        const a1 = anchors[1];
        const b0 = anchors[2];
        const b1 = anchors[3];
        const center = new Point(
            (a0.x + a1.x + b0.x + b1.x) * 0.25,
            (a0.y + a1.y + b0.y + b1.y) * 0.25
        );

        let axisA = new Point((a1.x - a0.x) * 0.5, (a1.y - a0.y) * 0.5);
        let axisB = new Point((b0.x - b1.x) * 0.5, (b0.y - b1.y) * 0.5);
        if (Math.hypot(axisA.x, axisA.y) < 1) axisA = new Point(1, 0);
        if (Math.hypot(axisB.x, axisB.y) < 1) axisB = this.perpendicularPoint(axisA, 1);
        return { center, axisA, axisB };
    }

    private updateEllipseAnchor(index: number, point: Point): void {
        const handles = this.shapeAssistHandles!;
        if (handles.anchors.length < 4) {
            handles.anchors = this.createEllipseAnchorsFromBounds(this.pointsBounds(this.shapeAssistCurveSamples.map((sample) => sample.point)));
        }

        const anchors = handles.anchors;
        const { center, axisA, axisB } = this.ellipseAxesFromAnchors(anchors);
        const radiusA = Math.max(1, Math.hypot(axisA.x, axisA.y));
        const radiusB = Math.max(1, Math.hypot(axisB.x, axisB.y));

        if (index === 0 || index === 1) {
            const sign = index === 0 ? -1 : 1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const nextAxisA = this.pointLength(dragged) >= 1 ? dragged : this.pointWithLength(axisA, radiusA);
            const nextAxisB = this.orientedPerpendicular(nextAxisA, axisB, radiusB);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        if (index === 2 || index === 3) {
            const sign = index === 2 ? 1 : -1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const nextAxisB = this.pointLength(dragged) >= 1 ? dragged : this.pointWithLength(axisB, radiusB);
            const nextAxisA = this.orientedPerpendicular(nextAxisB, axisA, radiusA, true);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        anchors[index] = point;
    }

    private updateCircleAnchor(index: number, point: Point): void {
        const handles = this.shapeAssistHandles!;
        if (handles.anchors.length < 4) {
            handles.anchors = this.createCircleAnchorsFromBounds(this.pointsBounds(this.shapeAssistCurveSamples.map((sample) => sample.point)));
        }

        const anchors = handles.anchors;
        const { center, axisA, axisB } = this.ellipseAxesFromAnchors(anchors);
        const fallbackRadius = Math.max(1, (this.pointLength(axisA) + this.pointLength(axisB)) * 0.5);

        if (index === 0 || index === 1) {
            const sign = index === 0 ? -1 : 1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const radius = Math.max(1, this.pointLength(dragged));
            const nextAxisA = radius > 1 ? this.pointWithLength(dragged, radius) : this.pointWithLength(axisA, fallbackRadius);
            const nextAxisB = this.orientedPerpendicular(nextAxisA, axisB, radius);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        if (index === 2 || index === 3) {
            const sign = index === 2 ? 1 : -1;
            const dragged = new Point((point.x - center.x) * sign, (point.y - center.y) * sign);
            const radius = Math.max(1, this.pointLength(dragged));
            const nextAxisB = radius > 1 ? this.pointWithLength(dragged, radius) : this.pointWithLength(axisB, fallbackRadius);
            const nextAxisA = this.orientedPerpendicular(nextAxisB, axisA, radius, true);
            this.setEllipseAnchors(center, nextAxisA, nextAxisB);
            return;
        }

        anchors[index] = point;
    }

    private setEllipseAnchors(center: Point, axisA: Point, axisB: Point): void {
        const handles = this.shapeAssistHandles!;
        handles.anchors = [
            new Point(center.x - axisA.x, center.y - axisA.y),
            new Point(center.x + axisA.x, center.y + axisA.y),
            new Point(center.x + axisB.x, center.y + axisB.y),
            new Point(center.x - axisB.x, center.y - axisB.y)
        ];
    }

    private orientedPerpendicular(axis: Point, previousAxis: Point, length: number, clockwise = false): Point {
        let perpendicular = this.perpendicularPoint(axis, length);
        if (clockwise) perpendicular = new Point(-perpendicular.x, -perpendicular.y);
        if (perpendicular.x * previousAxis.x + perpendicular.y * previousAxis.y < 0) {
            perpendicular = new Point(-perpendicular.x, -perpendicular.y);
        }
        return perpendicular;
    }

    private perpendicularPoint(point: Point, length: number): Point {
        const currentLength = Math.max(0.0001, this.pointLength(point));
        return new Point((-point.y / currentLength) * length, (point.x / currentLength) * length);
    }

    private pointWithLength(point: Point, length: number): Point {
        const currentLength = Math.max(0.0001, this.pointLength(point));
        return new Point((point.x / currentLength) * length, (point.y / currentLength) * length);
    }

    private pointLength(point: Point): number {
        return Math.hypot(point.x, point.y);
    }

    private strokeTangent(samples: StrokeSample[], fromStart: boolean): Point {
        if (samples.length < 2) return new Point(1, 0);
        const baseIndex = fromStart ? 0 : samples.length - 1;
        const direction = fromStart ? 1 : -1;
        const base = samples[baseIndex].point;
        for (let offset = 1; offset < samples.length; offset++) {
            const sample = samples[baseIndex + offset * direction]?.point;
            if (!sample) break;
            const dx = fromStart ? sample.x - base.x : base.x - sample.x;
            const dy = fromStart ? sample.y - base.y : base.y - sample.y;
            const length = Math.hypot(dx, dy);
            if (length > 0.001) return new Point(dx / length, dy / length);
        }
        return new Point(1, 0);
    }

    private unitPoint(from: Point, to: Point): Point {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        if (length <= 0.001) return new Point(1, 0);
        return new Point(dx / length, dy / length);
    }

    private cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
        const s = 1 - t;
        const ss = s * s;
        const tt = t * t;
        const sss = ss * s;
        const ttt = tt * t;
        return new Point(
            p0.x * sss + p1.x * 3 * ss * t + p2.x * 3 * s * tt + p3.x * ttt,
            p0.y * sss + p1.y * 3 * ss * t + p2.y * 3 * s * tt + p3.y * ttt
        );
    }

    private catmullRomPoint(points: Point[], t: number): Point {
        const segmentCount = Math.max(1, points.length - 1);
        const scaled = Math.min(segmentCount - 0.000001, Math.max(0, t) * segmentCount);
        const i = Math.floor(scaled);
        const localT = scaled - i;
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[Math.min(points.length - 1, i + 1)];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        const tt = localT * localT;
        const ttt = tt * localT;
        return new Point(
            0.5 * ((2 * p1.x) + (-p0.x + p2.x) * localT + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * ttt),
            0.5 * ((2 * p1.y) + (-p0.y + p2.y) * localT + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * ttt)
        );
    }

    private showShapeAssistUI(): void {
        this.hideShapeAssistUI();

        const ribbon = document.createElement('div');
        ribbon.className = 'ub-shape-assist-ribbon';
        ribbon.addEventListener('mousedown', (e) => e.stopPropagation());
        ribbon.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });

        const buttons: Array<[string, ShapeAssistMode]> = [
            ['Line', 'line'],
            ['Smooth', 'bezier'],
            ['Fit', 'fit'],
            ['Polyline', 'polyline'],
            ['Ellipse', 'ellipse'],
            ['Circle', 'circle']
        ];
        for (const [label, mode] of buttons) {
            const button = this.shapeAssistButton(label, () => this.selectShapeAssistMode(mode));
            button.dataset.mode = mode;
            ribbon.appendChild(button);
        }
        const doneButton = this.shapeAssistButton('Done', () => void this.commitShapeAssistContext());
        doneButton.classList.add('done');
        ribbon.appendChild(doneButton);

        this.element.appendChild(ribbon);
        this.shapeAssistRibbonEl = ribbon;

        const handles = document.createElement('div');
        handles.className = 'ub-shape-assist-handles';
        this.element.appendChild(handles);
        this.shapeAssistHandlesEl = handles;

        this.updateShapeAssistRibbon();
        this.updateShapeAssistHandles();
        this.resetShapeAssistEditHistory();
        this.document?.setTransientHistory({
            canUndo: () => this.shapeAssistUndoStack.length > 1,
            canRedo: () => this.shapeAssistRedoStack.length > 0,
            undo: () => this.undoShapeAssistEdit(),
            redo: () => this.redoShapeAssistEdit()
        });
        document.addEventListener('mousedown', this.onShapeAssistDocumentMouseDown, true);
        document.addEventListener('touchstart', this.onShapeAssistDocumentTouchStart, true);
    }

    private hideShapeAssistUI(): void {
        document.removeEventListener('mousedown', this.onShapeAssistDocumentMouseDown, true);
        document.removeEventListener('touchstart', this.onShapeAssistDocumentTouchStart, true);
        document.removeEventListener('mousemove', this.onShapeAssistHandleMove);
        document.removeEventListener('mouseup', this.onShapeAssistHandleUp);
        document.removeEventListener('touchmove', this.onShapeAssistHandleTouchMove);
        document.removeEventListener('touchend', this.onShapeAssistHandleUp);
        this.shapeAssistRibbonEl?.remove();
        this.shapeAssistHandlesEl?.remove();
        this.shapeAssistRibbonEl = null;
        this.shapeAssistHandlesEl = null;
        this.shapeAssistDragKey = null;
        this.shapeAssistDragStartSnapshot = null;
        this.document?.setTransientHistory(undefined);
    }

    private shapeAssistButton(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return button;
    }

    private updateShapeAssistRibbon(): void {
        if (!this.shapeAssistRibbonEl) return;
        for (const button of Array.from(this.shapeAssistRibbonEl.querySelectorAll<HTMLButtonElement>('button[data-mode]'))) {
            const active = button.dataset.mode === this.shapeAssistMode;
            button.classList.toggle('active', active);
        }
    }

    private updateShapeAssistHandles(): void {
        if (!this.shapeAssistHandlesEl || !this.shapeAssistHandles) return;
        this.shapeAssistHandlesEl.replaceChildren();
        const keys: ShapeAssistHandleKey[] = this.shapeAssistMode === 'line'
            ? ['start', 'end']
            : this.shapeAssistMode === 'bezier'
                ? ['start', 'control1', 'control2', 'end']
                : this.shapeAssistMode === 'ellipse' || this.shapeAssistMode === 'circle'
                    ? ['ellipseCenter', ...this.shapeAssistHandles.anchors.map((_, index) => `anchor:${index}` as ShapeAssistHandleKey)]
                    : this.shapeAssistMode === 'polyline' && this.polylineHandlesAreClosed()
                        ? ['start', ...this.shapeAssistHandles.anchors.map((_, index) => `anchor:${index}` as ShapeAssistHandleKey)]
                        : ['start', ...this.shapeAssistHandles.anchors.map((_, index) => `anchor:${index}` as ShapeAssistHandleKey), 'end'];

        for (const key of keys) {
            const point = this.shapeAssistPointForHandle(key);
            const pos = this.canvasPointToContainer(point);
            const handle = document.createElement('div');
            const isControl = key === 'control1' || key === 'control2';
            const isAnchor = key.startsWith('anchor:');
            const isCenter = key === 'ellipseCenter';
            handle.className = `ub-shape-assist-handle${isControl ? ' control' : ''}${isAnchor ? ' anchor' : ''}${isCenter ? ' center' : ''}`;
            handle.style.left = `${pos.x}px`;
            handle.style.top = `${pos.y}px`;
            handle.addEventListener('mousedown', (e) => this.beginShapeAssistHandleDrag(e, key));
            handle.addEventListener('touchstart', (e) => this.beginShapeAssistHandleTouchDrag(e, key), { passive: false });
            this.shapeAssistHandlesEl.appendChild(handle);
        }
    }

    private beginShapeAssistHandleDrag(e: MouseEvent, key: ShapeAssistHandleKey): void {
        e.preventDefault();
        e.stopPropagation();
        this.shapeAssistDragKey = key;
        this.shapeAssistDragStartSnapshot = this.currentShapeAssistSnapshot();
        document.addEventListener('mousemove', this.onShapeAssistHandleMove);
        document.addEventListener('mouseup', this.onShapeAssistHandleUp);
    }

    private beginShapeAssistHandleTouchDrag(e: TouchEvent, key: ShapeAssistHandleKey): void {
        e.preventDefault();
        e.stopPropagation();
        this.shapeAssistDragKey = key;
        this.shapeAssistDragStartSnapshot = this.currentShapeAssistSnapshot();
        document.addEventListener('touchmove', this.onShapeAssistHandleTouchMove, { passive: false });
        document.addEventListener('touchend', this.onShapeAssistHandleUp);
    }

    private onShapeAssistHandleMove = (e: MouseEvent): void => {
        if (!this.shapeAssistDragKey || !this.shapeAssistHandles) return;
        e.preventDefault();
        this.moveShapeAssistHandle(this.clientPointToCanvasPoint(e.clientX, e.clientY));
    };

    private onShapeAssistHandleTouchMove = (e: TouchEvent): void => {
        if (!this.shapeAssistDragKey || !this.shapeAssistHandles) return;
        e.preventDefault();
        const touch = e.touches[0];
        if (!touch) return;
        this.moveShapeAssistHandle(this.clientPointToCanvasPoint(touch.clientX, touch.clientY));
    };

    private moveShapeAssistHandle(point: Point): void {
        if (!this.shapeAssistDragKey || !this.shapeAssistHandles) return;
        this.setShapeAssistHandlePoint(this.shapeAssistDragKey, point);
        if (this.shapeAssistDragKey === 'end') this.lastPoint = point.clone();
        if (this.shapeAssistDragKey === 'start') this.straightLineStartPos = point.clone();
        this.renderShapeAssistPreview();
    }

    private onShapeAssistHandleUp = (): void => {
        const before = this.shapeAssistDragStartSnapshot;
        const after = this.currentShapeAssistSnapshot();
        this.shapeAssistDragKey = null;
        this.shapeAssistDragStartSnapshot = null;
        document.removeEventListener('mousemove', this.onShapeAssistHandleMove);
        document.removeEventListener('mouseup', this.onShapeAssistHandleUp);
        document.removeEventListener('touchmove', this.onShapeAssistHandleTouchMove);
        document.removeEventListener('touchend', this.onShapeAssistHandleUp);
        if (before && after && !this.shapeAssistSnapshotsEqual(before, after)) {
            this.pushShapeAssistSnapshot(after);
        }
    };

    private shapeAssistPointForHandle(key: ShapeAssistHandleKey): Point {
        const handles = this.shapeAssistHandles!;
        if (key === 'ellipseCenter') return this.ellipseAxesFromAnchors(handles.anchors).center;
        if (key.startsWith('anchor:')) return handles.anchors[Number(key.slice('anchor:'.length))];
        return handles[key];
    }

    private setShapeAssistHandlePoint(key: ShapeAssistHandleKey, point: Point): void {
        const handles = this.shapeAssistHandles!;
        if (key === 'ellipseCenter') {
            const currentCenter = this.ellipseAxesFromAnchors(handles.anchors).center;
            const dx = point.x - currentCenter.x;
            const dy = point.y - currentCenter.y;
            handles.anchors = handles.anchors.map((anchor) => new Point(anchor.x + dx, anchor.y + dy));
            return;
        }
        if (key.startsWith('anchor:')) {
            const index = Number(key.slice('anchor:'.length));
            if (this.shapeAssistMode === 'circle') {
                this.updateCircleAnchor(index, point);
                return;
            }
            if (this.shapeAssistMode === 'ellipse') {
                this.updateEllipseAnchor(index, point);
                return;
            }
            handles.anchors[index] = point;
            return;
        }
        const keepPolylineClosed = this.shapeAssistMode === 'polyline' && key === 'start' && this.polylineHandlesAreClosed();
        handles[key] = point;
        if (keepPolylineClosed) handles.end = point.clone();
    }

    private polylineHandlesAreClosed(): boolean {
        return this.shapeAssistMode === 'polyline'
            && !!this.shapeAssistHandles
            && Common.distance(this.shapeAssistHandles.start, this.shapeAssistHandles.end) < 0.01;
    }

    private onShapeAssistDocumentMouseDown = (e: MouseEvent): void => {
        if (!this.shapeAssistEditingContext) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (this.shapeAssistRibbonEl?.contains(target) || this.shapeAssistHandlesEl?.contains(target)) return;
        if (target === this.canvas) return;
        void this.commitShapeAssistContext();
    };

    private onShapeAssistDocumentTouchStart = (e: TouchEvent): void => {
        if (!this.shapeAssistEditingContext) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (this.shapeAssistRibbonEl?.contains(target) || this.shapeAssistHandlesEl?.contains(target)) return;
        if (target === this.canvas) return;
        void this.commitShapeAssistContext();
    };

    private async commitShapeAssistContext(): Promise<void> {
        const canvas = this.activeCanvas();
        if (!this.shapeAssistEditingContext || !canvas || !this.straightLineUndoGroup) return;

        this.renderShapeAssistPreview();
        const fixerGroup = await canvas.commitStraightenedLine(this.straightLineUndoGroup);
        if (this.straightLineStrokeGroup) {
            this.document?.pushCanvasHistory(canvas, this.straightLineStrokeGroup);
        }
        this.document?.pushCanvasHistory(canvas, fixerGroup);
        this.resetShapeAssistState();
    }

    private resetShapeAssistEditHistory(): void {
        this.shapeAssistUndoStack = [];
        this.shapeAssistRedoStack = [];
        const snapshot = this.currentShapeAssistSnapshot();
        if (snapshot) this.shapeAssistUndoStack.push(snapshot);
        this.document?.onHistoryChanged();
    }

    private pushShapeAssistSnapshot(snapshot: ShapeAssistSnapshot | null = this.currentShapeAssistSnapshot()): void {
        if (!snapshot) return;
        const current = this.shapeAssistUndoStack[this.shapeAssistUndoStack.length - 1];
        if (current && this.shapeAssistSnapshotsEqual(current, snapshot)) return;
        this.shapeAssistUndoStack.push(this.cloneShapeAssistSnapshot(snapshot));
        this.shapeAssistRedoStack = [];
        this.document?.onHistoryChanged();
    }

    private undoShapeAssistEdit(): void {
        if (this.shapeAssistUndoStack.length <= 1) return;
        const current = this.shapeAssistUndoStack.pop()!;
        this.shapeAssistRedoStack.push(current);
        this.applyShapeAssistSnapshot(this.shapeAssistUndoStack[this.shapeAssistUndoStack.length - 1]);
        this.document?.onHistoryChanged();
    }

    private redoShapeAssistEdit(): void {
        const next = this.shapeAssistRedoStack.pop();
        if (!next) return;
        this.shapeAssistUndoStack.push(next);
        this.applyShapeAssistSnapshot(next);
        this.document?.onHistoryChanged();
    }

    private currentShapeAssistSnapshot(): ShapeAssistSnapshot | null {
        if (!this.shapeAssistHandles) return null;
        return {
            mode: this.shapeAssistMode,
            handles: this.cloneShapeAssistHandles(this.shapeAssistHandles),
            randomSeed: this.shapeAssistRandomSeed
        };
    }

    private applyShapeAssistSnapshot(snapshot: ShapeAssistSnapshot): void {
        this.shapeAssistMode = snapshot.mode;
        this.shapeAssistHandles = this.cloneShapeAssistHandles(snapshot.handles);
        this.shapeAssistRandomSeed = snapshot.randomSeed;
        this.updateShapeAssistRibbon();
        this.renderShapeAssistPreview();
    }

    private cloneShapeAssistSnapshot(snapshot: ShapeAssistSnapshot): ShapeAssistSnapshot {
        return {
            mode: snapshot.mode,
            handles: this.cloneShapeAssistHandles(snapshot.handles),
            randomSeed: snapshot.randomSeed
        };
    }

    private cloneShapeAssistHandles(handles: ShapeAssistHandles): ShapeAssistHandles {
        return {
            start: handles.start.clone(),
            control1: handles.control1.clone(),
            control2: handles.control2.clone(),
            end: handles.end.clone(),
            anchors: handles.anchors.map((anchor) => anchor.clone())
        };
    }

    private shapeAssistSnapshotsEqual(a: ShapeAssistSnapshot, b: ShapeAssistSnapshot): boolean {
        return a.mode === b.mode
            && a.randomSeed === b.randomSeed
            && this.pointsAlmostEqual(a.handles.start, b.handles.start)
            && this.pointsAlmostEqual(a.handles.control1, b.handles.control1)
            && this.pointsAlmostEqual(a.handles.control2, b.handles.control2)
            && this.pointsAlmostEqual(a.handles.end, b.handles.end)
            && this.pointArraysAlmostEqual(a.handles.anchors, b.handles.anchors);
    }

    private pointArraysAlmostEqual(a: Point[], b: Point[]): boolean {
        if (a.length !== b.length) return false;
        return a.every((point, index) => this.pointsAlmostEqual(point, b[index]));
    }

    private pointsAlmostEqual(a: Point, b: Point): boolean {
        return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    }

    private resetShapeAssistState(clearTimer: boolean = true): void {
        if (clearTimer) this.clearStraightLineTimer();
        this.hideShapeAssistUI();
        this.straightLineToken++;
        this.straightLinePreviewActive = false;
        this.shapeAssistEditingContext = false;
        this.straightLineActivating = false;
        this.straightLineActivationPromise = null;
        this.straightLineSamples = [];
        this.shapeAssistCurveSamples = [];
        this.shapeAssistRandomSeed = 0;
        this.shapeAssistPreviewAnimationToken++;
        this.shapeAssistRenderedSamples = [];
        this.shapeAssistHandles = null;
        this.shapeAssistDragStartSnapshot = null;
        this.shapeAssistUndoStack = [];
        this.shapeAssistRedoStack = [];
        this.straightLineStrokeGroup = null;
        this.straightLineUndoGroup = null;
        this.straightLineStartPos = null;
        this.straightLineStartStylus = null;
    }

    private canvasPointToContainer(point: Point): Point {
        const rect = this.canvas.getBoundingClientRect();
        return new Point(
            (point.x / Math.max(1, this.canvas.width)) * rect.width,
            (1 - point.y / Math.max(1, this.canvas.height)) * rect.height
        );
    }

    private clientPointToCanvasPoint(clientX: number, clientY: number): Point {
        const rect = this.canvas.getBoundingClientRect();
        return new Point(
            ((clientX - rect.left) / Math.max(1, rect.width)) * this.canvas.width,
            this.canvas.height - ((clientY - rect.top) / Math.max(1, rect.height)) * this.canvas.height
        );
    }

    private cloneStrokeSamples(samples: StrokeSample[]): StrokeSample[] {
        return samples.map((sample) => ({
            point: sample.point.clone(),
            stylus: this.cloneStylus(sample.stylus)
        }));
    }

    private cloneStylus(stylus: Stylus): Stylus {
        return new Stylus(stylus.pressure, stylus.altitudeAngle, stylus.azimuthAngle);
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

    private async startFloodFillContext(seed: Point): Promise<void> {
        const canvas = this.activeCanvas();
        if (!canvas || this.fillInProgress) return;

        this.floodFillSeed = seed.clone();
        this.floodFillBaselineFixer = await canvas.fixer();
        if (!this.floodFillBaselineFixer) return;

        this.floodFillEditingContext = true;
        this.floodFillPreviewResult = null;
        this.floodFillPreviewQueued = false;
        this.floodFillPreviewToken++;
        this.showFloodFillUI();
        this.resetFloodFillEditHistory();
        await this.renderFloodFillPreview();
    }

    private async renderFloodFillPreview(): Promise<void> {
        const canvas = this.activeCanvas();
        if (!canvas || !this.floodFillEditingContext || !this.floodFillSeed || !this.floodFillBaselineFixer || !this.document) return;
        if (this.fillInProgress) {
            this.floodFillPreviewQueued = true;
            return this.floodFillPreviewPromise ?? Promise.resolve();
        }

        const token = ++this.floodFillPreviewToken;
        this.fillInProgress = true;
        this.document.onHistoryChanged();
        const run = (async () => {
            try {
                await canvas.fix(this.floodFillBaselineFixer!, false, false);
                if (token !== this.floodFillPreviewToken || !this.floodFillEditingContext) return;

                const result = await canvas.floodFill(
                    this.floodFillSeed!,
                    this.document!.color,
                    this.fillToleranceToEngineValue(this.fillTolerance),
                    this.fillEdgeSensitivityToEngineValue(this.fillEdgeSensitivity),
                    this.fillTuningMode
                );
                if (token !== this.floodFillPreviewToken || !this.floodFillEditingContext) return;
                if (!result) return;

                canvas.updateCanvas();
                this.floodFillPreviewResult = result;
                this.updateFillStats(result.metrics);
            } catch (error) {
                console.error('Flood fill preview failed', error);
            } finally {
                if (token === this.floodFillPreviewToken) {
                    this.fillInProgress = false;
                    this.document?.onHistoryChanged();
                    if (this.floodFillPreviewQueued) {
                        this.floodFillPreviewQueued = false;
                        void this.renderFloodFillPreview();
                    }
                }
            }
        })();

        const previewPromise = run.then(
            () => {
                if (this.floodFillPreviewPromise === previewPromise) this.floodFillPreviewPromise = null;
            },
            (error) => {
                if (this.floodFillPreviewPromise === previewPromise) this.floodFillPreviewPromise = null;
                throw error;
            }
        );
        this.floodFillPreviewPromise = previewPromise;
        return this.floodFillPreviewPromise;
    }

    private async commitFloodFillContext(): Promise<void> {
        if (!this.floodFillEditingContext) return;
        while (this.floodFillPreviewPromise) {
            await this.floodFillPreviewPromise;
        }
        this.floodFillPreviewQueued = false;

        const canvas = this.activeCanvas();
        const result = this.floodFillPreviewResult;
        this.hideFloodFillUI();
        this.floodFillEditingContext = false;
        this.floodFillPreviewToken++;

        if (canvas && result) {
            this.document?.pushFloodFillResult(canvas, result);
        }

        this.resetFloodFillState();
    }

    private fillToleranceToEngineValue(value: number): number {
        return (value / 255) * 2;
    }

    private fillEdgeSensitivityToEngineValue(value: number): number {
        return Math.max(0.02, ((value + 1) / 100) * 1.5);
    }

    private showFloodFillUI(): void {
        this.hideFloodFillUI();

        const ribbon = document.createElement('div');
        ribbon.className = 'ub-flood-fill-ribbon';
        ribbon.addEventListener('mousedown', (e) => e.stopPropagation());
        ribbon.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });

        this.floodFillToleranceInputEl = this.floodFillSlider('Tolerance', 0, 255, this.fillTolerance, (value) => {
            this.fillTolerance = value;
            void this.renderFloodFillPreview();
        }, () => this.pushFloodFillSnapshot());
        this.floodFillEdgeInputEl = this.floodFillSlider('Edge', 0, 100, this.fillEdgeSensitivity, (value) => {
            this.fillEdgeSensitivity = value;
            void this.renderFloodFillPreview();
        }, () => this.pushFloodFillSnapshot());
        const doneButton = this.shapeAssistButton('Done', () => void this.commitFloodFillContext());
        doneButton.classList.add('done');

        ribbon.append(this.floodFillToleranceInputEl.parentElement!, this.floodFillEdgeInputEl.parentElement!, doneButton);
        this.element.appendChild(ribbon);
        this.floodFillRibbonEl = ribbon;
        this.document?.setTransientHistory({
            canUndo: () => !this.fillInProgress && this.floodFillUndoStack.length > 0,
            canRedo: () => !this.fillInProgress && this.floodFillRedoStack.length > 0,
            undo: () => void this.undoFloodFillEdit(),
            redo: () => void this.redoFloodFillEdit()
        });
        document.addEventListener('mousedown', this.onFloodFillDocumentMouseDown, true);
        document.addEventListener('touchstart', this.onFloodFillDocumentTouchStart, true);
    }

    private floodFillSlider(labelText: string, min: number, max: number, value: number, onInput: (value: number) => void, onCommit: () => void): HTMLInputElement {
        const wrap = document.createElement('label');
        wrap.className = 'ub-flood-fill-slider';
        const label = document.createElement('span');
        label.textContent = labelText;
        const valueEl = document.createElement('b');
        valueEl.textContent = String(value);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
        input.value = String(value);
        input.addEventListener('input', () => {
            const next = Number(input.value);
            valueEl.textContent = String(next);
            onInput(next);
        });
        input.addEventListener('change', onCommit);
        wrap.append(label, input, valueEl);
        return input;
    }

    private hideFloodFillUI(): void {
        document.removeEventListener('mousedown', this.onFloodFillDocumentMouseDown, true);
        document.removeEventListener('touchstart', this.onFloodFillDocumentTouchStart, true);
        this.floodFillRibbonEl?.remove();
        this.floodFillRibbonEl = null;
        this.floodFillToleranceInputEl = null;
        this.floodFillEdgeInputEl = null;
        this.document?.setTransientHistory(undefined);
    }

    private onFloodFillDocumentMouseDown = (e: MouseEvent): void => {
        if (!this.floodFillEditingContext) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (this.floodFillRibbonEl?.contains(target)) return;
        if (target === this.canvas) return;
        void this.commitFloodFillContext();
    };

    private onFloodFillDocumentTouchStart = (e: TouchEvent): void => {
        if (!this.floodFillEditingContext) return;
        const target = e.target as Node | null;
        if (!target) return;
        if (this.floodFillRibbonEl?.contains(target)) return;
        if (target === this.canvas) return;
        void this.commitFloodFillContext();
    };

    private resetFloodFillEditHistory(): void {
        this.floodFillUndoStack = [];
        this.floodFillRedoStack = [];
        this.pushFloodFillSnapshot();
        this.document?.onHistoryChanged();
    }

    private pushFloodFillSnapshot(snapshot: FloodFillSnapshot = this.currentFloodFillSnapshot()): void {
        const current = this.floodFillUndoStack[this.floodFillUndoStack.length - 1];
        if (current && this.floodFillSnapshotsEqual(current, snapshot)) return;
        this.floodFillUndoStack.push({ ...snapshot });
        this.floodFillRedoStack = [];
        this.document?.onHistoryChanged();
    }

    private async undoFloodFillEdit(): Promise<void> {
        if (this.fillInProgress) return;
        if (this.floodFillUndoStack.length <= 1) {
            await this.cancelFloodFillContext();
            return;
        }
        const current = this.floodFillUndoStack.pop()!;
        this.floodFillRedoStack.push(current);
        await this.applyFloodFillSnapshot(this.floodFillUndoStack[this.floodFillUndoStack.length - 1]);
        this.document?.onHistoryChanged();
    }

    private async redoFloodFillEdit(): Promise<void> {
        if (this.fillInProgress) return;
        const next = this.floodFillRedoStack.pop();
        if (!next) return;
        this.floodFillUndoStack.push(next);
        await this.applyFloodFillSnapshot(next);
        this.document?.onHistoryChanged();
    }

    private currentFloodFillSnapshot(): FloodFillSnapshot {
        return {
            tolerance: this.fillTolerance,
            edgeSensitivity: this.fillEdgeSensitivity
        };
    }

    private async applyFloodFillSnapshot(snapshot: FloodFillSnapshot): Promise<void> {
        this.fillTolerance = snapshot.tolerance;
        this.fillEdgeSensitivity = snapshot.edgeSensitivity;
        if (this.floodFillToleranceInputEl) this.floodFillToleranceInputEl.value = String(snapshot.tolerance);
        if (this.floodFillEdgeInputEl) this.floodFillEdgeInputEl.value = String(snapshot.edgeSensitivity);
        await this.renderFloodFillPreview();
    }

    private floodFillSnapshotsEqual(a: FloodFillSnapshot, b: FloodFillSnapshot): boolean {
        return a.tolerance === b.tolerance && a.edgeSensitivity === b.edgeSensitivity;
    }

    private async cancelFloodFillContext(): Promise<void> {
        if (!this.floodFillEditingContext) return;
        while (this.floodFillPreviewPromise) {
            await this.floodFillPreviewPromise;
        }

        this.floodFillPreviewQueued = false;
        this.floodFillPreviewToken++;
        const canvas = this.activeCanvas();
        if (canvas && this.floodFillBaselineFixer) {
            await canvas.fix(this.floodFillBaselineFixer, false);
        }
        this.resetFloodFillState();
    }

    private resetFloodFillState(): void {
        this.hideFloodFillUI();
        this.floodFillEditingContext = false;
        this.floodFillSeed = null;
        this.floodFillBaselineFixer = null;
        this.floodFillPreviewResult = null;
        this.floodFillPreviewQueued = false;
        this.floodFillPreviewPromise = null;
        this.floodFillUndoStack = [];
        this.floodFillRedoStack = [];
        this.fillInProgress = false;
    }

    private updateFillStats(metrics: CanvasFloodFillResult['metrics']): void {
        const bounds = `${metrics.bounds.size.width}x${metrics.bounds.size.height}`;
        console.debug(
            `[FloodFill] ${metrics.mode} tuning=${metrics.tuningMode} total=${metrics.totalMs.toFixed(1)}ms dry=${metrics.dryMs.toFixed(1)}ms source=${metrics.sourceCopyMs.toFixed(1)}ms gpu=${metrics.gpuMs.toFixed(1)}ms post=${metrics.postProcessMs.toFixed(1)}ms history=${metrics.historyMs.toFixed(1)}ms update=${metrics.updateMs.toFixed(1)}ms readback=${metrics.readbackMs.toFixed(1)}ms iterations=${metrics.iterations} dispatch=${metrics.dispatchIterations} substeps=${metrics.substeps} tile=${metrics.tileSize} batch=${metrics.batchSize} bounds=${bounds}`
        );
    }

    private eventPoint(e: MouseEvent | TouchEvent): Point {
        let clientX = 0;
        let clientY = 0;
        if (e instanceof MouseEvent) {
            clientX = e.clientX;
            clientY = e.clientY;
        } else {
            clientX = e.touches[0]?.clientX ?? clientX;
            clientY = e.touches[0]?.clientY ?? clientY;
        }

        const rect = this.canvas.getBoundingClientRect();
        return new Point(
            ((clientX - rect.left) / Math.max(1, rect.width)) * this.canvas.width,
            this.canvas.height - ((clientY - rect.top) / Math.max(1, rect.height)) * this.canvas.height
        );
    }

    private eventStylus(e: MouseEvent | TouchEvent): Stylus {
        if (e instanceof MouseEvent) return new Stylus();

        const touch = e.touches[0];
        if ((touch as any)?.touchType === 'stylus') {
            const pressure = this.stylusEventCount < 2 ? 0 : touch.force;
            this.stylusEventCount++;
            const altitude = 1.0 - (touch as any).altitudeAngle / (0.5 * Math.PI);
            const azimuth = 0.25 - (touch as any).azimuthAngle / (2 * Math.PI);
            return new Stylus(pressure, altitude, azimuth);
        }
        return new Stylus();
    }
}
