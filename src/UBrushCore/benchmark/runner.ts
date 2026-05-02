import { Canvas } from '../canvas/Canvas';
import { UBrushContext } from '../gpu/UBrushContext';
import { Point } from '../common/Point';
import { Stylus } from '../common/Stylus';
import { ProgramManager } from '../program/ProgramManager';
import { Common } from '../common/Common';
import { AffineTransform } from '../common/AffineTransform';
import { RenderObjectBlend } from '../gpu/RenderObject';
import { Color } from '../common/Color';

export type Mode = 'throughput' | 'frame' | 'animate';
export type AnimationStyle = 'translate' | 'scale' | 'rotate';

export interface RunResult {
    mode: Mode;
    n: number;                  // number of input points
    cpuMs: number;              // wall-clock around moveTo..endLine (no GPU flush)
    flushMs: number;            // wall-clock including gl.finish() at end
    pointsPerSec: number;       // n / (flushMs / 1000)
    frameMs?: { p50: number; p95: number; p99: number; max: number; count: number };
    heapDeltaMb?: number;
    // animate-mode only
    frames?: number;
    durationMs?: number;
    avgFps?: number;
    animationStyle?: AnimationStyle;
}

const POINTS_PER_FRAME = 4; // realistic batch size for frame mode

function compositeToScreen(canvas: Canvas, ctx: UBrushContext): void {
    ctx.clearRenderTarget(null, Color.white());
    ProgramManager.getInstance().fillRectProgram.fill(null, {
        targetRect: Common.stageRect(),
        source: canvas.outputRenderTarget.texture,
        sourceRect: Common.stageRect(),
        canvasRect: Common.stageRect(),
        transform: new AffineTransform(),
        blend: RenderObjectBlend.Normal,
    });
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
    ctx: UBrushContext,
    gl: WebGL2RenderingContext,
    points: Point[],
): Promise<RunResult> {
    const heapBefore = readHeapMb();
    const stylus = new Stylus();

    // Warm up: composite once so any first-time GL state is settled.
    compositeToScreen(canvas, ctx);
    gl.finish();

    const t0 = performance.now();
    canvas.moveTo(points[0], stylus);
    for (let i = 1; i < points.length - 1; i++) {
        canvas.lineTo(points[i], stylus);
    }
    canvas.endLine(points[points.length - 1], stylus);
    const t1 = performance.now();

    gl.finish();
    const t2 = performance.now();

    compositeToScreen(canvas, ctx);
    gl.finish();

    const heapAfter = readHeapMb();
    const heapDelta = heapBefore !== undefined && heapAfter !== undefined
        ? heapAfter - heapBefore : undefined;

    const flushMs = t2 - t0;
    return {
        mode: 'throughput',
        n: points.length,
        cpuMs: t1 - t0,
        flushMs,
        pointsPerSec: points.length / (flushMs / 1000),
        heapDeltaMb: heapDelta,
    };
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
    ctx: UBrushContext,
    gl: WebGL2RenderingContext,
    points: Point[],
    style: AnimationStyle,
    durationSec: number,
    canvasWidth: number,
    canvasHeight: number,
): Promise<RunResult> {
    return new Promise((resolve) => {
        const heapBefore = readHeapMb();
        const cw = canvasWidth;
        const ch = canvasHeight;
        const cx = cw / 2;
        const cy = ch / 2;

        // Reusable transformed-point buffer to avoid per-frame allocations.
        const buf: Point[] = new Array(points.length);
        for (let i = 0; i < points.length; i++) buf[i] = new Point(0, 0);

        // Warm-up composite so first measured frame is not paying GL init cost.
        compositeToScreen(canvas, ctx);
        gl.finish();

        const frameDurations: number[] = [];
        const startTime = performance.now();
        let frames = 0;

        const step = () => {
            const now = performance.now();
            const elapsed = now - startTime;
            if (elapsed >= durationSec * 1000) {
                gl.finish();
                const t1 = performance.now();
                const durationMs = t1 - startTime;
                const heapAfter = readHeapMb();
                const heapDelta = heapBefore !== undefined && heapAfter !== undefined
                    ? heapAfter - heapBefore : undefined;
                const sorted = [...frameDurations].sort((a, b) => a - b);
                const avgFps = frames / (durationMs / 1000);
                resolve({
                    mode: 'animate',
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
            canvas.moveTo(buf[0], stylus);
            for (let i = 1; i < buf.length - 1; i++) {
                canvas.lineTo(buf[i], stylus);
            }
            canvas.endLine(buf[buf.length - 1], stylus);
            compositeToScreen(canvas, ctx);
            const frameEnd = performance.now();
            frameDurations.push(frameEnd - frameStart);
            frames++;

            requestAnimationFrame(step);
        };

        requestAnimationFrame(step);
    });
}

export function runFrame(
    canvas: Canvas,
    ctx: UBrushContext,
    gl: WebGL2RenderingContext,
    points: Point[],
): Promise<RunResult> {
    return new Promise((resolve) => {
        const heapBefore = readHeapMb();
        const stylus = new Stylus();
        const frameDurations: number[] = [];

        compositeToScreen(canvas, ctx);
        gl.finish();

        canvas.moveTo(points[0], stylus);
        let i = 1;
        const t0 = performance.now();

        const step = () => {
            const frameStart = performance.now();
            const end = Math.min(points.length - 1, i + POINTS_PER_FRAME);
            for (; i < end; i++) {
                canvas.lineTo(points[i], stylus);
            }
            const isLast = i >= points.length - 1;
            if (isLast) {
                canvas.endLine(points[points.length - 1], stylus);
            }
            compositeToScreen(canvas, ctx);
            const frameEnd = performance.now();
            frameDurations.push(frameEnd - frameStart);

            if (isLast) {
                gl.finish();
                const t1 = performance.now();
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
                });
            } else {
                requestAnimationFrame(step);
            }
        };

        requestAnimationFrame(step);
    });
}
