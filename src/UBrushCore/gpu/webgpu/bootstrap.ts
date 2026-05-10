// Async WebGPU bootstrap: requests adapter/device and configures the canvas's
// presentation context. Throws on missing WebGPU support — callers handle UX.

export interface WGPUBootstrap {
    device: GPUDevice;
    presentationContext: GPUCanvasContext;
    presentationFormat: GPUTextureFormat;
}

export async function bootstrapWebGPU(canvas: HTMLCanvasElement): Promise<WGPUBootstrap> {

    if (!navigator.gpu) {
        throw new Error("WebGPU not supported on this browser");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("WebGPU adapter is not available");
    }

    const device = await adapter.requestDevice();

    const presentationContext = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!presentationContext) {
        throw new Error("Failed to acquire WebGPU canvas context");
    }

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    presentationContext.configure({
        device,
        format: presentationFormat,
        alphaMode: "premultiplied",
    });

    return { device, presentationContext, presentationFormat };

}
