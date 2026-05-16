import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { WGPUTexture } from "../../gpu/webgpu/WGPUTexture";
import { Rect } from "../../common/Rect";
import { AffineTransform } from "../../common/AffineTransform";
import { Color } from "../../common/Color";
import { Common } from "../../common/Common";
import { LayerBlendmode, EdgeStyle } from "../../common/IBrush";
import { highLowCutWGSL } from "../wgsl/highLowCut.wgsl";
import {
    orthoMatrix,
    quadPositions,
    quadTexCoords,
    createLinearClampSampler,
    makeUniformBuffer,
} from "./_common";

// WebGPU port of HighLowCutProgram. Uniform layout matches the WGSL struct U
// in ../wgsl/highLowCut.wgsl.ts (112 bytes).

const UNIFORM_BYTES = 112;

const BLEND_MODE_MAP: { [key: string]: number } = {
    [LayerBlendmode.NORMAL]: 0,
    [LayerBlendmode.DARKEN]: 1,
    [LayerBlendmode.MULTIPLY]: 2,
    [LayerBlendmode.COLOR_BURN]: 3,
    [LayerBlendmode.LINEAR_BURN]: 4,
    [LayerBlendmode.DARKER_COLOR]: 5,
    [LayerBlendmode.LIGHTEN]: 6,
    [LayerBlendmode.SCREEN]: 7,
    [LayerBlendmode.COLOR_DODGE]: 8,
    [LayerBlendmode.LINEAR_DODGE]: 9,
    [LayerBlendmode.LIGHTER_COLOR]: 10,
    [LayerBlendmode.OVERLAY]: 11,
    [LayerBlendmode.SOFT_LIGHT]: 12,
    [LayerBlendmode.HARD_LIGHT]: 13,
    [LayerBlendmode.VIVID_LIGHT]: 14,
    [LayerBlendmode.LINEAR_LIGHT]: 15,
    [LayerBlendmode.PIN_LIGHT]: 16,
    [LayerBlendmode.HARD_MIX]: 17,
    [LayerBlendmode.DIFFERENCE]: 18,
    [LayerBlendmode.EXCLUSION]: 19,
    [LayerBlendmode.SUBTRACT]: 20,
    [LayerBlendmode.DIVIDE]: 21,
    [LayerBlendmode.HUE]: 22,
    [LayerBlendmode.SATURATION]: 23,
    [LayerBlendmode.COLOR]: 24,
    [LayerBlendmode.LUMINOSITY]: 25,
    [LayerBlendmode.ERASE]: 26,
};

export class WGPUHighLowCutProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;
    private sampler: GPUSampler;

    private edgeTextures: Map<string, WGPUTexture> = new Map();
    private pipelineCache: Map<GPUTextureFormat, GPURenderPipeline> = new Map();
    private positionBuffer?: GPUBuffer;
    private texCoordBuffer?: GPUBuffer;
    private uniformBuffer?: GPUBuffer;
    private uniformBytes = new ArrayBuffer(UNIFORM_BYTES);
    private uniformF = new Float32Array(this.uniformBytes);
    private uniformI = new Int32Array(this.uniformBytes);

    constructor(context: WGPUContext) {

        this.context = context;
        this.device = context.device;
        this.module = context.createShaderModule(highLowCutWGSL);

        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // wetedge
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // dry
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }, // liquid
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ],
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout],
        });

        this.sampler = createLinearClampSampler(this.device);

        for (const style of ["WET", "BURN", "HARD", "SOFT"]) {
            const lut = Common.edgeLUT(style);
            if (lut) {
                const tex = context.createTexture();
                tex.loadFromRGBA(lut, 256, 1);
                this.edgeTextures.set(style, tex);
            }
        }

    }

    public distroy(): void {

        for (const t of this.edgeTextures.values()) t.destroy();
        this.edgeTextures.clear();
        this.positionBuffer?.destroy();
        this.texCoordBuffer?.destroy();
        this.uniformBuffer?.destroy();
        this.positionBuffer = undefined;
        this.texCoordBuffer = undefined;
        this.uniformBuffer = undefined;
        this.pipelineCache.clear();

    }

    public fill(renderTarget: WGPURenderTarget | null,
        param: {
            targetRect: Rect,
            drySource: WGPUTexture,
            liquidSource: WGPUTexture,
            sourceRect: Rect,
            transform: AffineTransform,
            liquidSourceBlendmode: LayerBlendmode | string,
            canvasRect: Rect,
            opacity: number,
            lowCut: number,
            highCut: number,
            liquidColor: Color,
            liquidTinting: boolean,
            edgeStyle: EdgeStyle | string
        }): void {

        const positions = quadPositions(param.targetRect, param.transform);
        const texCoords = quadTexCoords(param.sourceRect, param.canvasRect);
        const ortho = orthoMatrix(param.canvasRect);

        const positionBuffer = this.writeVertexBuffer('position', positions);
        const texCoordBuffer = this.writeVertexBuffer('texCoord', texCoords);

        const edgeTex = this.edgeTextures.get(param.edgeStyle as string) ?? null;
        const wetTex = edgeTex ?? this.edgeTextures.get("WET")!;

        const blendmodeCode = BLEND_MODE_MAP[param.liquidSourceBlendmode as string] ?? 0;

        const uniformBuffer = this.getUniformBuffer();
        const f = this.uniformF;
        const i = this.uniformI;
        f.set(ortho, 0);                                  // 0..15  : orthoMatrix
        f[16] = param.liquidColor.r;                      // 16..19 : liquidColor
        f[17] = param.liquidColor.g;
        f[18] = param.liquidColor.b;
        f[19] = param.liquidColor.a;
        f[20] = param.opacity;                            // 20     : opacity
        f[21] = param.lowCut;                             // 21     : lowCut
        f[22] = param.highCut;                            // 22     : highCut
        i[23] = param.liquidTinting ? 1 : 0;              // 23     : liquidTinting
        i[24] = edgeTex ? 1 : 0;                          // 24     : hasEdge
        i[25] = blendmodeCode;                            // 25     : blendmode
        i[26] = 0;                                        // 26     : _pad0
        i[27] = 0;                                        // 27     : _pad1
        this.device.queue.writeBuffer(uniformBuffer, 0, this.uniformBytes);

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: uniformBuffer } },
                { binding: 1, resource: wetTex.getView() },
                { binding: 2, resource: param.drySource.getView() },
                { binding: 3, resource: param.liquidSource.getView() },
                { binding: 4, resource: this.sampler },
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
        if (!this.uniformBuffer) {
            this.uniformBuffer = makeUniformBuffer(this.device, UNIFORM_BYTES);
        }
        return this.uniformBuffer;
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
