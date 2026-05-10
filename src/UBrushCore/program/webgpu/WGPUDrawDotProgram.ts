import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { RenderObjectBlend } from "../../gpu/RenderObject";
import { drawDotWGSL } from "../wgsl/drawDot.wgsl";
import {
    blendStateFor,
    createLinearClampSampler,
    makeVertexBuffer,
} from "./_common";

const QUAD_CORNERS = new Float32Array([
    -1.0, -1.0,
     1.0, -1.0,
    -1.0,  1.0,
     1.0,  1.0,
]);

// Vertex buffer slot table (must match the WGSL @location(N) annotations
// in ../wgsl/drawDot.wgsl.ts).
//   slot  0 : a_corner          per-vertex   vec2f
//   slot  1 : a_posCenterAxisU  per-instance vec4f
//   slot  2 : a_posAxisV        per-instance vec2f
//   slot  3 : a_tipUV           per-instance vec4f
//   slot  4 : a_patternUVa      per-instance vec4f
//   slot  5 : a_patternUVb      per-instance vec2f
//   slot  6 : a_smudging0UVa    per-instance vec4f
//   slot  7 : a_smudging0UVb    per-instance vec2f
//   slot  8 : a_smudgingUVa     per-instance vec4f
//   slot  9 : a_smudgingUVb     per-instance vec2f
//   slot 10 : a_tintColor       per-instance vec4f
//   slot 11 : a_opacity         per-instance vec4f
//   slot 12 : a_corrosion       per-instance vec4f
const VEC2 = 8;
const VEC4 = 16;

export class WGPUDrawDotProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;
    private sampler: GPUSampler;

    private cornerBuffer: GPUBuffer;
    private pipelineCache: Map<string, GPURenderPipeline> = new Map();

    constructor(context: WGPUContext) {

        this.context = context;
        this.device = context.device;
        this.module = context.createShaderModule(drawDotWGSL);

        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // tip
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // pattern
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // smudging0Ref
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // smudgingRef
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
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
        this.pipelineCache.clear();

    }

    public drawRects(renderTarget: WGPURenderTarget,
        param: {
            tipTexture: WGPUTexture,
            patternTexture: WGPUTexture,
            smudging0Texture: WGPUTexture,
            smudgingTexture: WGPUTexture,
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
            useDualTip: boolean,
            blend: RenderObjectBlend
        }): void {

        const tip = param.useDualTip ? param.dualTipTexture : param.tipTexture;

        // Allocate one VBO per per-instance attribute (1st-pass impl — interleaving
        // can come later if perf demands it).
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

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: tip.getView() },
                { binding: 1, resource: param.patternTexture.getView() },
                { binding: 2, resource: param.smudging0Texture.getView() },
                { binding: 3, resource: param.smudgingTexture.getView() },
                { binding: 4, resource: this.sampler },
            ],
        });

        const pipeline = this.getPipeline(param.blend, "rgba8unorm");

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: renderTarget.view,
                loadOp: "load",
                storeOp: "store",
            }],
        });
        pass.setPipeline(pipeline);
        pass.setVertexBuffer(0, this.cornerBuffer);
        for (let i = 0; i < buffers.length; i++) {
            pass.setVertexBuffer(i + 1, buffers[i]);
        }
        pass.setBindGroup(0, bindGroup);
        pass.draw(4, param.instanceCount, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);

        for (const b of buffers) b.destroy();

    }

    private getPipeline(blend: RenderObjectBlend, format: GPUTextureFormat): GPURenderPipeline {

        const key = `${blend}-${format}`;
        const cached = this.pipelineCache.get(key);
        if (cached) return cached;

        const pipeline = this.device.createRenderPipeline({
            layout: this.pipelineLayout,
            vertex: {
                module: this.module,
                entryPoint: "vs_main",
                buffers: [
                    // slot 0 : per-vertex corner
                    { arrayStride: VEC2, stepMode: "vertex",   attributes: [{ shaderLocation:  0, offset: 0, format: "float32x2" }] },
                    // slots 1..12 : per-instance attributes
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
                targets: [{ format, blend: blendStateFor(blend) }],
            },
            primitive: { topology: "triangle-strip" },
        });

        this.pipelineCache.set(key, pipeline);
        return pipeline;

    }

}
