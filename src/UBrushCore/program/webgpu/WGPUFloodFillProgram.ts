import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { Point } from "../../common/Point";
import { Color } from "../../common/Color";
import { Rect } from "../../common/Rect";
import { floodFillApplyWGSL, floodFillIndirectWGSL, floodFillSeedWGSL, floodFillStepWGSL } from "../wgsl/floodFill.wgsl";

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
const ITERATION_BATCH_SIZE = 64;
const TILE_SUBSTEPS = 4;

export class WGPUFloodFillProgram {

    private context: WGPUContext;
    private device: GPUDevice;
    private seedPipeline: GPUComputePipeline;
    private indirectPipeline: GPUComputePipeline;
    private stepPipeline: GPUComputePipeline;
    private applyPipeline: GPUComputePipeline;
    private seedLayout: GPUBindGroupLayout;
    private indirectLayout: GPUBindGroupLayout;
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
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            ],
        });
        this.indirectLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            ],
        });
        this.stepLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
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
        this.indirectPipeline = this.createPipeline(floodFillIndirectWGSL, this.indirectLayout);
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
        const maxPixelIterations = Math.max(1, Math.min(
            param.maxIterations ?? Math.ceil(Math.sqrt(width * width + height * height)),
            width + height,
        ));
        const maxDispatchIterations = Math.ceil(maxPixelIterations / TILE_SUBSTEPS);

        const maskBuffer = this.createStorageBuffer(width * height * 4);
        const activeListA = this.createStorageBuffer(tileCount * 4);
        const activeListB = this.createStorageBuffer(tileCount * 4);
        const activeFlagsB = this.createStorageBuffer(tileCount * 4);
        const activeCountA = this.createStorageBuffer(4);
        const activeCountB = this.createStorageBuffer(4);
        const indirectBuffer = this.device.createBuffer({
            size: 12,
            usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const filledTiles = this.createStorageBuffer(tileCount * 4);
        const filledList = this.createStorageBuffer(tileCount * 4);
        const filledCount = this.createStorageBuffer(4);
        const floodUniform = this.makeFloodUniform(width, height, seedX, seedY, tileCols, tileRows, param.tolerance, param.edgeThreshold);
        const applyUniform = this.makeApplyUniform(width, height, seedX, seedY, tileCols, tileRows, param.tolerance, param.edgeThreshold, param.color);
        const activeCountReadBuffer = this.device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const boundsBuffer = this.makeBoundsBuffer(width, height);
        const boundsReadBuffer = this.device.createBuffer({
            size: 20,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const initEncoder = this.device.createCommandEncoder();
        initEncoder.clearBuffer(maskBuffer);
        initEncoder.clearBuffer(activeListA);
        initEncoder.clearBuffer(activeListB);
        initEncoder.clearBuffer(activeFlagsB);
        initEncoder.clearBuffer(activeCountA);
        initEncoder.clearBuffer(activeCountB);
        initEncoder.clearBuffer(indirectBuffer);
        initEncoder.clearBuffer(filledTiles);
        initEncoder.clearBuffer(filledList);
        initEncoder.clearBuffer(filledCount);

        this.encodeSeed(initEncoder, param.source, maskBuffer, activeListA, filledTiles, activeCountA, filledList, filledCount, floodUniform);
        this.encodeIndirectUpdate(initEncoder, activeCountA, indirectBuffer);
        initEncoder.copyBufferToBuffer(activeCountA, 0, activeCountReadBuffer, 0, 4);
        this.device.queue.submit([initEncoder.finish()]);

        let activeCount = await this.readU32(activeCountReadBuffer);

        let readActiveList = activeListA;
        let writeActiveList = activeListB;
        let readActiveCount = activeCountA;
        let writeActiveCount = activeCountB;
        let completedIterations = 0;

        while (activeCount > 0 && completedIterations < maxDispatchIterations) {
            const batchCount = Math.min(ITERATION_BATCH_SIZE, maxDispatchIterations - completedIterations);
            const batchEncoder = this.device.createCommandEncoder();

            for (let i = 0; i < batchCount; i++) {
                batchEncoder.clearBuffer(writeActiveList);
                batchEncoder.clearBuffer(activeFlagsB);
                batchEncoder.clearBuffer(writeActiveCount);
                this.encodeStep(
                    batchEncoder,
                    param.source,
                    readActiveList,
                    writeActiveList,
                    activeFlagsB,
                    writeActiveCount,
                    filledTiles,
                    filledList,
                    filledCount,
                    maskBuffer,
                    floodUniform,
                    indirectBuffer
                );
                this.encodeIndirectUpdate(batchEncoder, writeActiveCount, indirectBuffer);

                const tmpList = readActiveList;
                readActiveList = writeActiveList;
                writeActiveList = tmpList;

                const tmpCount = readActiveCount;
                readActiveCount = writeActiveCount;
                writeActiveCount = tmpCount;
            }

            completedIterations += batchCount;
            batchEncoder.copyBufferToBuffer(readActiveCount, 0, activeCountReadBuffer, 0, 4);
            this.device.queue.submit([batchEncoder.finish()]);
            activeCount = await this.readU32(activeCountReadBuffer);
        }

        const applyEncoder = this.device.createCommandEncoder();
        this.encodeIndirectUpdate(applyEncoder, filledCount, indirectBuffer);

        {
            const bindGroup = this.device.createBindGroup({
                layout: this.applyLayout,
                entries: [
                    { binding: 0, resource: param.source.texture.getView() },
                    { binding: 1, resource: { buffer: maskBuffer } },
                    { binding: 2, resource: { buffer: filledList } },
                    { binding: 3, resource: param.target.view },
                    { binding: 4, resource: { buffer: applyUniform } },
                    { binding: 5, resource: { buffer: boundsBuffer } },
                ],
            });
            const pass = applyEncoder.beginComputePass();
            pass.setPipeline(this.applyPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroupsIndirect(indirectBuffer, 0);
            pass.end();
        }

        applyEncoder.copyBufferToBuffer(boundsBuffer, 0, boundsReadBuffer, 0, 20);
        this.device.queue.submit([applyEncoder.finish()]);

        await boundsReadBuffer.mapAsync(GPUMapMode.READ);
        const rawBounds = new Uint32Array(boundsReadBuffer.getMappedRange().slice(0));
        boundsReadBuffer.unmap();

        const pixelBounds = this.boundsFromRaw(rawBounds, width, height);

        maskBuffer.destroy();
        activeListA.destroy();
        activeListB.destroy();
        activeFlagsB.destroy();
        activeCountA.destroy();
        activeCountB.destroy();
        activeCountReadBuffer.destroy();
        indirectBuffer.destroy();
        filledTiles.destroy();
        filledList.destroy();
        filledCount.destroy();
        floodUniform.destroy();
        applyUniform.destroy();
        boundsBuffer.destroy();
        boundsReadBuffer.destroy();

        return { pixelBounds, iterations: completedIterations * TILE_SUBSTEPS, elapsedMs: performance.now() - start };
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

    private encodeIndirectUpdate(encoder: GPUCommandEncoder, countBuffer: GPUBuffer, indirectBuffer: GPUBuffer): void {
        const bindGroup = this.device.createBindGroup({
            layout: this.indirectLayout,
            entries: [
                { binding: 0, resource: { buffer: countBuffer } },
                { binding: 1, resource: { buffer: indirectBuffer } },
            ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.indirectPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1, 1);
        pass.end();
    }

    private encodeSeed(
        encoder: GPUCommandEncoder,
        source: WGPURenderTarget,
        maskBuffer: GPUBuffer,
        activeList: GPUBuffer,
        filledTiles: GPUBuffer,
        activeCount: GPUBuffer,
        filledList: GPUBuffer,
        filledCount: GPUBuffer,
        floodUniform: GPUBuffer
    ): void {
        const bindGroup = this.device.createBindGroup({
            layout: this.seedLayout,
            entries: [
                { binding: 0, resource: source.texture.getView() },
                { binding: 1, resource: { buffer: maskBuffer } },
                { binding: 2, resource: { buffer: activeList } },
                { binding: 3, resource: { buffer: filledTiles } },
                { binding: 4, resource: { buffer: activeCount } },
                { binding: 5, resource: { buffer: filledList } },
                { binding: 6, resource: { buffer: filledCount } },
                { binding: 7, resource: { buffer: floodUniform } },
            ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.seedPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1, 1);
        pass.end();
    }

    private encodeStep(
        encoder: GPUCommandEncoder,
        source: WGPURenderTarget,
        readActiveList: GPUBuffer,
        writeActiveList: GPUBuffer,
        activeFlags: GPUBuffer,
        writeActiveCount: GPUBuffer,
        filledTiles: GPUBuffer,
        filledList: GPUBuffer,
        filledCount: GPUBuffer,
        maskBuffer: GPUBuffer,
        floodUniform: GPUBuffer,
        indirectBuffer: GPUBuffer
    ): void {
        const bindGroup = this.device.createBindGroup({
            layout: this.stepLayout,
            entries: [
                { binding: 0, resource: source.texture.getView() },
                { binding: 1, resource: { buffer: readActiveList } },
                { binding: 2, resource: { buffer: writeActiveList } },
                { binding: 3, resource: { buffer: activeFlags } },
                { binding: 4, resource: { buffer: writeActiveCount } },
                { binding: 5, resource: { buffer: filledTiles } },
                { binding: 6, resource: { buffer: filledList } },
                { binding: 7, resource: { buffer: filledCount } },
                { binding: 8, resource: { buffer: maskBuffer } },
                { binding: 9, resource: { buffer: floodUniform } },
            ],
        });
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.stepPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroupsIndirect(indirectBuffer, 0);
        pass.end();
    }

    private async readU32(buffer: GPUBuffer): Promise<number> {
        await buffer.mapAsync(GPUMapMode.READ);
        const value = new Uint32Array(buffer.getMappedRange())[0];
        buffer.unmap();
        return value;
    }

    private createStorageBuffer(size: number): GPUBuffer {
        return this.device.createBuffer({
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
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
