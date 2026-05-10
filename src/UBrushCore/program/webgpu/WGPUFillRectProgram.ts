import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { Rect } from "../../common/Rect";
import { AffineTransform } from "../../common/AffineTransform";
import { RenderObjectBlend } from "../../gpu/RenderObject";
import { fillRectWGSL } from "../wgsl/fillRect.wgsl";
import {
    blendStateFor,
    orthoMatrix,
    quadPositions,
    quadTexCoords,
    createLinearClampSampler,
    makeVertexBuffer,
    makeUniformBuffer,
} from "./_common";

// WebGPU port of FillRectProgram. See ../wgsl/fillRect.wgsl.ts for the
// shader and bind group / vertex buffer layout contract.

export class WGPUFillRectProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;
    private sampler: GPUSampler;

    private pipelineCache: Map<string, GPURenderPipeline> = new Map();

    constructor(context: WGPUContext) {

        this.context = context;
        this.device = context.device;
        this.module = context.createShaderModule(fillRectWGSL);

        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.sampler = createLinearClampSampler(this.device);

    }

    public distroy(): void {

        // Pipelines / shader module are owned by the device; nothing to free explicitly.
        this.pipelineCache.clear();

    }

    public fill(renderTarget: WGPURenderTarget | null,
        param: {
            targetRect: Rect,
            source: WGPUTexture,
            sourceRect: Rect,
            canvasRect: Rect,
            transform: AffineTransform,
            blend: RenderObjectBlend
        }): void {

        const positions = quadPositions(param.targetRect, param.transform);
        const texCoords = quadTexCoords(param.sourceRect, param.canvasRect);
        const ortho = orthoMatrix(param.canvasRect);

        const positionBuffer = makeVertexBuffer(this.device, positions);
        const texCoordBuffer = makeVertexBuffer(this.device, texCoords);

        const uniformBuffer = makeUniformBuffer(this.device, 64); // mat4x4f
        this.device.queue.writeBuffer(uniformBuffer, 0, ortho as BufferSource);

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: param.source.getView() },
                { binding: 2, resource: this.sampler },
            ],
        });

        const view = renderTarget
            ? renderTarget.view
            : this.context.presentationContext.getCurrentTexture().createView();
        const format = renderTarget ? "rgba8unorm" : this.context.presentationFormat;

        const pipeline = this.getPipeline(param.blend, format);

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

    private getPipeline(blend: RenderObjectBlend, format: GPUTextureFormat): GPURenderPipeline {

        const key = `${blend}-${format}`;
        const cached = this.pipelineCache.get(key);
        if (cached) return cached;

        const blendState = blendStateFor(blend);

        const pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout,
            vertex: {
                module: this.module,
                entryPoint: "vs_main",
                buffers: [
                    {
                        arrayStride: 8,
                        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
                    },
                    {
                        arrayStride: 8,
                        attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }],
                    },
                ],
            },
            fragment: {
                module: this.module,
                entryPoint: "fs_main",
                targets: [{
                    format,
                    blend: blendState,
                }],
            },
            primitive: { topology: "triangle-strip" },
        });

        this.pipelineCache.set(key, pipeline);
        return pipeline;

    }

}
