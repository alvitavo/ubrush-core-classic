import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { Rect } from "../../common/Rect";
import { AffineTransform } from "../../common/AffineTransform";
import { separateLayersWGSL } from "../wgsl/separateLayers.wgsl";
import {
    orthoMatrix,
    quadPositions,
    quadTexCoords,
    createLinearClampSampler,
    makeVertexBuffer,
    makeUniformBuffer,
} from "./_common";

// WebGPU port of SeparateLayersProgram. Splits a source RGBA texture into
// an alpha-only target and a color-only target by running the same pipeline
// twice with different `targetChannel` uniform values.

export class WGPUSeparateLayersProgram {

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
        this.module = context.createShaderModule(separateLayersWGSL);

        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
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

        this.pipelineCache.clear();

    }

    public separate(
        alphaRenderTarget: WGPURenderTarget,
        colorRenderTarget: WGPURenderTarget,
        param: {
            targetRect: Rect,
            source: WGPUTexture,
            sourceRect: Rect,
            canvasRect: Rect
        }): void {

        const identity = new AffineTransform();

        const positions = quadPositions(param.targetRect, identity);
        const texCoords = quadTexCoords(param.sourceRect, param.canvasRect);
        const ortho = orthoMatrix(param.canvasRect);

        const positionBuffer = makeVertexBuffer(this.device, positions);
        const texCoordBuffer = makeVertexBuffer(this.device, texCoords);

        // U layout (WGSL): mat4x4f orthoMatrix (64) + i32 targetChannel (4) — 80 bytes total.
        // Pad to 96 so the next 16-byte boundary is honored.
        const uniformBytes = 96;
        const alphaUniform = makeUniformBuffer(this.device, uniformBytes);
        const colorUniform = makeUniformBuffer(this.device, uniformBytes);

        const alphaBytes = new ArrayBuffer(uniformBytes);
        new Float32Array(alphaBytes, 0, 16).set(ortho);
        new Int32Array(alphaBytes, 64, 1)[0] = 0;

        const colorBytes = new ArrayBuffer(uniformBytes);
        new Float32Array(colorBytes, 0, 16).set(ortho);
        new Int32Array(colorBytes, 64, 1)[0] = 1;

        this.device.queue.writeBuffer(alphaUniform, 0, alphaBytes);
        this.device.queue.writeBuffer(colorUniform, 0, colorBytes);

        const alphaBindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: alphaUniform } },
                { binding: 1, resource: param.source.getView() },
                { binding: 2, resource: this.sampler },
            ],
        });

        const colorBindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: colorUniform } },
                { binding: 1, resource: param.source.getView() },
                { binding: 2, resource: this.sampler },
            ],
        });

        const pipeline = this.getPipeline("rgba8unorm");

        const encoder = this.device.createCommandEncoder();

        // alpha pass
        {
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: alphaRenderTarget.view,
                    loadOp: "load",
                    storeOp: "store",
                }],
            });
            pass.setPipeline(pipeline);
            pass.setVertexBuffer(0, positionBuffer);
            pass.setVertexBuffer(1, texCoordBuffer);
            pass.setBindGroup(0, alphaBindGroup);
            pass.draw(4, 1, 0, 0);
            pass.end();
        }

        // color pass
        {
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: colorRenderTarget.view,
                    loadOp: "load",
                    storeOp: "store",
                }],
            });
            pass.setPipeline(pipeline);
            pass.setVertexBuffer(0, positionBuffer);
            pass.setVertexBuffer(1, texCoordBuffer);
            pass.setBindGroup(0, colorBindGroup);
            pass.draw(4, 1, 0, 0);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);

        positionBuffer.destroy();
        texCoordBuffer.destroy();
        alphaUniform.destroy();
        colorUniform.destroy();

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
