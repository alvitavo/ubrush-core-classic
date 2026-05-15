import { Size } from "../../common/Size";
import { WGPUTexture } from "./WGPUTexture";

// Mirrors gpu/RenderTarget.ts. Backed by a GPUTexture that carries:
//   RENDER_ATTACHMENT  — drawn into via beginRenderPass colorAttachments
//   TEXTURE_BINDING    — sampled by other passes (via .texture wrapper)
//   COPY_SRC           — readPixels uses copyTextureToBuffer
//
// `texture` exposes a WGPUTexture wrapper (non-owning) so the same render
// target can be passed as a `source` argument to any program — the program
// classes accept WGPUTexture for sampling.

export class WGPURenderTarget {

    public readonly size: Size;
    public readonly texture: WGPUTexture;
    public readonly gpuTexture: GPUTexture;
    public readonly view: GPUTextureView;

    constructor(device: GPUDevice, size: Size) {

        this.size = size;

        this.gpuTexture = device.createTexture({
            size: [size.width, size.height, 1],
            format: "rgba8unorm",
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.STORAGE_BINDING,
        });

        this.view = this.gpuTexture.createView();
        this.texture = WGPUTexture.wrapping(device, this.gpuTexture, size.width, size.height);

    }

    public destroy(): void {

        this.gpuTexture.destroy();

    }

}
