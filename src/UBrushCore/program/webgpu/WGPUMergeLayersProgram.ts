import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { Rect } from "../../common/Rect";
import { AffineTransform } from "../../common/AffineTransform";
import { mergeLayersWGSL } from "../wgsl/mergeLayers.wgsl";
import {
    writeOrthoMatrix,
    writeQuadPositions,
    writeQuadTexCoords,
    createLinearClampSampler,
    makeUniformBuffer,
} from "./_common";

// WebGPU port of MergeLayersProgram. See ../wgsl/mergeLayers.wgsl.ts.
// Combines an alpha-only and a color-only texture into a single RGBA output.

export class WGPUMergeLayersProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;
    private sampler: GPUSampler;

    private pipelineCache: Map<GPUTextureFormat, GPURenderPipeline> = new Map();
    private positionBuffer?: GPUBuffer;
    private texCoordBuffer?: GPUBuffer;
    private uniformBuffer?: GPUBuffer;
    private bindGroupCache?: { alpha: WGPUTexture; color: WGPUTexture; bindGroup: GPUBindGroup };
    private positions = new Float32Array(8);
    private texCoords = new Float32Array(8);
    private ortho = new Float32Array(16);

    constructor(context: WGPUContext) {

        this.context = context;
        this.device = context.device;
        this.module = context.createShaderModule(mergeLayersWGSL);

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

        this.positionBuffer?.destroy();
        this.texCoordBuffer?.destroy();
        this.uniformBuffer?.destroy();
        this.positionBuffer = undefined;
        this.texCoordBuffer = undefined;
        this.uniformBuffer = undefined;
        this.bindGroupCache = undefined;
        this.pipelineCache.clear();

    }

    public merge(renderTarget: WGPURenderTarget | null,
        param: {
            targetRect: Rect,
            alphaSource: WGPUTexture,
            colorSource: WGPUTexture,
            sourceRect: Rect,
            canvasRect: Rect,
            transform: AffineTransform
        }): void {

        const positions = writeQuadPositions(this.positions, param.targetRect, param.transform);
        const texCoords = writeQuadTexCoords(this.texCoords, param.sourceRect, param.canvasRect);
        const ortho = writeOrthoMatrix(this.ortho, param.canvasRect);

        const positionBuffer = this.writeVertexBuffer('position', positions);
        const texCoordBuffer = this.writeVertexBuffer('texCoord', texCoords);

        const uniformBuffer = this.getUniformBuffer();
        this.device.queue.writeBuffer(uniformBuffer, 0, ortho as BufferSource);

        const bindGroup = this.getBindGroup(param.alphaSource, param.colorSource);

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

    }

    private writeVertexBuffer(kind: 'position' | 'texCoord', data: Float32Array): GPUBuffer {
        let buffer = kind === 'position' ? this.positionBuffer : this.texCoordBuffer;
        if (!buffer) {
            buffer = this.device.createBuffer({
                size: data.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            if (kind === 'position') this.positionBuffer = buffer;
            else this.texCoordBuffer = buffer;
        }
        this.device.queue.writeBuffer(buffer, 0, data as BufferSource);
        return buffer;
    }

    private getUniformBuffer(): GPUBuffer {
        if (!this.uniformBuffer) this.uniformBuffer = makeUniformBuffer(this.device, 64);
        return this.uniformBuffer;
    }

    private getBindGroup(alpha: WGPUTexture, color: WGPUTexture): GPUBindGroup {
        const cached = this.bindGroupCache;
        if (cached?.alpha === alpha && cached.color === color) return cached.bindGroup;
        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.getUniformBuffer() } },
                { binding: 1, resource: alpha.getView() },
                { binding: 2, resource: color.getView() },
                { binding: 3, resource: this.sampler },
            ],
        });
        this.bindGroupCache = { alpha, color, bindGroup };
        return bindGroup;
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
