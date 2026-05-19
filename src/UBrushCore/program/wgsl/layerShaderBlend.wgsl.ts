export const layerShaderBlendWGSL = /* wgsl */ `
struct U {
    orthoMatrix : mat4x4f,
    opacity : f32,
    mode : f32,
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
@group(0) @binding(1) var sourceTexture : texture_2d<f32>;
@group(0) @binding(2) var destinationTexture : texture_2d<f32>;
@group(0) @binding(3) var u_sampler : sampler;

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clipPos = u.orthoMatrix * vec4f(in.position, 0.0, 1.0);
    out.vTexCoord = in.texCoord;
    return out;
}

fn unpremultiply(c : vec4f) -> vec3f {
    if (c.a <= 0.0001) {
        return vec3f(0.0);
    }
    return c.rgb / c.a;
}

fn overlayChannel(s : f32, d : f32) -> f32 {
    if (d <= 0.5) {
        return 2.0 * s * d;
    }
    return 1.0 - 2.0 * (1.0 - s) * (1.0 - d);
}

fn blendColor(src : vec3f, dst : vec3f, mode : f32) -> vec3f {
    if (mode < 1.5) {
        return vec3f(
            overlayChannel(src.r, dst.r),
            overlayChannel(src.g, dst.g),
            overlayChannel(src.b, dst.b)
        );
    }
    return abs(dst - src);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
    let srcSample = textureSample(sourceTexture, u_sampler, in.vTexCoord);
    let dstSample = textureSample(destinationTexture, u_sampler, in.vTexCoord);
    let srcA = clamp(srcSample.a * u.opacity, 0.0, 1.0);
    let dstA = clamp(dstSample.a, 0.0, 1.0);
    let outA = srcA + dstA * (1.0 - srcA);

    let srcRGB = clamp(srcSample.rgb, vec3f(0.0), vec3f(1.0));
    let dstRGB = clamp(unpremultiply(dstSample), vec3f(0.0), vec3f(1.0));
    let blended = blendColor(srcRGB, dstRGB, u.mode);
    let outRGB = (blended * srcA + dstRGB * dstA * (1.0 - srcA));

    return vec4f(outRGB, outA);
}
`;
