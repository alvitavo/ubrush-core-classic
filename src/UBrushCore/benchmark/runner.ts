import { Canvas } from '../canvas/Canvas';
import { WGPUContext } from '../gpu/webgpu/WGPUContext';
import { Point } from '../common/Point';
import { Stylus } from '../common/Stylus';
import { WGPUProgramManager } from '../program/webgpu/WGPUProgramManager';
import { Common } from '../common/Common';
import { AffineTransform } from '../common/AffineTransform';
import { RenderObjectBlend } from '../gpu/RenderObject';
import { Color } from '../common/Color';

export type Mode = 'throughput' | 'frame' | 'animate' | 'throughput-batch' | 'animate-batch';
export type AnimationStyle = 'translate' | 'scale' | 'rotate';

export interface RunResult {
    mode: Mode;
    n: number;                  // number of input points
    cpuMs: number;              // wall-clock around moveTo..endLine (no GPU flush)
    flushMs: number;            // wall-clock including queue flush at end
    pointsPerSec: number;       // n / (flushMs / 1000)
    frameMs?: { p50: number; p95: number; p99: number; max: number; count: number };
    heapDeltaMb?: number;
    drawCalls?: number;         // total GPU draw calls during measured window
    // animate-mode only
    frames?: number;
    durationMs?: number;
    avgFps?: number;
    animationStyle?: AnimationStyle;
}

interface DrawCallCounter { count: number; }

let drawCallCounter: DrawCallCounter | null = null;
let prototypePatched = false;

// Patch GPURenderPassEncoder.prototype.draw* once so any pass created later
// increments the same counter. WebGPU has no global "draw call" probe like
// WebGL had, so this prototype hook is the simplest way to keep the same
// metric available across the codebase.
export function installDrawCallCounter(): void {
    if (prototypePatched) return;
    prototypePatched = true;

    drawCallCounter = { count: 0 };
    const counter = drawCallCounter;

    const proto = (globalThis as any).GPURenderPassEncoder?.prototype;
    if (!proto) {
        console.warn('GPURenderPassEncoder prototype unavailable — drawCalls will be undefined');
        return;
    }

    for (const method of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
        const orig = proto[method];
        if (typeof orig !== 'function') continue;
        proto[method] = function (...args: any[]) {
            counter.count++;
            return orig.apply(this, args);
        };
    }
}

function resetDrawCalls(): void {
    if (drawCallCounter) drawCallCounter.count = 0;
}

function readDrawCalls(): number | undefined {
    return drawCallCounter?.count;
}

const POINTS_PER_FRAME = 4; // realistic batch size for frame mode

function compositeToScreen(canvas: Canvas, ctx: WGPUContext): void {
    ctx.clearRenderTarget(null, Color.white());
    WGPUProgramManager.getInstance().fillRectProgram.fill(null, {
        targetRect: Common.stageRect(),
        source: canvas.outputRenderTarget.texture,
        sourceRect: Common.stageRect(),
        canvasRect: Common.stageRect(),
        transform: new AffineTransform(),
        blend: RenderObjectBlend.Normal,
    });
}

// WebGPU equivalent of gl.finish() — wait until all already-submitted work
// has finished on the GPU queue.
async function waitForGPU(ctx: WGPUContext): Promise<void> {
    await ctx.device.queue.onSubmittedWorkDone();
}

function readHeapMb(): number | undefined {
    const mem = (performance as any).memory;
    if (!mem || typeof mem.usedJSHeapSize !== 'number') return undefined;
    return mem.usedJSHeapSize / (1024 * 1024);
}

function quantile(sorted: number[], q: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
}

