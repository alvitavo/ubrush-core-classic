import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { RenderObjectBlend } from "../../gpu/RenderObject";
import { drawDotWGSL } from "../wgsl/drawDot.wgsl";
import {
    blendStateFor,
    createLinearClampSampler,
    createLinearRepeatSampler,
    makeVertexBuffer,
} from "./_common";

export const QUAD_CORNERS = new Float32Array([
    -1.0, -1.0,
     1.0, -1.0,
    -1.0,  1.0,
     1.0,  1.0,
]);

// WebGPU's default maxVertexBuffers is 8. The original WebGL path used 13
// separate buffers (corner + 12 per-instance attributes); under WebGPU we
// pack the 12 instance attributes into a single interleaved buffer at slot 1.
//
// Layout per instance — 160 bytes / 40 floats — match WGSL @location(N)
// annotations in ../wgsl/drawDot.wgsl.ts.
//   loc  1 posCenterAxisU vec4f  off  0
//   loc  2 posAxisV       vec2f  off 16
//   loc  3 tipUV          vec4f  off 24
//   loc  4 patternUVa     vec4f  off 40
//   loc  5 patternUVb     vec2f  off 56
//   loc  6 smudging0UVa   vec4f  off 64
//   loc  7 smudging0UVb   vec2f  off 80
//   loc  8 smudgingUVa    vec4f  off 88
//   loc  9 smudgingUVb    vec2f  off 104
//   loc 10 tintColor      vec4f  off 112
//   loc 11 opacity        vec4f  off 128
//   loc 12 corrosion      vec4f  off 144
const INSTANCE_STRIDE_BYTES = 160;
const INSTANCE_STRIDE_FLOATS = INSTANCE_STRIDE_BYTES / 4;

export function packInstances(param: {
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
}): Float32Array {

    const n = param.instanceCount;
    const out = new Float32Array(n * INSTANCE_STRIDE_FLOATS);

    for (let i = 0; i < n; i++) {
        const o = i * INSTANCE_STRIDE_FLOATS;
        const i2 = i * 2;
        const i4 = i * 4;

        out[o + 0]  = param.posCenterAxisU[i4 + 0];
        out[o + 1]  = param.posCenterAxisU[i4 + 1];
        out[o + 2]  = param.posCenterAxisU[i4 + 2];
        out[o + 3]  = param.posCenterAxisU[i4 + 3];

        out[o + 4]  = param.posAxisV[i2 + 0];
        out[o + 5]  = param.posAxisV[i2 + 1];

        out[o + 6]  = param.tipUV[i4 + 0];
        out[o + 7]  = param.tipUV[i4 + 1];
        out[o + 8]  = param.tipUV[i4 + 2];
        out[o + 9]  = param.tipUV[i4 + 3];

        out[o + 10] = param.patternUVa[i4 + 0];
        out[o + 11] = param.patternUVa[i4 + 1];
        out[o + 12] = param.patternUVa[i4 + 2];
        out[o + 13] = param.patternUVa[i4 + 3];

        out[o + 14] = param.patternUVb[i2 + 0];
        out[o + 15] = param.patternUVb[i2 + 1];

        out[o + 16] = param.smudging0UVa[i4 + 0];
        out[o + 17] = param.smudging0UVa[i4 + 1];
        out[o + 18] = param.smudging0UVa[i4 + 2];
        out[o + 19] = param.smudging0UVa[i4 + 3];

        out[o + 20] = param.smudging0UVb[i2 + 0];
        out[o + 21] = param.smudging0UVb[i2 + 1];

        out[o + 22] = param.smudgingUVa[i4 + 0];
        out[o + 23] = param.smudgingUVa[i4 + 1];
        out[o + 24] = param.smudgingUVa[i4 + 2];
        out[o + 25] = param.smudgingUVa[i4 + 3];

        out[o + 26] = param.smudgingUVb[i2 + 0];
        out[o + 27] = param.smudgingUVb[i2 + 1];

        out[o + 28] = param.tintColor[i4 + 0];
        out[o + 29] = param.tintColor[i4 + 1];
        out[o + 30] = param.tintColor[i4 + 2];
        out[o + 31] = param.tintColor[i4 + 3];

        out[o + 32] = param.opacity[i4 + 0];
        out[o + 33] = param.opacity[i4 + 1];
        out[o + 34] = param.opacity[i4 + 2];
        out[o + 35] = param.opacity[i4 + 3];

        out[o + 36] = param.corrosion[i4 + 0];
        out[o + 37] = param.corrosion[i4 + 1];
        out[o + 38] = param.corrosion[i4 + 2];
        out[o + 39] = param.corrosion[i4 + 3];
    }

    return out;

}

export const INSTANCE_VERTEX_LAYOUT: GPUVertexBufferLayout = {
    arrayStride: INSTANCE_STRIDE_BYTES,
    stepMode: "instance",
    attributes: [
        { shaderLocation:  1, offset:   0, format: "float32x4" },
        { shaderLocation:  2, offset:  16, format: "float32x2" },
        { shaderLocation:  3, offset:  24, format: "float32x4" },
        { shaderLocation:  4, offset:  40, format: "float32x4" },
        { shaderLocation:  5, offset:  56, format: "float32x2" },
        { shaderLocation:  6, offset:  64, format: "float32x4" },
        { shaderLocation:  7, offset:  80, format: "float32x2" },
        { shaderLocation:  8, offset:  88, format: "float32x4" },
        { shaderLocation:  9, offset: 104, format: "float32x2" },
        { shaderLocation: 10, offset: 112, format: "float32x4" },
        { shaderLocation: 11, offset: 128, format: "float32x4" },
        { shaderLocation: 12, offset: 144, format: "float32x4" },
    ],
};

export const CORNER_VERTEX_LAYOUT: GPUVertexBufferLayout = {
    arrayStride: 8,
    stepMode: "vertex",
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
};

export class WGPUDrawDotProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;
    private sampler: GPUSampler;
    private patternSampler: GPUSampler;

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
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },   // clamp
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },   // repeat (pattern)
            ],
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.sampler = createLinearClampSampler(this.device);
        this.patternSampler = createLinearRepeatSampler(this.device);

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

        const packed = packInstances(param);
        const instanceBuffer = makeVertexBuffer(this.device, packed);

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: tip.getView() },
                { binding: 1, resource: param.patternTexture.getView() },
                { binding: 2, resource: param.smudging0Texture.getView() },
                { binding: 3, resource: param.smudgingTexture.getView() },
                { binding: 4, resource: this.sampler },
                { binding: 5, resource: this.patternSampler },
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
        pass.setVertexBuffer(1, instanceBuffer);
        pass.setBindGroup(0, bindGroup);
        pass.draw(4, param.instanceCount, 0, 0);
        pass.end();
        this.device.queue.submit([encoder.finish()]);

        instanceBuffer.destroy();

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
                buffers: [CORNER_VERTEX_LAYOUT, INSTANCE_VERTEX_LAYOUT],
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
