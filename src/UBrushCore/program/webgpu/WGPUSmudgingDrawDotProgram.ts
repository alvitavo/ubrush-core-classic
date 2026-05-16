import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { RenderObjectBlend } from "../../gpu/RenderObject";
import { smudgingDrawDotWGSL } from "../wgsl/smudgingDrawDot.wgsl";
import {
    blendStateFor,
    createLinearClampSampler,
    createLinearRepeatSampler,
    makeVertexBuffer,
    makeUniformBuffer,
} from "./_common";
import {
    QUAD_CORNERS,
    DotInstancePackParam,
    packInstances,
    packedInstanceFloatCount,
    INSTANCE_VERTEX_LAYOUT,
    CORNER_VERTEX_LAYOUT,
} from "./WGPUDrawDotProgram";

const UNIFORM_BYTES = 16; // i32 mode + 12 bytes pad

// WebGPU port of SmudgingDrawDotProgram. Renders two passes per call (alpha
// pass with mode=0 + alpha-channel sources, then color pass with mode=1 +
// color-channel sources). Vertex layout matches WGPUDrawDotProgram exactly.

export class WGPUSmudgingDrawDotProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;
    private sampler: GPUSampler;
    private patternSampler: GPUSampler;

    private cornerBuffer: GPUBuffer;
    private instanceBuffer?: GPUBuffer;
    private instanceBufferBytes = 0;
    private packedInstances = new Float32Array(0);
    private alphaUniform: GPUBuffer;
    private colorUniform: GPUBuffer;
    private pipeline: GPURenderPipeline | null = null;

    constructor(context: WGPUContext) {

        this.context = context;
        this.device = context.device;
        this.module = context.createShaderModule(smudgingDrawDotWGSL);

        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // tip
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // pattern
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // smudging0Ref
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // smudgingRef
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },   // clamp
                { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },   // repeat (pattern)
            ],
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.sampler = createLinearClampSampler(this.device);
        this.patternSampler = createLinearRepeatSampler(this.device);

        this.cornerBuffer = makeVertexBuffer(this.device, QUAD_CORNERS);
        this.alphaUniform = makeUniformBuffer(this.device, UNIFORM_BYTES);
        this.colorUniform = makeUniformBuffer(this.device, UNIFORM_BYTES);
        const alphaBytes = new ArrayBuffer(UNIFORM_BYTES);
        const colorBytes = new ArrayBuffer(UNIFORM_BYTES);
        new Int32Array(alphaBytes, 0, 1)[0] = 0;
        new Int32Array(colorBytes, 0, 1)[0] = 1;
        this.device.queue.writeBuffer(this.alphaUniform, 0, alphaBytes);
        this.device.queue.writeBuffer(this.colorUniform, 0, colorBytes);

    }

    public distroy(): void {

        this.cornerBuffer.destroy();
        this.instanceBuffer?.destroy();
        this.alphaUniform.destroy();
        this.colorUniform.destroy();
        this.instanceBuffer = undefined;
        this.instanceBufferBytes = 0;
        this.packedInstances = new Float32Array(0);
        this.pipeline = null;

    }

    public drawRects(
        drawingAlphaRenderTarget: WGPURenderTarget,
        drawingColorRenderTarget: WGPURenderTarget,
        param: {
            tipTexture: WGPUTexture,
            patternTexture: WGPUTexture,
            smudging0CopyAlphaTexture: WGPUTexture,
            smudging0CopyColorFramebuffer: WGPUTexture,
            smudgingCopyAlphaTexture: WGPUTexture,
            smudgingCopyColorFramebuffer: WGPUTexture,
            dualTipTexture: WGPUTexture,
            posCenterAxisU: Float32Array,
            posAxisV: Float32Array,
            tipUV: Float32Array,
            patternUVa: Float32Array,
            patternUVb: Float32Array,
            smudging0UVa: Float32Array,
            smudging0UVb: Float32Array,
            smudgingUVa: Float32Array,
            smudgingUVb: Float32Array,
            tintColor: Float32Array,
            opacity: Float32Array,
            corrosion: Float32Array,
            instanceCount: number,
            useDualTip: boolean
        }): void {

        const tip = param.useDualTip ? param.dualTipTexture : param.tipTexture;

        const packed = this.packInstances(param);
        const instanceBuffer = this.writeInstanceBuffer(packed);

        const alphaBindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.alphaUniform } },
                { binding: 1, resource: tip.getView() },
                { binding: 2, resource: param.patternTexture.getView() },
                { binding: 3, resource: param.smudging0CopyAlphaTexture.getView() },
                { binding: 4, resource: param.smudgingCopyAlphaTexture.getView() },
                { binding: 5, resource: this.sampler },
                { binding: 6, resource: this.patternSampler },
            ],
        });

        const colorBindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.colorUniform } },
                { binding: 1, resource: tip.getView() },
                { binding: 2, resource: param.patternTexture.getView() },
                { binding: 3, resource: param.smudging0CopyColorFramebuffer.getView() },
                { binding: 4, resource: param.smudgingCopyColorFramebuffer.getView() },
                { binding: 5, resource: this.sampler },
                { binding: 6, resource: this.patternSampler },
            ],
        });

        const pipeline = this.getPipeline("rgba8unorm");

        const encoder = this.device.createCommandEncoder();

        // alpha pass
        {
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: drawingAlphaRenderTarget.view,
                    loadOp: "load",
                    storeOp: "store",
                }],
            });
            pass.setPipeline(pipeline);
            pass.setVertexBuffer(0, this.cornerBuffer);
            pass.setVertexBuffer(1, instanceBuffer);
            pass.setBindGroup(0, alphaBindGroup);
            pass.draw(4, param.instanceCount, 0, 0);
            pass.end();
        }

        // color pass
        {
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: drawingColorRenderTarget.view,
                    loadOp: "load",
                    storeOp: "store",
                }],
            });
            pass.setPipeline(pipeline);
            pass.setVertexBuffer(0, this.cornerBuffer);
            pass.setVertexBuffer(1, instanceBuffer);
            pass.setBindGroup(0, colorBindGroup);
            pass.draw(4, param.instanceCount, 0, 0);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);

    }

    private packInstances(param: DotInstancePackParam): Float32Array {
        const floats = packedInstanceFloatCount(param.instanceCount);
        if (this.packedInstances.length < floats) {
            this.packedInstances = new Float32Array(Math.max(floats, this.packedInstances.length * 2, 1024));
        }
        return packInstances(param, this.packedInstances).subarray(0, floats);
    }

    private writeInstanceBuffer(data: Float32Array): GPUBuffer {
        if (!this.instanceBuffer || this.instanceBufferBytes < data.byteLength) {
            this.instanceBuffer?.destroy();
            this.instanceBufferBytes = Math.max(data.byteLength, this.instanceBufferBytes * 2, 4096);
            this.instanceBuffer = this.device.createBuffer({
                size: this.instanceBufferBytes,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
        this.device.queue.writeBuffer(this.instanceBuffer, 0, data as BufferSource);
        return this.instanceBuffer;
    }

    private getPipeline(format: GPUTextureFormat): GPURenderPipeline {

        if (this.pipeline) return this.pipeline;

        // SmudgingDrawDot always renders with Normal blend (matches WebGL2 path).
        this.pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout,
            vertex: {
                module: this.module,
                entryPoint: "vs_main",
                buffers: [CORNER_VERTEX_LAYOUT, INSTANCE_VERTEX_LAYOUT],
            },
            fragment: {
                module: this.module,
                entryPoint: "fs_main",
                targets: [{ format, blend: blendStateFor(RenderObjectBlend.Normal) }],
            },
            primitive: { topology: "triangle-strip" },
        });

        return this.pipeline;

    }

}
