import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { RenderObjectBlend } from "../../gpu/RenderObject";
import { smudgingDrawDotWGSL } from "../wgsl/smudgingDrawDot.wgsl";
import {
    blendStateFor,
    createLinearClampSampler,
    makeVertexBuffer,
    makeUniformBuffer,
} from "./_common";

const QUAD_CORNERS = new Float32Array([
    -1.0, -1.0,
     1.0, -1.0,
    -1.0,  1.0,
     1.0,  1.0,
]);

const VEC2 = 8;
const VEC4 = 16;
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

    private cornerBuffer: GPUBuffer;
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
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.sampler = createLinearClampSampler(this.device);

        this.cornerBuffer = makeVertexBuffer(this.device, QUAD_CORNERS);

    }

    public distroy(): void {

        this.cornerBuffer.destroy();
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

        const buffers: GPUBuffer[] = [
            makeVertexBuffer(this.device, param.posCenterAxisU),
            makeVertexBuffer(this.device, param.posAxisV),
            makeVertexBuffer(this.device, param.tipUV),
            makeVertexBuffer(this.device, param.patternUVa),
            makeVertexBuffer(this.device, param.patternUVb),
            makeVertexBuffer(this.device, param.smudging0UVa),
            makeVertexBuffer(this.device, param.smudging0UVb),
            makeVertexBuffer(this.device, param.smudgingUVa),
            makeVertexBuffer(this.device, param.smudgingUVb),
            makeVertexBuffer(this.device, param.tintColor),
            makeVertexBuffer(this.device, param.opacity),
            makeVertexBuffer(this.device, param.corrosion),
        ];

        const alphaUniform = makeUniformBuffer(this.device, UNIFORM_BYTES);
        const colorUniform = makeUniformBuffer(this.device, UNIFORM_BYTES);
        const alphaBytes = new ArrayBuffer(UNIFORM_BYTES);
        const colorBytes = new ArrayBuffer(UNIFORM_BYTES);
        new Int32Array(alphaBytes, 0, 1)[0] = 0;
        new Int32Array(colorBytes, 0, 1)[0] = 1;
        this.device.queue.writeBuffer(alphaUniform, 0, alphaBytes);
        this.device.queue.writeBuffer(colorUniform, 0, colorBytes);

        const alphaBindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: alphaUniform } },
                { binding: 1, resource: tip.getView() },
                { binding: 2, resource: param.patternTexture.getView() },
                { binding: 3, resource: param.smudging0CopyAlphaTexture.getView() },
                { binding: 4, resource: param.smudgingCopyAlphaTexture.getView() },
                { binding: 5, resource: this.sampler },
            ],
        });

        const colorBindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: colorUniform } },
                { binding: 1, resource: tip.getView() },
                { binding: 2, resource: param.patternTexture.getView() },
                { binding: 3, resource: param.smudging0CopyColorFramebuffer.getView() },
                { binding: 4, resource: param.smudgingCopyColorFramebuffer.getView() },
                { binding: 5, resource: this.sampler },
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
            for (let i = 0; i < buffers.length; i++) pass.setVertexBuffer(i + 1, buffers[i]);
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
            for (let i = 0; i < buffers.length; i++) pass.setVertexBuffer(i + 1, buffers[i]);
            pass.setBindGroup(0, colorBindGroup);
            pass.draw(4, param.instanceCount, 0, 0);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);

        for (const b of buffers) b.destroy();
        alphaUniform.destroy();
        colorUniform.destroy();

    }

    private getPipeline(format: GPUTextureFormat): GPURenderPipeline {

        if (this.pipeline) return this.pipeline;

        // SmudgingDrawDot always renders with Normal blend (matches WebGL2 path).
        this.pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout,
            vertex: {
                module: this.module,
                entryPoint: "vs_main",
                buffers: [
                    { arrayStride: VEC2, stepMode: "vertex",   attributes: [{ shaderLocation:  0, offset: 0, format: "float32x2" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation:  1, offset: 0, format: "float32x4" }] },
                    { arrayStride: VEC2, stepMode: "instance", attributes: [{ shaderLocation:  2, offset: 0, format: "float32x2" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation:  3, offset: 0, format: "float32x4" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation:  4, offset: 0, format: "float32x4" }] },
                    { arrayStride: VEC2, stepMode: "instance", attributes: [{ shaderLocation:  5, offset: 0, format: "float32x2" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation:  6, offset: 0, format: "float32x4" }] },
                    { arrayStride: VEC2, stepMode: "instance", attributes: [{ shaderLocation:  7, offset: 0, format: "float32x2" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation:  8, offset: 0, format: "float32x4" }] },
                    { arrayStride: VEC2, stepMode: "instance", attributes: [{ shaderLocation:  9, offset: 0, format: "float32x2" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation: 10, offset: 0, format: "float32x4" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation: 11, offset: 0, format: "float32x4" }] },
                    { arrayStride: VEC4, stepMode: "instance", attributes: [{ shaderLocation: 12, offset: 0, format: "float32x4" }] },
                ],
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
