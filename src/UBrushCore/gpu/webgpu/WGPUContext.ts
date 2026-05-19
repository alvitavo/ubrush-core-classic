import { Size } from "../../common/Size";
import { Rect } from "../../common/Rect";
import { Color } from "../../common/Color";
import { WGPUTexture } from "./WGPUTexture";
import { WGPURenderTarget } from "./WGPURenderTarget";

interface ReadPixelsRequest {
    renderTarget: WGPURenderTarget;
    pixelBounds: Rect;
}

interface PreparedReadPixelsRequest {
    out: Uint8Array;
    buffer?: GPUBuffer;
    reqW: number;
    reqH: number;
    cw: number;
    ch: number;
    unpaddedBytesPerRow: number;
    paddedBytesPerRow: number;
    dstRow0: number;
    dstX: number;
    texture: GPUTexture;
    origin: { x: number; y: number };
}

// Counterpart to gpu/UBrushContext.ts for the WebGPU backend.
//
// Differences from the WebGL2 context:
// - No `render(renderObject, program)` here. Programs own their own
//   GPUShaderModule + GPURenderPipeline + bind group layouts and submit
//   their own command buffers (the WebGL2 render() abstraction does not
//   map cleanly onto WebGPU's pass model).
// - `readPixels` is async (WebGPU has no synchronous map).
// - No activateRenderTarget — the target is set per render pass at draw time.

export class WGPUContext {

    public readonly device: GPUDevice;
    public readonly presentationContext: GPUCanvasContext;
    public readonly presentationFormat: GPUTextureFormat;

    private size: Size;

    constructor(
        device: GPUDevice,
        presentationContext: GPUCanvasContext,
        presentationFormat: GPUTextureFormat,
        size: Size,
    ) {

        this.device = device;
        this.presentationContext = presentationContext;
        this.presentationFormat = presentationFormat;
        this.size = size;

    }

    public createTexture(): WGPUTexture {

        return new WGPUTexture(this.device);

    }

    public deleteTexture(texture: WGPUTexture): void {

        texture.destroy();

    }

    public createRenderTarget(size: Size): WGPURenderTarget {

        return new WGPURenderTarget(this.device, size);

    }

    public deleteRenderTarget(renderTarget: WGPURenderTarget): void {

        renderTarget.destroy();

    }

    public createShaderModule(wgsl: string): GPUShaderModule {

        return this.device.createShaderModule({ code: wgsl });

    }

    public clearRenderTarget(target: WGPURenderTarget | null, color: Color): void {

        const view = target ? target.view : this.presentationContext.getCurrentTexture().createView();

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                clearValue: { r: color.r, g: color.g, b: color.b, a: color.a },
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        pass.end();
        this.device.queue.submit([encoder.finish()]);

    }

    public async readPixels(renderTarget: WGPURenderTarget, pixelBounds: Rect): Promise<Uint8Array> {
        const [pixels] = await this.readPixelsBatch([{ renderTarget, pixelBounds }]);
        return pixels;
    }

    public async readPixelsBatch(requests: ReadPixelsRequest[]): Promise<Uint8Array[]> {

        // Engine code throughout the codebase passes pixelBounds with a
        // framebuffer y-up convention (y=0 = bottom of the framebuffer — the
        // WebGL convention this codebase grew up on). Convert to texture
        // coords (y=0 = top of the texture) before issuing copyTextureToBuffer.
        //
        // The returned buffer follows the WebGPU texture layout: row 0 =
        // visual top of the requested region. Combined with the V-flipped
        // quadTexCoords used by the quad-blit programs, this round-trips
        // correctly when the caller re-uploads via loadFromRGBA and draws
        // through fillRectProgram (e.g. fixer apply path).

        const prepared = requests.map((request) => this.prepareReadPixels(request.renderTarget, request.pixelBounds));
        const encoder = this.device.createCommandEncoder();

        for (const item of prepared) {
            if (!item.buffer) continue;
            encoder.copyTextureToBuffer(
                {
                    texture: item.texture,
                    origin: item.origin,
                },
                {
                    buffer: item.buffer,
                    bytesPerRow: item.paddedBytesPerRow,
                    rowsPerImage: item.ch,
                },
                { width: item.cw, height: item.ch, depthOrArrayLayers: 1 },
            );
        }

        this.device.queue.submit([encoder.finish()]);

        await Promise.all(prepared.map((item) => item.buffer?.mapAsync(GPUMapMode.READ) ?? Promise.resolve()));

        for (const item of prepared) {
            if (!item.buffer) continue;
            const mapped = new Uint8Array(item.buffer.getMappedRange());

            for (let r = 0; r < item.ch; r++) {
                const outRow = item.dstRow0 + r;
                if (outRow < 0 || outRow >= item.reqH) continue;
                const dstStart = (outRow * item.reqW + item.dstX) * 4;
                item.out.set(
                    mapped.subarray(r * item.paddedBytesPerRow, r * item.paddedBytesPerRow + item.unpaddedBytesPerRow),
                    dstStart,
                );
            }

            item.buffer.unmap();
            item.buffer.destroy();
        }

        return prepared.map((item) => item.out);

    }

