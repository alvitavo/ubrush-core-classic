// WGSL port of FillRectProgram.
// GLSL source: ../FillRectProgram.ts (vertexShaderSource / fragmentShaderSource)
//
// Bind group layout (group 0):
//   binding 0: var<uniform> U { orthoMatrix: mat4x4f }
//   binding 1: u_texture (texture_2d<f32>)
//   binding 2: u_sampler (sampler)
//
// Vertex buffers:
//   slot 0, location 0: a_position (vec2f)
//   slot 1, location 1: a_textureCoordinate (vec2f)

export const fillRectWGSL = /* wgsl */ `
struct U {
    orthoMatrix : mat4x4f,
};

struct VsIn {
    @location(0) position : vec2f,
    @location(1) texCoord : vec2f,
};

struct VsOut {
    @builtin(position) clipPos : vec4f,
    @location(0)       vTexCoord : vec2f,
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var u_texture : texture_2d<f32>;
@group(0) @binding(2) var u_sampler : sampler;

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clipPos = u.orthoMatrix * vec4f(in.position, 0.0, 1.0);
    out.vTexCoord = in.texCoord;
    return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
    return textureSample(u_texture, u_sampler, in.vTexCoord);
}
`;
