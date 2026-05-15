import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { Point } from "../../common/Point";
import { Color } from "../../common/Color";
import { Rect } from "../../common/Rect";
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

export interface FloodFillResult {
    pixelBounds: Rect | null;
    iterations: number;
    elapsedMs: number;
}

const TILE_SIZE = 16;

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
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ],
        });
        this.stepLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ],
        });
        this.applyLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            ],
        });

        this.seedPipeline = this.createPipeline(floodFillSeedWGSL, this.seedLayout);
        this.stepPipeline = this.createPipeline(floodFillStepWGSL, this.stepLayout);
        this.applyPipeline = this.createPipeline(floodFillApplyWGSL, this.applyLayout);
    }

    public distroy(): void {}

    public async fill(param: FloodFillParams): Promise<FloodFillResult> {
        const start = performance.now();
        const width = param.source.size.width;
        const height = param.source.size.height;
        if (width <= 0 || height <= 0) return { pixelBounds: null, iterations: 0, elapsedMs: 0 };

        const seedX = Math.max(0, Math.min(width - 1, Math.floor(param.seed.x)));
        const seedY = Math.max(0, Math.min(height - 1, height - 1 - Math.floor(param.seed.y)));
        const tileCols = Math.ceil(width / TILE_SIZE);
        const tileRows = Math.ceil(height / TILE_SIZE);
        const tileCount = tileCols * tileRows;
        const iterations = Math.max(1, Math.min(
            param.maxIterations ?? Math.ceil(Math.sqrt(width * width + height * height)),
            width + height,
        ));

        const maskBuffer = this.createStorageBuffer(width * height * 4);
        const activeA = this.createStorageBuffer(tileCount * 4);
        const activeB = this.createStorageBuffer(tileCount * 4);
        const filledTiles = this.createStorageBuffer(tileCount * 4);
        const floodUniform = this.makeFloodUniform(width, height, seedX, seedY, tileCols, tileRows, param.tolerance, param.edgeThreshold);
        const applyUniform = this.makeApplyUniform(width, height, seedX, seedY, tileCols, tileRows, param.tolerance, param.edgeThreshold, param.color);
        const boundsBuffer = this.makeBoundsBuffer(width, height);
        const boundsReadBuffer = this.device.createBuffer({
            size: 20,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = this.device.createCommandEncoder();
        encoder.clearBuffer(maskBuffer);
        encoder.clearBuffer(activeA);
        encoder.clearBuffer(activeB);
        encoder.clearBuffer(filledTiles);

        {
            const bindGroup = this.device.createBindGroup({
                layout: this.seedLayout,
                entries: [
                    { binding: 0, resource: param.source.texture.getView() },
                    { binding: 1, resource: { buffer: maskBuffer } },
                    { binding: 2, resource: { buffer: activeA } },
                    { binding: 3, resource: { buffer: filledTiles } },
                    { binding: 4, resource: { buffer: floodUniform } },
                ],
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.seedPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(1, 1);
            pass.end();
        }

        let readActive = activeA;
        let writeActive = activeB;
        for (let i = 0; i < iterations; i++) {
            encoder.clearBuffer(writeActive);
            const bindGroup = this.device.createBindGroup({
                layout: this.stepLayout,
                entries: [
                    { binding: 0, resource: param.source.texture.getView() },
                    { binding: 1, resource: { buffer: readActive } },
                    { binding: 2, resource: { buffer: writeActive } },
                    { binding: 3, resource: { buffer: filledTiles } },
                    { binding: 4, resource: { buffer: maskBuffer } },
                    { binding: 5, resource: { buffer: floodUniform } },
                ],
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.stepPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(tileCols, tileRows);
            pass.end();

            const tmp = readActive;
            readActive = writeActive;
            writeActive = tmp;
        }

        {
            const bindGroup = this.device.createBindGroup({
                layout: this.applyLayout,
                entries: [
                    { binding: 0, resource: param.source.texture.getView() },
                    { binding: 1, resource: { buffer: maskBuffer } },
                    { binding: 2, resource: { buffer: filledTiles } },
                    { binding: 3, resource: param.target.view },
                    { binding: 4, resource: { buffer: applyUniform } },
                    { binding: 5, resource: { buffer: boundsBuffer } },
                ],
            });
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.applyPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(tileCols, tileRows);
            pass.end();
        }

        encoder.copyBufferToBuffer(boundsBuffer, 0, boundsReadBuffer, 0, 20);
        this.device.queue.submit([encoder.finish()]);

        await boundsReadBuffer.mapAsync(GPUMapMode.READ);
        const rawBounds = new Uint32Array(boundsReadBuffer.getMappedRange().slice(0));
        boundsReadBuffer.unmap();

        const pixelBounds = this.boundsFromRaw(rawBounds, width, height);

        maskBuffer.destroy();
        activeA.destroy();
        activeB.destroy();
        filledTiles.destroy();
        floodUniform.destroy();
        applyUniform.destroy();
        boundsBuffer.destroy();
        boundsReadBuffer.destroy();

        return { pixelBounds, iterations, elapsedMs: performance.now() - start };
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

    private createStorageBuffer(size: number): GPUBuffer {
        return this.device.createBuffer({
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    private makeFloodUniform(width: number, height: number, seedX: number, seedY: number, tileCols: number, tileRows: number, tolerance: number, edgeThreshold: number): GPUBuffer {
        const data = new ArrayBuffer(40);
        const u32 = new Uint32Array(data);
        const f32 = new Float32Array(data);
        u32[0] = width;
        u32[1] = height;
        u32[2] = seedX;
        u32[3] = seedY;
        f32[4] = tolerance;
        f32[5] = edgeThreshold;
        u32[6] = tileCols;
        u32[7] = tileRows;
        return this.makeUniformBuffer(data);
    }

    private makeApplyUniform(width: number, height: number, seedX: number, seedY: number, tileCols: number, tileRows: number, tolerance: number, edgeThreshold: number, color: Color): GPUBuffer {
        const data = new ArrayBuffer(64);
        const u32 = new Uint32Array(data);
        const f32 = new Float32Array(data);
        u32[0] = width;
        u32[1] = height;
        u32[2] = seedX;
        u32[3] = seedY;
        f32[4] = tolerance;
        f32[5] = edgeThreshold;
        u32[6] = tileCols;
        u32[7] = tileRows;
        f32[8] = color.r;
        f32[9] = color.g;
        f32[10] = color.b;
        f32[11] = color.a;
        return this.makeUniformBuffer(data);
    }

    private makeBoundsBuffer(width: number, height: number): GPUBuffer {
        const data = new Uint32Array([width, height, 0, 0, 0]);
        const buffer = this.device.createBuffer({
            size: data.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this.device.queue.writeBuffer(buffer, 0, data as BufferSource);
        return buffer;
    }

    private boundsFromRaw(raw: Uint32Array, width: number, height: number): Rect | null {
        const count = raw[4];
        if (count === 0) return null;

        const minX = raw[0];
        const minYTop = raw[1];
        const maxX = raw[2];
        const maxYTop = raw[3];

        const yUp = height - maxYTop - 1;
        return new Rect(minX, yUp, maxX - minX + 1, maxYTop - minYTop + 1);
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
