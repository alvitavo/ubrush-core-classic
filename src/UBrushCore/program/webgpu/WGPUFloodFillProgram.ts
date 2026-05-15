import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { Point } from "../../common/Point";
import { Color } from "../../common/Color";
import { floodFillApplyWGSL, floodFillSeedWGSL, floodFillStepWGSL } from "../wgsl/floodFill.wgsl";

interface FloodFillParams {
    source: WGPURenderTarget;
    target: WGPURenderTarget;
    seed: Point;
    color: Color;
    tolerance: number;
    edgeThreshold: number;
    maxIterations?: number;
}

export class WGPUFloodFillProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private seedPipeline: GPUComputePipeline;
    private stepPipeline: GPUComputePipeline;
    private applyPipeline: GPUComputePipeline;
    private seedLayout: GPUBindGroupLayout;
    private stepLayout: GPUBindGroupLayout;
    private applyLayout: GPUBindGroupLayout;

    constructor(context: WGPUContext) {
        this.context = context;
        this.device = context.device;

        this.seedLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32uint" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ],
        });
        this.stepLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32uint" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ],
        });
        this.applyLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ],
        });

        this.seedPipeline = this.createPipeline(floodFillSeedWGSL, this.seedLayout);
        this.stepPipeline = this.createPipeline(floodFillStepWGSL, this.stepLayout);
        this.applyPipeline = this.createPipeline(floodFillApplyWGSL, this.applyLayout);
    }

    public distroy(): void {}

    public fill(param: FloodFillParams): void {
        const width = param.source.size.width;
        const height = param.source.size.height;
        if (width <= 0 || height <= 0) return;

        const seedX = Math.max(0, Math.min(width - 1, Math.floor(param.seed.x)));
        const seedY = Math.max(0, Math.min(height - 1, height - 1 - Math.floor(param.seed.y)));
        const iterations = Math.max(1, Math.min(
            param.maxIterations ?? Math.ceil(Math.sqrt(width * width + height * height)),
            width + height,
        ));

        const maskA = this.createMaskTexture(width, height);
        const maskB = this.createMaskTexture(width, height);
        const floodUniform = this.makeFloodUniform(width, height, seedX, seedY, param.tolerance, param.edgeThreshold);
        const applyUniform = this.makeApplyUniform(width, height, seedX, seedY, param.tolerance, param.edgeThreshold, param.color);

        const groupsX = Math.ceil(width / 8);
        const groupsY = Math.ceil(height / 8);

        const encoder = this.device.createCommandEncoder();

        {
            const bindGroup = this.device.createBindGroup({
                layout: this.seedLayout,
                entries: [
                    { binding: 0, resource: param.source.texture.getView() },
                    { binding: 1, resource: maskA.createView() },
                    { binding: 2, resource: { buffer: floodUniform } },
                ],
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.seedPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(groupsX, groupsY);
            pass.end();
        }

        let readMask = maskA;
        let writeMask = maskB;
        for (let i = 0; i < iterations; i++) {
            const bindGroup = this.device.createBindGroup({
                layout: this.stepLayout,
                entries: [
                    { binding: 0, resource: param.source.texture.getView() },
                    { binding: 1, resource: readMask.createView() },
                    { binding: 2, resource: writeMask.createView() },
                    { binding: 3, resource: { buffer: floodUniform } },
                ],
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.stepPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(groupsX, groupsY);
            pass.end();

            const tmp = readMask;
            readMask = writeMask;
            writeMask = tmp;
        }

        {
            const bindGroup = this.device.createBindGroup({
                layout: this.applyLayout,
                entries: [
                    { binding: 0, resource: param.source.texture.getView() },
                    { binding: 1, resource: readMask.createView() },
                    { binding: 2, resource: param.target.view },
                    { binding: 3, resource: { buffer: applyUniform } },
                ],
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.applyPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(groupsX, groupsY);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);
        maskA.destroy();
        maskB.destroy();
        floodUniform.destroy();
        applyUniform.destroy();
    }

    private createPipeline(wgsl: string, layout: GPUBindGroupLayout): GPUComputePipeline {
        return this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: {
                module: this.context.createShaderModule(wgsl),
                entryPoint: "main",
            },
        });
    }

    private createMaskTexture(width: number, height: number): GPUTexture {
        return this.device.createTexture({
            size: [width, height, 1],
            format: "r32uint",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
    }

    private makeFloodUniform(width: number, height: number, seedX: number, seedY: number, tolerance: number, edgeThreshold: number): GPUBuffer {
        const data = new ArrayBuffer(32);
        const u32 = new Uint32Array(data);
        const f32 = new Float32Array(data);
        u32[0] = width;
        u32[1] = height;
        u32[2] = seedX;
        u32[3] = seedY;
        f32[4] = tolerance;
        f32[5] = edgeThreshold;
        return this.makeUniformBuffer(data);
    }

    private makeApplyUniform(width: number, height: number, seedX: number, seedY: number, tolerance: number, edgeThreshold: number, color: Color): GPUBuffer {
        const data = new ArrayBuffer(48);
        const u32 = new Uint32Array(data);
        const f32 = new Float32Array(data);
        u32[0] = width;
        u32[1] = height;
        u32[2] = seedX;
        u32[3] = seedY;
        f32[4] = tolerance;
        f32[5] = edgeThreshold;
        f32[8] = color.r;
        f32[9] = color.g;
        f32[10] = color.b;
        f32[11] = color.a;
        return this.makeUniformBuffer(data);
    }

    private makeUniformBuffer(data: ArrayBuffer): GPUBuffer {
        const buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }

}
