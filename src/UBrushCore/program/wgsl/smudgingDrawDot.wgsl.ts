// WGSL port of SmudgingDrawDotProgram.
// GLSL source: ../SmudgingDrawDotProgram.ts
//
// Vertex stage is identical to DrawDot. Fragment stage branches on u.mode:
//   mode == 0: alpha-only output (smudging alpha pass)
//   mode != 0: color output (smudging color pass)
//
// Bind group layout (group 0):
//   binding 0: var<uniform> U { mode: i32 }
//   binding 1: u_tipTexture          (texture_2d<f32>)
//   binding 2: u_patternTexture      (texture_2d<f32>)
//   binding 3: u_smudging0RefTexture (texture_2d<f32>)
//   binding 4: u_smudgingRefTexture  (texture_2d<f32>)
//   binding 5: u_sampler             (sampler — clamp)
//   binding 6: u_patternSampler      (sampler — repeat, pattern texture only)
//
// Vertex buffers: identical to DrawDot (locations 0..12).

export const smudgingDrawDotWGSL = /* wgsl */ `
struct U {
    mode  : i32,
    _pad0 : i32,
    _pad1 : i32,
    _pad2 : i32,
};

struct VsIn {
    @location(0)  corner          : vec2f,
    @location(1)  posCenterAxisU  : vec4f,
    @location(2)  posAxisV        : vec2f,
    @location(3)  tipUV           : vec4f,
    @location(4)  patternUVa      : vec4f,
    @location(5)  patternUVb      : vec2f,
    @location(6)  smudging0UVa    : vec4f,
    @location(7)  smudging0UVb    : vec2f,
    @location(8)  smudgingUVa     : vec4f,
    @location(9)  smudgingUVb     : vec2f,
    @location(10) tintColor       : vec4f,
    @location(11) opacity         : vec4f,
    @location(12) corrosion       : vec4f,
};

struct VsOut {
    @builtin(position) clipPos                      : vec4f,
    @location(0)       vTintColor                   : vec4f,
    @location(1)       vTipTextureCoordinate        : vec2f,
    @location(2)       vPatternTextureCoordinate    : vec2f,
    @location(3)       vSmudging0TexturePosition    : vec2f,
    @location(4)       vSmudgingTexturePosition     : vec2f,
    @location(5)       vOpacity                     : vec4f,
    @location(6)       vCorrosion                   : vec4f,
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var u_tipTexture          : texture_2d<f32>;
@group(0) @binding(2) var u_patternTexture      : texture_2d<f32>;
@group(0) @binding(3) var u_smudging0RefTexture : texture_2d<f32>;
@group(0) @binding(4) var u_smudgingRefTexture  : texture_2d<f32>;
@group(0) @binding(5) var u_sampler             : sampler;
@group(0) @binding(6) var u_patternSampler      : sampler;

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;

    let clipCenter = in.posCenterAxisU.xy;
    let axisU      = in.posCenterAxisU.zw;
    let axisV      = in.posAxisV;
    let clipPos    = clipCenter + in.corner.x * axisU + in.corner.y * axisV;
    out.clipPos = vec4f(clipPos, 0.0, 1.0);

    let bary = in.corner * 0.5 + vec2f(0.5);
    out.vTipTextureCoordinate = in.tipUV.xy + bary * in.tipUV.zw;

    out.vPatternTextureCoordinate = in.patternUVa.xy + in.corner.x * in.patternUVa.zw + in.corner.y * in.patternUVb;
    out.vSmudging0TexturePosition = in.smudging0UVa.xy + in.corner.x * in.smudging0UVa.zw + in.corner.y * in.smudging0UVb;
    out.vSmudgingTexturePosition  = in.smudgingUVa.xy  + in.corner.x * in.smudgingUVa.zw  + in.corner.y * in.smudgingUVb;

    out.vTintColor = in.tintColor;
    out.vOpacity   = in.opacity;
    out.vCorrosion = in.corrosion;

    return out;
}

fn corrosionFn(v : f32, c : f32, size : f32) -> f32 {
    let s = max(0.001, size);
    return clamp((v - 1.0 + min(1.0, s + c)) / s, 0.0, 1.0);
}

fn textureCorrosionFn(v : f32, c : f32, size : f32) -> f32 {
    let s = max(0.001, size);
    return 1.0 - clamp((min(1.0, s + c) - v) / s, 0.0, 1.0);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
    if (u.mode == 0) {
        // alpha-only path
        var s_rawPatternAlpha = textureSample(u_patternTexture, u_patternSampler, in.vPatternTextureCoordinate).a;
        s_rawPatternAlpha = textureCorrosionFn(s_rawPatternAlpha, in.vCorrosion[1], in.vCorrosion[3]);
        let s_patternMaskAlpha = 1.0 - s_rawPatternAlpha * in.vOpacity[1];

        var s_tipAlpha = textureSample(u_tipTexture, u_sampler, in.vTipTextureCoordinate).a;
        s_tipAlpha = corrosionFn(s_tipAlpha, in.vCorrosion[0], in.vCorrosion[2]);
        let s_smudgingAlpha = s_tipAlpha;

        // V flip — smudging refs are render targets (row 0 = top in WebGPU).
        let s_smudging0White = textureSample(u_smudging0RefTexture, u_sampler, vec2f(in.vSmudging0TexturePosition.x, 1.0 - in.vSmudging0TexturePosition.y)).r * (1.0 - in.vOpacity[3]);
        let s_smudgingWhite  = textureSample(u_smudgingRefTexture,  u_sampler, vec2f(in.vSmudgingTexturePosition.x,  1.0 - in.vSmudgingTexturePosition.y)).r  * in.vOpacity[3];

        let s_white = ((s_tipAlpha * in.vOpacity[0]) + ((s_smudging0White + s_smudgingWhite) * s_tipAlpha * in.vOpacity[2] * (1.0 - in.vOpacity[0]))) * s_patternMaskAlpha;
        let s_alpha = ((s_tipAlpha * in.vOpacity[0]) + (s_smudgingAlpha * in.vOpacity[2] * (1.0 - in.vOpacity[0]))) * s_patternMaskAlpha;

        return vec4f(vec3f(s_white), s_alpha);
    } else {
        // color path (same as DrawDot fragment)
        var s_rawPatternAlpha = textureSample(u_patternTexture, u_patternSampler, in.vPatternTextureCoordinate).a;
        s_rawPatternAlpha = textureCorrosionFn(s_rawPatternAlpha, in.vCorrosion[1], in.vCorrosion[3]);
        let s_patternMaskAlpha = 1.0 - s_rawPatternAlpha * in.vOpacity[1];

        var s_tipColor = textureSample(u_tipTexture, u_sampler, in.vTipTextureCoordinate);
        s_tipColor.a = corrosionFn(s_tipColor.a, in.vCorrosion[0], in.vCorrosion[2]);

        let tipRgb = s_tipColor.rgb * s_tipColor.a;
        let tinted = tipRgb * (1.0 - in.vTintColor.a) + in.vTintColor.rgb * s_tipColor.a * in.vTintColor.a;
        s_tipColor = vec4f(tinted, s_tipColor.a);

        // V flip — smudging refs are render targets (row 0 = top in WebGPU).
        let s_smudging0Color = textureSample(u_smudging0RefTexture, u_sampler, vec2f(in.vSmudging0TexturePosition.x, 1.0 - in.vSmudging0TexturePosition.y)) * (1.0 - in.vOpacity[3]);
        let s_smudgingColor  = textureSample(u_smudgingRefTexture,  u_sampler, vec2f(in.vSmudgingTexturePosition.x,  1.0 - in.vSmudgingTexturePosition.y))  * in.vOpacity[3];

        var s_out = (s_tipColor * in.vOpacity[0]) + ((s_smudging0Color + s_smudgingColor) * s_tipColor.a * in.vOpacity[2] * (1.0 - in.vOpacity[0]));
        s_out = s_out * s_patternMaskAlpha;

        return s_out;
    }
}
`;
