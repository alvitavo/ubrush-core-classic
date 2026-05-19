export const colorFillWGSL = /* wgsl */ `
struct U {
    orthoMatrix : mat4x4f,
    color : vec4f,
};

struct VsIn {
    @location(0) position : vec2f,
};

struct VsOut {
    @builtin(position) clipPos : vec4f,
};

@group(0) @binding(0) var<uniform> u : U;

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clipPos = u.orthoMatrix * vec4f(in.position, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(_in : VsOut) -> @location(0) vec4f {
    return u.color;
}
`;
