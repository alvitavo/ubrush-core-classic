import { Size } from "../../common/Size";
import { Rect } from "../../common/Rect";
import { Color } from "../../common/Color";
import { WGPUTexture } from "./WGPUTexture";
import { WGPURenderTarget } from "./WGPURenderTarget";

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

        // Caller-requested region — buffer returned to caller is always sized
        // for this region. Out-of-bound pixels are zero-filled (WebGL silently
        // returned 0s for over-bound reads; WebGPU's copyTextureToBuffer is
        // strict, so we clamp and pad here to preserve caller assumptions).
        const reqW = pixelBounds.size.width;
        const reqH = pixelBounds.size.height;
        const out = new Uint8Array(reqW * reqH * 4);

        if (reqW === 0 || reqH === 0) return out;

        const tw = renderTarget.size.width;
        const th = renderTarget.size.height;

        const sx = Math.max(0, pixelBounds.origin.x);
        const sy = Math.max(0, pixelBounds.origin.y);
        const ex = Math.min(tw, pixelBounds.origin.x + reqW);
        const ey = Math.min(th, pixelBounds.origin.y + reqH);
        const cw = Math.max(0, ex - sx);
        const ch = Math.max(0, ey - sy);

        if (cw === 0 || ch === 0) return out; // entirely outside the texture

        // bytesPerRow must be a multiple of 256 for copyTextureToBuffer.
        const unpaddedBytesPerRow = cw * 4;
        const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

        const buffer = this.device.createBuffer({
            size: paddedBytesPerRow * ch,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        const encoder = this.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            {
                texture: renderTarget.gpuTexture,
                origin: { x: sx, y: sy },
            },
            {
                buffer,
                bytesPerRow: paddedBytesPerRow,
                rowsPerImage: ch,
            },
            { width: cw, height: ch, depthOrArrayLayers: 1 },
        );
        this.device.queue.submit([encoder.finish()]);

        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(buffer.getMappedRange());

        // Place the clamped region at its correct offset within `out`.
        const dstX = sx - pixelBounds.origin.x;
        const dstY = sy - pixelBounds.origin.y;

        for (let row = 0; row < ch; row++) {
            const dstRowStart = ((dstY + row) * reqW + dstX) * 4;
            out.set(
                mapped.subarray(row * paddedBytesPerRow, row * paddedBytesPerRow + unpaddedBytesPerRow),
                dstRowStart,
            );
        }

        buffer.unmap();
        buffer.destroy();

        return out;

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

}
