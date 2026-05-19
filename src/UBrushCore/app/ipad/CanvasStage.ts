import { Canvas } from '../../canvas/Canvas';
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

const STRAIGHTEN_HOLD_MS = 1200;

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
    private straightLineActive = false;
    private straightLineActivationPromise: Promise<void> | null = null;
    private straightLineStartPoint: Point | null = null;
    private straightLineStartStylus: Stylus | null = null;
    private straightLineStrokeGroup: FixerGroup | null = null;

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

        const canvas = this.document.selectedCanvas;
        if (!canvas) return;

        this.stylusEventCount = 0;
        this.lastPoint = this.eventPoint(e);
        this.lastStylus = this.eventStylus(e);
        this.resetStraightLineState(false);
        this.straightLineStartPoint = this.lastPoint.clone();
        this.straightLineStartStylus = new Stylus(
            this.lastStylus.pressure,
            this.lastStylus.altitudeAngle,
            this.lastStylus.azimuthAngle
        );
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
        if (this.straightLineActive) {
            this.renderStraightLinePreview(canvas);
            return;
        }

        canvas.lineTo(this.lastPoint, this.lastStylus);
    };

    private onPointerUp = async (e: MouseEvent | TouchEvent): Promise<void> => {
        e.preventDefault();
        this.clearStraightLineTimer();
        if (this.straightLineActivationPromise) {
            await this.straightLineActivationPromise;
        }

        const canvas = this.activeCanvas();
        if (canvas && this.straightLineActive && this.straightLineStrokeGroup) {
            this.renderStraightLinePreview(canvas);
            const fixerGroup = await canvas.commitStraightenedLine(this.straightLineStrokeGroup);
            this.document?.pushCanvasHistory(canvas, fixerGroup);
        } else if (canvas) {
            await canvas.endLine(this.lastPoint, this.lastStylus);
        }

        this.resetStraightLineState(false);

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
            this.straightLineActivationPromise = this.activateStraightLine(token);
        }, STRAIGHTEN_HOLD_MS);
    }

    private clearStraightLineTimer(): void {
        if (this.straightLineTimer === null) return;
        window.clearTimeout(this.straightLineTimer);
        this.straightLineTimer = null;
    }

    private async activateStraightLine(token: number): Promise<void> {
        const canvas = this.activeCanvas();
        if (!canvas || token !== this.straightLineToken) return;
        if (!this.straightLineStartPoint || !this.straightLineStartStylus) return;

        this.straightLineActive = true;
        this.renderStraightLinePreview(canvas);
    }

    private renderStraightLinePreview(canvas: Canvas): void {
        if (!this.straightLineStartPoint || !this.straightLineStartStylus) return;
        canvas.replaceActiveLineWithStraightLine(
            this.straightLineStartPoint,
            this.lastPoint,
            this.straightLineStartStylus,
            this.lastStylus,
            { disableSmudging: canvas.brushUsesSmudging() }
        );
    }

    private resetStraightLineState(clearTimer: boolean = true): void {
        if (clearTimer) this.clearStraightLineTimer();
        this.straightLineToken++;
        this.straightLineActive = false;
        this.straightLineActivationPromise = null;
        this.straightLineStartPoint = null;
        this.straightLineStartStylus = null;
        this.straightLineStrokeGroup = null;
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
