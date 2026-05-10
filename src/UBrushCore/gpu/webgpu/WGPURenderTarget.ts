import { Size } from "../../common/Size";

// Mirrors gpu/RenderTarget.ts. The backing GPUTexture carries usage flags for
// RENDER_ATTACHMENT (drawn into), TEXTURE_BINDING (sampled by other passes),
// and COPY_SRC (readPixels uses copyTextureToBuffer).

export class WGPURenderTarget {

    public readonly size: Size;
    public readonly texture: GPUTexture;
    public readonly view: GPUTextureView;

    constructor(device: GPUDevice, size: Size) {

        this.size = size;

        this.texture = device.createTexture({
            size: [size.width, size.height, 1],
            format: "rgba8unorm",
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC,
        });

        this.view = this.texture.createView();

    }

    public destroy(): void {

        this.texture.destroy();

    }

}
