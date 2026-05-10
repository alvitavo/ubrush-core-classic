import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { Rect } from "../../common/Rect";
import { AffineTransform } from "../../common/AffineTransform";
import { maskWGSL } from "../wgsl/mask.wgsl";
import {
    orthoMatrix,
    quadPositions,
    quadTexCoords,
    createLinearClampSampler,
    makeVertexBuffer,
    makeUniformBuffer,
} from "./_common";

// WebGPU port of MaskProgram. See ../wgsl/mask.wgsl.ts for shader / layout.
// Always renders with no blending (writes the masked output directly).

export class WGPUMaskProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;
    private sampler: GPUSampler;

    private pipelineCache: Map<GPUTextureFormat, GPURenderPipeline> = new Map();

    constructor(context: WGPUContext) {

        this.context = context;
        this.device = context.device;
        this.module = context.createShaderModule(maskWGSL);

        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.sampler = createLinearClampSampler(this.device);

    }

    public distroy(): void {

        this.pipelineCache.clear();

    }

    public fill(renderTarget: WGPURenderTarget | null,
        param: {
            targetRect: Rect,
            source: WGPUTexture,
            maskSource: WGPUTexture,
            sourceRect: Rect,
            transform: AffineTransform,
            canvasRect: Rect
        }): void {

        const positions = quadPositions(param.targetRect, param.transform);
        const texCoords = quadTexCoords(param.sourceRect, param.canvasRect);
        const ortho = orthoMatrix(param.canvasRect);

        const positionBuffer = makeVertexBuffer(this.device, positions);
        const texCoordBuffer = makeVertexBuffer(this.device, texCoords);

        const uniformBuffer = makeUniformBuffer(this.device, 64);
        this.device.queue.writeBuffer(uniformBuffer, 0, ortho as BufferSource);

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: param.source.getView() },
                { binding: 2, resource: param.maskSource.getView() },
                { binding: 3, resource: this.sampler },
            ],
        });

        const view = renderTarget
            ? renderTarget.view
            : this.context.presentationContext.getCurrentTexture().createView();
        const format = renderTarget ? "rgba8unorm" : this.context.presentationFormat;

        const pipeline = this.getPipeline(format);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                loadOp: "load",
                storeOp: "store",
            }],
        });
        pass.setPipeline(pipeline);
        pass.setVertexBuffer(0, positionBuffer);
        pass.setVertexBuffer(1, texCoordBuffer);
        pass.setBindGroup(0, bindGroup);
        pass.draw(4, 1, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);

        positionBuffer.destroy();
        texCoordBuffer.destroy();
        uniformBuffer.destroy();

    }

    private getPipeline(format: GPUTextureFormat): GPURenderPipeline {

        const cached = this.pipelineCache.get(format);
        if (cached) return cached;

        const pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout,
            vertex: {
                module: this.module,
                entryPoint: "vs_main",
                buffers: [
                    { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
                    { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },
                ],
            },
            fragment: {
                module: this.module,
                entryPoint: "fs_main",
                targets: [{ format }],
            },
            primitive: { topology: "triangle-strip" },
        });

        this.pipelineCache.set(format, pipeline);
        return pipeline;

    }

}
