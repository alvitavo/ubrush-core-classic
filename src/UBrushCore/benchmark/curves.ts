// Deterministic synthetic input curves for the benchmark harness.
// Each curve is parameterised in t in [0, 1]; the sampler then walks the
// curve at uniform arc-length spacing (in pixels) so that the number of
// emitted samples is a function of curve length and target spacing only.

import { Point } from '../common/Point';

export type CurveKind = 'line' | 'sine' | 'spiral';

export interface CurveSpec {
    kind: CurveKind;
    canvasWidth: number;
    canvasHeight: number;
}

type CurveFn = (t: number) => { x: number; y: number };

function curveFn(spec: CurveSpec): CurveFn {
    const cx = spec.canvasWidth / 2;
    const cy = spec.canvasHeight / 2;
    const w = spec.canvasWidth;
    const h = spec.canvasHeight;
    const minDim = Math.min(w, h);

    switch (spec.kind) {
        case 'line': {
            const x0 = cx - w * 0.4;
            const x1 = cx + w * 0.4;
            return (t) => ({ x: x0 + (x1 - x0) * t, y: cy });
        }
        case 'sine': {
            const x0 = cx - w * 0.4;
            const x1 = cx + w * 0.4;
            const amp = h * 0.2;
            const cycles = 4;
            return (t) => ({
                x: x0 + (x1 - x0) * t,
                y: cy + amp * Math.sin(t * Math.PI * 2 * cycles),
            });
        }
        case 'spiral': {
            const rMax = minDim * 0.4;
            const turns = 4;
            return (t) => {
                const r = rMax * t;
                const theta = t * Math.PI * 2 * turns;
                return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) };
            };
        }
    }
}

/**
 * Sample a curve at approximately uniform arc length (in pixels).
 * Uses a fine polyline approximation, then walks it emitting one point
 * each time we accumulate `spacingPx` of arc length. Always emits the
 * first and last point.
 */
export function sampleUniformSpacing(spec: CurveSpec, spacingPx: number): Point[] {
    const fn = curveFn(spec);
    const FINE = 10000;
    const pts: { x: number; y: number }[] = new Array(FINE + 1);
    for (let i = 0; i <= FINE; i++) pts[i] = fn(i / FINE);

    const out: Point[] = [];
    out.push(new Point(pts[0].x, pts[0].y));

    let accum = 0;
    let prev = pts[0];
    for (let i = 1; i <= FINE; i++) {
        const cur = pts[i];
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        const seg = Math.hypot(dx, dy);
        accum += seg;
        while (accum >= spacingPx) {
            const overshoot = accum - spacingPx;
            const f = seg === 0 ? 0 : (seg - overshoot) / seg;
            out.push(new Point(prev.x + dx * f, prev.y + dy * f));
            accum -= spacingPx;
        }
        prev = cur;
    }

    const last = pts[FINE];
    const lastEmitted = out[out.length - 1];
    if (Math.hypot(last.x - lastEmitted.x, last.y - lastEmitted.y) > 0.5) {
        out.push(new Point(last.x, last.y));
    }
    return out;
}