    private prepareReadPixels(renderTarget: WGPURenderTarget, pixelBounds: Rect): PreparedReadPixelsRequest {
        const reqW = pixelBounds.size.width;
        const reqH = pixelBounds.size.height;
        const out = new Uint8Array(reqW * reqH * 4);

        const empty = {
            out,
            reqW,
            reqH,
            cw: 0,
            ch: 0,
            unpaddedBytesPerRow: 0,
            paddedBytesPerRow: 0,
            dstRow0: 0,
            dstX: 0,
            texture: renderTarget.gpuTexture,
            origin: { x: 0, y: 0 },
        };

        if (reqW === 0 || reqH === 0) return empty;

        const tw = renderTarget.size.width;
        const th = renderTarget.size.height;

        // Caller's rect in framebuffer (y-up) coords.
        const callerL = pixelBounds.origin.x;
        const callerB = pixelBounds.origin.y;
        const callerR = callerL + reqW;
        const callerT = callerB + reqH;

        // Translate to texture (y-down) coords. Top edge of caller's rect
        // (callerT in y-up) maps to the smaller texture y (texTop).
        const texTop = th - callerT;
        const texBot = th - callerB;

        // Clamp to texture bounds.
        const sxL = Math.max(0, callerL);
        const sxR = Math.min(tw, callerR);
        const sxT = Math.max(0, texTop);
        const sxB = Math.min(th, texBot);
        const cw = Math.max(0, sxR - sxL);
        const ch = Math.max(0, sxB - sxT);

        if (cw === 0 || ch === 0) return empty; // entirely outside the texture

        // bytesPerRow must be a multiple of 256 for copyTextureToBuffer.
        const unpaddedBytesPerRow = cw * 4;
        const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

        const buffer = this.device.createBuffer({
            size: paddedBytesPerRow * ch,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        // Place clamped region into out. `out` is sized [reqW × reqH] and
        // laid out with row 0 = top of the requested region (texture y-down
        // convention). The clamped region's top edge in texture y is sxT,
        // and the requested region's top edge in texture y is texTop, so the
        // first row of mapped data lands at out row (sxT - texTop).
        const dstRow0 = sxT - texTop;
        const dstX = sxL - callerL;

        return {
            out,
            buffer,
            reqW,
            reqH,
            cw,
            ch,
            unpaddedBytesPerRow,
            paddedBytesPerRow,
            dstRow0,
            dstX,
            texture: renderTarget.gpuTexture,
            origin: { x: sxL, y: sxT },
        };

    }

    public async pixelBound(renderTarget: WGPURenderTarget): Promise<Rect> {

        const canvasRect = new Rect(0, 0, renderTarget.size.width, renderTarget.size.height);
        const pixels = await this.readPixels(renderTarget, canvasRect);
        const l = pixels.length;
        let x = 0;
        let y = 0;

        const bound = {
            top: renderTarget.size.height,
            left: renderTarget.size.width,
            right: 0,
            bottom: 0,
        };

        for (let i = 0; i < l; i += 4) {

            if (pixels[i + 3] !== 0) {

                x = (i / 4) % canvasRect.size.width;
                y = ~~((i / 4) / canvasRect.size.width);

                if (y < bound.top) bound.top = y;
                if (x < bound.left) bound.left = x;
                if (bound.right < x) bound.right = x;
                if (bound.bottom < y) bound.bottom = y;

            }

        }

        return new Rect(bound.left, bound.top, bound.right - bound.left, bound.bottom - bound.top);

    }

    public copyTexture(target: WGPURenderTarget, source: WGPURenderTarget): void {

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToTexture(
            { texture: source.gpuTexture },
            { texture: target.gpuTexture },
            { width: source.size.width, height: source.size.height, depthOrArrayLayers: 1 },
        );
        this.device.queue.submit([encoder.finish()]);

    }

    public writePixels(renderTarget: WGPURenderTarget, pixels: Uint8Array): void {

        this.device.queue.writeTexture(
            { texture: renderTarget.gpuTexture },
            pixels as BufferSource,
            { bytesPerRow: renderTarget.size.width * 4, rowsPerImage: renderTarget.size.height },
            { width: renderTarget.size.width, height: renderTarget.size.height, depthOrArrayLayers: 1 },
        );

    }

}
