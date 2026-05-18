export const layerCompositeWGSL = /* wgsl */ `
struct U {
    orthoMatrix : mat4x4f,
    opacity : f32,
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
    let c = textureSample(u_texture, u_sampler, in.vTexCoord);
    return vec4f(c.rgb * u.opacity, c.a * u.opacity);
}
`;
