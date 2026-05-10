// Backend-neutral enums kept here from the WebGL2 era. The RenderObject
// class itself has been removed — WebGPU programs encode their own draw
// state via GPURenderPipeline / GPUBindGroup. Only the blend-mode enum is
// referenced now (by the WebGPU program classes' blendStateFor helper).

export enum RenderObjectBlend {

    None,
    Normal,
    Add,
    Screen,
    Max,

}
