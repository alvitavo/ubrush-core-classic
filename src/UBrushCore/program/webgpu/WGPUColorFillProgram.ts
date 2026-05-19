import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPURenderTarget } from "../../gpu/webgpu/WGPURenderTarget";
import { Rect } from "../../common/Rect";
import { AffineTransform } from "../../common/AffineTransform";
import { Color } from "../../common/Color";
import { colorFillWGSL } from "../wgsl/colorFill.wgsl";
import {
    writeOrthoMatrix,
    writeQuadPositions,
    makeUniformBuffer,
} from "./_common";

export class WGPUColorFillProgram {
    private context: WGPUContext;
    private device: GPUDevice;
    private module: GPUShaderModule;
    private bindGroupLayout: GPUBindGroupLayout;
    private pipelineLayout: GPUPipelineLayout;

    private pipelineCache: Map<string, GPURenderPipeline> = new Map();
    private positionBuffer?: GPUBuffer;
    private uniformBuffer?: GPUBuffer;
    private bindGroup?: GPUBindGroup;
    private positions = new Float32Array(8);
    private uniforms = new Float32Array(20);

    constructor(context: WGPUContext) {
        this.context = context;
        this.device = context.device;
        this.module = context.createShaderModule(colorFillWGSL);
        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ],
        });
        this.pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    }

    public distroy(): void {
        this.positionBuffer?.destroy();
        this.uniformBuffer?.destroy();
        this.positionBuffer = undefined;
        this.uniformBuffer = undefined;
        this.bindGroup = undefined;
        this.pipelineCache.clear();
    }

    public fill(renderTarget: WGPURenderTarget | null,
        param: {
            targetRect: Rect,
            canvasRect: Rect,
            transform: AffineTransform,
            color: Color
        }): void {
        const positions = writeQuadPositions(this.positions, param.targetRect, param.transform);
        const ortho = writeOrthoMatrix(this.uniforms.subarray(0, 16), param.canvasRect);
        this.uniforms.set(ortho, 0);
        this.uniforms[16] = param.color.r;
        this.uniforms[17] = param.color.g;
        this.uniforms[18] = param.color.b;
        this.uniforms[19] = param.color.a;

        const positionBuffer = this.writeVertexBuffer(positions);
        const uniformBuffer = this.getUniformBuffer();
        this.device.queue.writeBuffer(uniformBuffer, 0, this.uniforms as BufferSource);

        const view = renderTarget
            ? renderTarget.view
            : this.context.presentationContext.getCurrentTexture().createView();
        const format = renderTarget ? "rgba8unorm" : this.context.presentationFormat;
        const pipeline = this.getPipeline(format);

        const passEncoder = this.device.createCommandEncoder();
        const pass = passEncoder.beginRenderPass({
            colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
        });
        pass.setPipeline(pipeline);
        pass.setVertexBuffer(0, positionBuffer);
        pass.setBindGroup(0, this.getBindGroup());
        pass.draw(4, 1, 0, 0);
        pass.end();
        this.device.queue.submit([passEncoder.finish()]);
    }

    private writeVertexBuffer(data: Float32Array): GPUBuffer {
        if (!this.positionBuffer) {
            this.positionBuffer = this.device.createBuffer({
                size: data.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
        }
        this.device.queue.writeBuffer(this.positionBuffer, 0, data as BufferSource);
        return this.positionBuffer;
    }

    private getUniformBuffer(): GPUBuffer {
        if (!this.uniformBuffer) this.uniformBuffer = makeUniformBuffer(this.device, 80);
        return this.uniformBuffer;
    }

    private getBindGroup(): GPUBindGroup {
        if (this.bindGroup) return this.bindGroup;
        this.bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.getUniformBuffer() } },
            ],
        });
        return this.bindGroup;
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
