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

        case RenderObjectBlend.Multiply:
            return {
                color: { srcFactor: "dst", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
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
    return writeOrthoMatrix(new Float32Array(16), canvasRect);
}

export function writeOrthoMatrix(out: Float32Array, canvasRect: Rect): Float32Array {

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

    out[0] = 2.0 / rsl; out[1] = 0.0;       out[2] = 0.0;        out[3] = 0.0;
    out[4] = 0.0;       out[5] = 2.0 / tsb; out[6] = 0.0;        out[7] = 0.0;
    out[8] = 0.0;       out[9] = 0.0;       out[10] = -2.0 / fsn; out[11] = 0.0;
    out[12] = -ral / rsl; out[13] = -tab / tsb; out[14] = -fan / fsn; out[15] = 1.0;
    return out;

}

// Build the 4 corner positions for a TriangleStrip quad, optionally transformed.
export function quadPositions(targetRect: Rect, transform: AffineTransform): Float32Array {
    return writeQuadPositions(new Float32Array(8), targetRect, transform);
}

export function writeQuadPositions(out: Float32Array, targetRect: Rect, transform: AffineTransform): Float32Array {

    const x1 = targetRect.minX;
    const x2 = targetRect.maxX;
    const y1 = targetRect.minY;
    const y2 = targetRect.maxY;

    if (transform.isIdentity()) {
        out[0] = x1; out[1] = y1;
        out[2] = x2; out[3] = y1;
        out[4] = x1; out[5] = y2;
        out[6] = x2; out[7] = y2;
        return out;
    }

    const p1 = transform.applyToPoint(new Point(x1, y1));
    const p2 = transform.applyToPoint(new Point(x2, y1));
    const p3 = transform.applyToPoint(new Point(x1, y2));
    const p4 = transform.applyToPoint(new Point(x2, y2));
    out[0] = p1.x; out[1] = p1.y;
    out[2] = p2.x; out[3] = p2.y;
    out[4] = p3.x; out[5] = p3.y;
    out[6] = p4.x; out[7] = p4.y;
    return out;

}

// Build the 4 texture coordinates for a TriangleStrip quad, normalized into
// the canvas rect's UV space.
//
// WebGPU defines UV (0,0) as the top-left of a texture; the WebGL backend
// this codebase grew up on used (0,0) = bottom-left. Source rects passed in
// from the engine still follow the WebGL convention (y=0 = bottom of the
// framebuffer), so we flip V here once and every quad-blit program inherits
// the correct orientation. Render targets and PNG textures continue to use
// the same coordinate system inside the engine — only the composite step
// needs the flip.
export function quadTexCoords(sourceRect: Rect, canvasRect: Rect): Float32Array {
    return writeQuadTexCoords(new Float32Array(8), sourceRect, canvasRect);
}

export function writeQuadTexCoords(out: Float32Array, sourceRect: Rect, canvasRect: Rect): Float32Array {

    let sx1 = sourceRect.origin.x;
    let sx2 = sourceRect.origin.x + sourceRect.size.width;
    let sy1 = sourceRect.origin.y;
    let sy2 = sourceRect.origin.y + sourceRect.size.height;

    sx1 = (sx1 - canvasRect.origin.x) / canvasRect.size.width;
    sx2 = (sx2 - canvasRect.origin.x) / canvasRect.size.width;
    sy1 = (sy1 - canvasRect.origin.y) / canvasRect.size.height;
    sy2 = (sy2 - canvasRect.origin.y) / canvasRect.size.height;

    out[0] = sx1; out[1] = 1.0 - sy1;
    out[2] = sx2; out[3] = 1.0 - sy1;
    out[4] = sx1; out[5] = 1.0 - sy2;
    out[6] = sx2; out[7] = 1.0 - sy2;
    return out;

}

export function createLinearClampSampler(device: GPUDevice): GPUSampler {

    return device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });

}

// For pattern textures (brush textures repeated across the stamp). The WebGL
// path used GL's per-texture WRAP_S/WRAP_T = REPEAT (when texture was POT);
// in WebGPU the wrap mode lives on the sampler, so we keep a dedicated one.
export function createLinearRepeatSampler(device: GPUDevice): GPUSampler {

    return device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
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