export async function runThroughput(
    canvas: Canvas,
    ctx: WGPUContext,
    points: Point[],
    batched: boolean = false,
): Promise<RunResult> {
    const heapBefore = readHeapMb();
    const stylus = new Stylus();

    // Warm up: composite once so any first-time pipeline creation is settled.
    compositeToScreen(canvas, ctx);
    await waitForGPU(ctx);

    if (batched) canvas.setStrokeBatchingEnabled(true);
    try {
        resetDrawCalls();
        const t0 = performance.now();
        canvas.moveTo(points[0], stylus);
        for (let i = 1; i < points.length - 1; i++) {
            canvas.lineTo(points[i], stylus);
        }
        await canvas.endLine(points[points.length - 1], stylus);
        const t1 = performance.now();

        await waitForGPU(ctx);
        const t2 = performance.now();
        const drawCalls = readDrawCalls();

        compositeToScreen(canvas, ctx);
        await waitForGPU(ctx);

        const heapAfter = readHeapMb();
        const heapDelta = heapBefore !== undefined && heapAfter !== undefined
            ? heapAfter - heapBefore : undefined;

        const flushMs = t2 - t0;
        return {
            mode: batched ? 'throughput-batch' : 'throughput',
            n: points.length,
            cpuMs: t1 - t0,
            flushMs,
            pointsPerSec: points.length / (flushMs / 1000),
            heapDeltaMb: heapDelta,
            drawCalls,
        };
    } finally {
        if (batched) canvas.setStrokeBatchingEnabled(false);
    }
}

// Translate amplitude as fraction of canvas dimension; scale range [1-S, 1+S];
// rotate covers a full turn per loop. One loop = 1 second so longer durations
// just repeat the same motion — keeps per-frame work consistent across durations.
const ANIM_TRANSLATE_AX = 0.10;
const ANIM_TRANSLATE_AY = 0.10;
const ANIM_SCALE_RANGE = 0.5;
const ANIM_LOOP_SEC = 1.0;

function applyAnimTransform(
    src: Point[],
    style: AnimationStyle,
    t: number,           // phase in [0, 1)
    cx: number, cy: number,
    w: number, h: number,
    out: Point[],
): void {
    const TWO_PI = Math.PI * 2;
    if (style === 'translate') {
        const dx = ANIM_TRANSLATE_AX * w * Math.sin(TWO_PI * t);
        const dy = ANIM_TRANSLATE_AY * h * Math.sin(TWO_PI * t * 0.7);
        for (let i = 0; i < src.length; i++) {
            out[i].x = src[i].x + dx;
            out[i].y = src[i].y + dy;
        }
    } else if (style === 'scale') {
        const s = 1.0 + ANIM_SCALE_RANGE * Math.sin(TWO_PI * t);
        for (let i = 0; i < src.length; i++) {
            out[i].x = cx + (src[i].x - cx) * s;
            out[i].y = cy + (src[i].y - cy) * s;
        }
    } else { // rotate
        const theta = TWO_PI * t;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        for (let i = 0; i < src.length; i++) {
            const dx = src[i].x - cx;
            const dy = src[i].y - cy;
            out[i].x = cx + dx * cosT - dy * sinT;
            out[i].y = cy + dx * sinT + dy * cosT;
        }
    }
}

