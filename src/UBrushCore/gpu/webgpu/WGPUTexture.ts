import base64Arraybuffer from 'base64-arraybuffer';
import UPNG from 'upng-js';

// Mirrors the API surface of gpu/Texture.ts (the WebGL2 texture wrapper) so
// program code can swap backends without changes. PNG row flip is preserved
// for parity with the WebGL2 implementation — all other textures (offscreen
// render targets, RGBA uploads) use the same coordinate system.

export class WGPUTexture {

    private device: GPUDevice;
    private texture: GPUTexture;
    private view: GPUTextureView;
    private owned: boolean;

    public width: number = 1;
    public height: number = 1;

    constructor(device: GPUDevice) {

        this.device = device;
        this.texture = this.createBacking(1, 1);
        this.view = this.texture.createView();
        this.owned = true;
        this.uploadPixels(new Uint8Array([0, 0, 255, 255]), 1, 1);

    }

    // Wrap an existing GPUTexture without taking ownership — used by
    // WGPURenderTarget so its color attachment can be sampled by other
    // programs through the same WGPUTexture API.
    public static wrapping(device: GPUDevice, texture: GPUTexture, width: number, height: number): WGPUTexture {

        const t = Object.create(WGPUTexture.prototype) as WGPUTexture;
        (t as any).device = device;
        (t as any).texture = texture;
        (t as any).view = texture.createView();
        (t as any).owned = false;
        (t as any).width = width;
        (t as any).height = height;
        return t;

    }

    public getTexture(): GPUTexture {

        return this.texture;

    }

    public getView(): GPUTextureView {

        return this.view;

    }

    public async loadFromBase64(imageURL: string): Promise<void> {

        const base64 = base64Arraybuffer.decode(imageURL.split(/data:image\/.+;base64,/)[1]);
        const img = UPNG.decode(base64);

        const raw = new Uint8Array(UPNG.toRGBA8(img)[0]);
        const rowBytes = img.width * 4;
        const flipped = new Uint8Array(raw.length);
        for (let row = 0; row < img.height; row++) {
            flipped.set(raw.subarray(row * rowBytes, (row + 1) * rowBytes), (img.height - 1 - row) * rowBytes);
        }

        this.recreate(img.width, img.height);
        this.uploadPixels(flipped, img.width, img.height);

    }

    public loadFromRGBA(data: Uint8Array, width: number, height: number): void {

        this.recreate(width, height);
        this.uploadPixels(data, width, height);

    }

    public setEmpty(): void {

        this.recreate(1, 1);
        this.uploadPixels(new Uint8Array([0, 0, 255, 255]), 1, 1);

    }

    public destroy(): void {

        if (this.owned) this.texture.destroy();

    }

    private createBacking(width: number, height: number): GPUTexture {

        return this.device.createTexture({
            size: [width, height, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

    }

    private recreate(width: number, height: number): void {

        if (this.owned) this.texture.destroy();
        this.texture = this.createBacking(width, height);
        this.view = this.texture.createView();
        this.owned = true;
        this.width = width;
        this.height = height;

    }

    private uploadPixels(data: Uint8Array, width: number, height: number): void {

        this.device.queue.writeTexture(
            { texture: this.texture },
            data as BufferSource,
            { bytesPerRow: width * 4, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 },
        );

    }

}
