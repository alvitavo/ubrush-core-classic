// WGSL port of DrawDotProgram.
// GLSL source: ../DrawDotProgram.ts
//
// Bind group layout (group 0):
//   binding 0: u_tipTexture          (texture_2d<f32>)
//   binding 1: u_patternTexture      (texture_2d<f32>)
//   binding 2: u_smudging0RefTexture (texture_2d<f32>)
//   binding 3: u_smudgingRefTexture  (texture_2d<f32>)
//   binding 4: u_sampler             (sampler)
//
// Vertex buffers:
//   slot  0, location  0, per-vertex   : a_corner          (vec2f) — 4 corners (TriangleStrip)
//   slot  1, location  1, per-instance : a_posCenterAxisU  (vec4f)
//   slot  2, location  2, per-instance : a_posAxisV        (vec2f)
//   slot  3, location  3, per-instance : a_tipUV           (vec4f)
//   slot  4, location  4, per-instance : a_patternUVa      (vec4f)
//   slot  5, location  5, per-instance : a_patternUVb      (vec2f)
//   slot  6, location  6, per-instance : a_smudging0UVa    (vec4f)
//   slot  7, location  7, per-instance : a_smudging0UVb    (vec2f)
//   slot  8, location  8, per-instance : a_smudgingUVa     (vec4f)
//   slot  9, location  9, per-instance : a_smudgingUVb     (vec2f)
//   slot 10, location 10, per-instance : a_tintColor       (vec4f)
//   slot 11, location 11, per-instance : a_opacity         (vec4f)
//   slot 12, location 12, per-instance : a_corrosion       (vec4f)

export const drawDotWGSL = /* wgsl */ `
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

@group(0) @binding(0) var u_tipTexture          : texture_2d<f32>;
@group(0) @binding(1) var u_patternTexture      : texture_2d<f32>;
@group(0) @binding(2) var u_smudging0RefTexture : texture_2d<f32>;
@group(0) @binding(3) var u_smudgingRefTexture  : texture_2d<f32>;
@group(0) @binding(4) var u_sampler             : sampler;

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
    var s_rawPatternAlpha = textureSample(u_patternTexture, u_sampler, in.vPatternTextureCoordinate).a;
    s_rawPatternAlpha = textureCorrosionFn(s_rawPatternAlpha, in.vCorrosion[1], in.vCorrosion[3]);
    let s_patternMaskAlpha = 1.0 - s_rawPatternAlpha * in.vOpacity[1];

    var s_tipColor = textureSample(u_tipTexture, u_sampler, in.vTipTextureCoordinate);
    s_tipColor.a = corrosionFn(s_tipColor.a, in.vCorrosion[0], in.vCorrosion[2]);

    let tipRgb = s_tipColor.rgb * s_tipColor.a;
    let tinted = tipRgb * (1.0 - in.vTintColor.a) + in.vTintColor.rgb * s_tipColor.a * in.vTintColor.a;
    s_tipColor = vec4f(tinted, s_tipColor.a);

    let s_smudging0Color = textureSample(u_smudging0RefTexture, u_sampler, in.vSmudging0TexturePosition) * (1.0 - in.vOpacity[3]);
    let s_smudgingColor  = textureSample(u_smudgingRefTexture,  u_sampler, in.vSmudgingTexturePosition)  * in.vOpacity[3];

    var s_out = (s_tipColor * in.vOpacity[0]) + ((s_smudging0Color + s_smudgingColor) * s_tipColor.a * in.vOpacity[2] * (1.0 - in.vOpacity[0]));
    s_out = s_out * s_patternMaskAlpha;

    return s_out;
}
`;
