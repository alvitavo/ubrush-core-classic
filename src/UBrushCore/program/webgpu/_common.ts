import { Rect } from "../../common/Rect";
import { Point } from "../../common/Point";
import { AffineTransform } from "../../common/AffineTransform";
import { RenderObjectBlend } from "../../gpu/RenderObject";

// Shared helpers used by all WebGPU program classes. Mirrors the small
// utilities that were inlined in each WebGL2 program (ortho matrix,
// quad vertex layout, sampler, blend-state mapping).

export function blendStateFor(blend: RenderObjectBlend): GPUBlendState | undefined {

    switch (blend) {

        case RenderObjectBlend.None:
            return undefined;

        case RenderObjectBlend.Add:
            return {
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            };

        case RenderObjectBlend.Screen:
            // GLSL used: gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR)
            return {
                color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
            };

        case RenderObjectBlend.Max:
            // GLSL used: blendFunc(ONE, ONE) + blendEquation(MAX)
            return {
                color: { srcFactor: "one", dstFactor: "one", operation: "max" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "max" },
            };

        case RenderObjectBlend.Normal:
        default:
            return {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };

    }

}

// Build the ortho matrix used by all quad-blit programs. Matches the column-
// major layout that the WebGL2 programs uploaded directly via uniformMatrix4fv.
export function orthoMatrix(canvasRect: Rect): Float32Array {

    const left = canvasRect.minX;
    const right = canvasRect.maxX;
    const bottom = canvasRect.minY;
    const top = canvasRect.maxY;
    const farZ = 1.0;
    const nearZ = -1.0;

    const ral = right + left;
    const rsl = right - left;
    const tab = top + bottom;
    const tsb = top - bottom;
    const fan = farZ + nearZ;
    const fsn = farZ - nearZ;

    return new Float32Array([
        2.0 / rsl, 0.0, 0.0, 0.0,
        0.0, 2.0 / tsb, 0.0, 0.0,
        0.0, 0.0, -2.0 / fsn, 0.0,
        -ral / rsl, -tab / tsb, -fan / fsn, 1.0,
    ]);

}

// Build the 4 corner positions for a TriangleStrip quad, optionally transformed.
export function quadPositions(targetRect: Rect, transform: AffineTransform): Float32Array {

    const x1 = targetRect.minX;
    const x2 = targetRect.maxX;
    const y1 = targetRect.minY;
    const y2 = targetRect.maxY;

    let p1 = new Point(x1, y1);
    let p2 = new Point(x2, y1);
    let p3 = new Point(x1, y2);
    let p4 = new Point(x2, y2);

    if (!transform.isIdentity()) {
        p1 = transform.applyToPoint(p1);
        p2 = transform.applyToPoint(p2);
        p3 = transform.applyToPoint(p3);
        p4 = transform.applyToPoint(p4);
    }

    return new Float32Array([
        p1.x, p1.y,
        p2.x, p2.y,
        p3.x, p3.y,
        p4.x, p4.y,
    ]);

}

// Build the 4 texture coordinates for a TriangleStrip quad, normalized into
// the canvas rect's UV space.
export function quadTexCoords(sourceRect: Rect, canvasRect: Rect): Float32Array {

    let sx1 = sourceRect.origin.x;
    let sx2 = sourceRect.origin.x + sourceRect.size.width;
    let sy1 = sourceRect.origin.y;
    let sy2 = sourceRect.origin.y + sourceRect.size.height;

    sx1 = (sx1 - canvasRect.origin.x) / canvasRect.size.width;
    sx2 = (sx2 - canvasRect.origin.x) / canvasRect.size.width;
    sy1 = (sy1 - canvasRect.origin.y) / canvasRect.size.height;
    sy2 = (sy2 - canvasRect.origin.y) / canvasRect.size.height;

    return new Float32Array([
        sx1, sy1,
        sx2, sy1,
        sx1, sy2,
        sx2, sy2,
    ]);

}

export function createLinearClampSampler(device: GPUDevice): GPUSampler {

    return device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });

}

// Allocate a GPUBuffer pre-filled with the given typed array. Used per-draw
// in the 1st-pass implementation; will be replaced with a ring allocator
// once Step 6 perf measurements are in.
export function makeVertexBuffer(device: GPUDevice, data: Float32Array): GPUBuffer {

    const buffer = device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data as BufferSource);
    return buffer;

}

export function makeUniformBuffer(device: GPUDevice, byteLength: number): GPUBuffer {

    return device.createBuffer({
        size: byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

}