export function runAnimation(
    canvas: Canvas,
    ctx: WGPUContext,
    points: Point[],
    style: AnimationStyle,
    durationSec: number,
    canvasWidth: number,
    canvasHeight: number,
    batched: boolean = false,
): Promise<RunResult> {
    return new Promise((resolve) => {
        const heapBefore = readHeapMb();
        const cw = canvasWidth;
        const ch = canvasHeight;
        const cx = cw / 2;
        const cy = ch / 2;

        const buf: Point[] = new Array(points.length);
        for (let i = 0; i < points.length; i++) buf[i] = new Point(0, 0);

        compositeToScreen(canvas, ctx);

        void waitForGPU(ctx).then(() => {
            resetDrawCalls();
            const frameDurations: number[] = [];
            const startTime = performance.now();
            let frames = 0;

            const step = async () => {
                const now = performance.now();
                const elapsed = now - startTime;
                if (elapsed >= durationSec * 1000) {
                    await waitForGPU(ctx);
                    const t1 = performance.now();
                    const drawCalls = readDrawCalls();
                    const durationMs = t1 - startTime;
                    const heapAfter = readHeapMb();
                    const heapDelta = heapBefore !== undefined && heapAfter !== undefined
                        ? heapAfter - heapBefore : undefined;
                    const sorted = [...frameDurations].sort((a, b) => a - b);
                    const avgFps = frames / (durationMs / 1000);
                    if (batched) canvas.setStrokeBatchingEnabled(false);
                    resolve({
                        mode: batched ? 'animate-batch' : 'animate',
                        n: points.length,
                        cpuMs: durationMs,
                        flushMs: durationMs,
                        pointsPerSec: (points.length * frames) / (durationMs / 1000),
                        frameMs: {
                            p50: quantile(sorted, 0.5),
                            p95: quantile(sorted, 0.95),
                            p99: quantile(sorted, 0.99),
                            max: sorted[sorted.length - 1] ?? 0,
                            count: sorted.length,
                        },
                        heapDeltaMb: heapDelta,
                        drawCalls,
                        frames,
                        durationMs,
                        avgFps,
                        animationStyle: style,
                    });
                    return;
                }

                const phase = (elapsed / 1000) / ANIM_LOOP_SEC;
                const t = phase - Math.floor(phase);
                applyAnimTransform(points, style, t, cx, cy, cw, ch, buf);

                const frameStart = performance.now();
                const stylus = new Stylus();
                canvas.clear();
                if (batched) canvas.setStrokeBatchingEnabled(true);
                canvas.moveTo(buf[0], stylus);
                for (let i = 1; i < buf.length - 1; i++) {
                    canvas.lineTo(buf[i], stylus);
                }
                await canvas.endLine(buf[buf.length - 1], stylus);
                if (batched) canvas.setStrokeBatchingEnabled(false);
                compositeToScreen(canvas, ctx);
                const frameEnd = performance.now();
                frameDurations.push(frameEnd - frameStart);
                frames++;

                requestAnimationFrame(() => { void step(); });
            };

            requestAnimationFrame(() => { void step(); });
        });
    });
}

export function runFrame(
    canvas: Canvas,
    ctx: WGPUContext,
    points: Point[],
): Promise<RunResult> {
    return new Promise((resolve) => {
        const heapBefore = readHeapMb();
        const stylus = new Stylus();
        const frameDurations: number[] = [];

        compositeToScreen(canvas, ctx);

        void waitForGPU(ctx).then(() => {
            resetDrawCalls();
            canvas.moveTo(points[0], stylus);
            let i = 1;
            const t0 = performance.now();

            const step = async () => {
                const frameStart = performance.now();
                const end = Math.min(points.length - 1, i + POINTS_PER_FRAME);
                for (; i < end; i++) {
                    canvas.lineTo(points[i], stylus);
                }
                const isLast = i >= points.length - 1;
                if (isLast) {
                    await canvas.endLine(points[points.length - 1], stylus);
                }
                compositeToScreen(canvas, ctx);
                const frameEnd = performance.now();
                frameDurations.push(frameEnd - frameStart);

                if (isLast) {
                    await waitForGPU(ctx);
                    const t1 = performance.now();
                    const drawCalls = readDrawCalls();
                    const heapAfter = readHeapMb();
                    const heapDelta = heapBefore !== undefined && heapAfter !== undefined
                        ? heapAfter - heapBefore : undefined;

                    const sorted = [...frameDurations].sort((a, b) => a - b);
                    resolve({
                        mode: 'frame',
                        n: points.length,
                        cpuMs: t1 - t0,
                        flushMs: t1 - t0,
                        pointsPerSec: points.length / ((t1 - t0) / 1000),
                        frameMs: {
                            p50: quantile(sorted, 0.5),
                            p95: quantile(sorted, 0.95),
                            p99: quantile(sorted, 0.99),
                            max: sorted[sorted.length - 1] ?? 0,
                            count: sorted.length,
                        },
                        heapDeltaMb: heapDelta,
                        drawCalls,
                    });
                } else {
                    requestAnimationFrame(() => { void step(); });
                }
            };

            requestAnimationFrame(() => { void step(); });
        });
    });
}
