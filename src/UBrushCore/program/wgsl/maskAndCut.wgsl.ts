// WGSL port of MaskAndCutProgram.
// GLSL source: ../MaskAndCutProgram.ts
//
// Bind group layout (group 0):
//   binding 0: var<uniform> U { orthoMatrix, opacity, lowCut, highCut,
//                               hasEdge, hasMaskEdge, blendmode }
//   binding 1: u_edgeTexture
//   binding 2: u_maskEdgeTexture
//   binding 3: u_dryTexture
//   binding 4: u_liquidTexture
//   binding 5: u_maskTexture
//   binding 6: u_sampler
//
// Vertex buffers:
//   slot 0, location 0: a_position (vec2f)
//   slot 1, location 1: a_textureCoordinate (vec2f)

export const maskAndCutWGSL = /* wgsl */ `
struct U {
    orthoMatrix : mat4x4f,
    opacity     : f32,
    lowCut      : f32,
    highCut     : f32,
    hasEdge     : i32,
    hasMaskEdge : i32,
    blendmode   : i32,
    _pad0       : i32,
    _pad1       : i32,
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
@group(0) @binding(1) var u_edgeTexture     : texture_2d<f32>;
@group(0) @binding(2) var u_maskEdgeTexture : texture_2d<f32>;
@group(0) @binding(3) var u_dryTexture      : texture_2d<f32>;
@group(0) @binding(4) var u_liquidTexture   : texture_2d<f32>;
@group(0) @binding(5) var u_maskTexture     : texture_2d<f32>;
@group(0) @binding(6) var u_sampler         : sampler;

@vertex
fn vs_main(in : VsIn) -> VsOut {
    var out : VsOut;
    out.clipPos = u.orthoMatrix * vec4f(in.position, 0.0, 1.0);
    out.vTexCoord = in.texCoord;
    return out;
}

fn blendLum(c : vec3f) -> f32 {
    return dot(c, vec3f(0.299, 0.587, 0.114));
}

fn blendSat(c : vec3f) -> f32 {
    return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

fn blendClipColor(cIn : vec3f) -> vec3f {
    var c = cIn;
    let l = blendLum(c);
    let n = min(min(c.r, c.g), c.b);
    let x = max(max(c.r, c.g), c.b);
    if (n < 0.0) { c = vec3f(l) + (c - vec3f(l)) * (l / (l - n)); }
    if (x > 1.0) { c = vec3f(l) + (c - vec3f(l)) * ((1.0 - l) / (x - l)); }
    return c;
}

fn blendSetLum(c : vec3f, l : f32) -> vec3f {
    return blendClipColor(c + vec3f(l - blendLum(c)));
}

fn blendSetSat(c : vec3f, s : f32) -> vec3f {
    let lo = min(min(c.r, c.g), c.b);
    let hi = max(max(c.r, c.g), c.b);
    if (hi > lo) { return (c - vec3f(lo)) * (s / (hi - lo)); }
    return vec3f(0.0);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
    let dryColor = textureSample(u_dryTexture, u_sampler, in.vTexCoord);
    var liquidColor = textureSample(u_liquidTexture, u_sampler, in.vTexCoord);
    var rawMask = textureSample(u_maskTexture, u_sampler, in.vTexCoord).a;

    if (u.hasMaskEdge == 1) {
        rawMask = textureSample(u_maskEdgeTexture, u_sampler, vec2f(((rawMask * 255.0) + 0.5) / 256.0, 0.5)).r;
    }

    let maskAlpha = rawMask * liquidColor.a;
    var newAlpha : f32;

    if (u.lowCut == 0.0 && u.highCut == 1.0 && u.hasEdge == 0) {
        newAlpha = maskAlpha * u.opacity;
    } else {
        newAlpha = clamp((maskAlpha - u.lowCut) / (u.highCut - u.lowCut), 0.0, 1.0) * u.opacity;

        if (u.hasEdge == 1) {
            newAlpha = textureSample(u_edgeTexture, u_sampler, vec2f(((newAlpha * 255.0) + 0.5) / 256.0, 0.5)).r;
        }
    }

    liquidColor = clamp(vec4f((liquidColor.rgb / liquidColor.a) * newAlpha, newAlpha), vec4f(0.0), vec4f(1.0));

    if (u.blendmode == 26) {
        return dryColor * (1.0 - liquidColor.a);
    }

    let cb = select(vec3f(0.0), dryColor.rgb / dryColor.a, dryColor.a > 0.0);
    let cs = select(vec3f(0.0), liquidColor.rgb / liquidColor.a, liquidColor.a > 0.0);
    var blended : vec3f;
    var sl_d : vec3f = vec3f(0.0);

    if (u.blendmode == 1) {
        blended = min(cb, cs);
    } else if (u.blendmode == 2) {
        blended = cb * cs;
    } else if (u.blendmode == 3) {
        blended = clamp(vec3f(1.0) - (vec3f(1.0) - cb) / max(cs, vec3f(0.0001)), vec3f(0.0), vec3f(1.0));
    } else if (u.blendmode == 4) {
        blended = clamp(cb + cs - vec3f(1.0), vec3f(0.0), vec3f(1.0));
    } else if (u.blendmode == 5) {
        blended = select(cs, cb, blendLum(cb) <= blendLum(cs));
    } else if (u.blendmode == 6) {
        blended = max(cb, cs);
    } else if (u.blendmode == 7) {
        blended = cb + cs - cb * cs;
    } else if (u.blendmode == 8) {
        blended = clamp(cb / max(vec3f(1.0) - cs, vec3f(0.0001)), vec3f(0.0), vec3f(1.0));
    } else if (u.blendmode == 9) {
        blended = clamp(cb + cs, vec3f(0.0), vec3f(1.0));
    } else if (u.blendmode == 10) {
        blended = select(cs, cb, blendLum(cb) >= blendLum(cs));
    } else if (u.blendmode == 11) {
        blended = mix(2.0 * cb * cs, vec3f(1.0) - 2.0 * (vec3f(1.0) - cb) * (vec3f(1.0) - cs), step(vec3f(0.5), cb));
    } else if (u.blendmode == 12) {
        sl_d = mix(((16.0 * cb - vec3f(12.0)) * cb + vec3f(4.0)) * cb, sqrt(max(cb, vec3f(0.0))), step(vec3f(0.25), cb));
        blended = mix(cb - (vec3f(1.0) - 2.0 * cs) * cb * (vec3f(1.0) - cb), cb + (2.0 * cs - vec3f(1.0)) * (sl_d - cb), step(vec3f(0.5), cs));
    } else if (u.blendmode == 13) {
        blended = mix(2.0 * cb * cs, vec3f(1.0) - 2.0 * (vec3f(1.0) - cb) * (vec3f(1.0) - cs), step(vec3f(0.5), cs));
    } else if (u.blendmode == 14) {
        blended = mix(
            clamp(vec3f(1.0) - (vec3f(1.0) - cb) / max(2.0 * cs, vec3f(0.0001)), vec3f(0.0), vec3f(1.0)),
            clamp(cb / max(2.0 * (vec3f(1.0) - cs), vec3f(0.0001)), vec3f(0.0), vec3f(1.0)),
            step(vec3f(0.5), cs));
    } else if (u.blendmode == 15) {
        blended = clamp(cb + 2.0 * cs - vec3f(1.0), vec3f(0.0), vec3f(1.0));
    } else if (u.blendmode == 16) {
        blended = mix(min(cb, 2.0 * cs), max(cb, 2.0 * cs - vec3f(1.0)), step(vec3f(0.5), cs));
    } else if (u.blendmode == 17) {
        blended = step(vec3f(1.0), cb + cs);
    } else if (u.blendmode == 18) {
        blended = abs(cb - cs);
    } else if (u.blendmode == 19) {
        blended = cb + cs - 2.0 * cb * cs;
    } else if (u.blendmode == 20) {
        blended = clamp(cb - cs, vec3f(0.0), vec3f(1.0));
    } else if (u.blendmode == 21) {
        blended = clamp(cb / max(cs, vec3f(0.0001)), vec3f(0.0), vec3f(1.0));
    } else if (u.blendmode == 22) {
        blended = blendSetLum(blendSetSat(cs, blendSat(cb)), blendLum(cb));
    } else if (u.blendmode == 23) {
        blended = blendSetLum(blendSetSat(cb, blendSat(cs)), blendLum(cb));
    } else if (u.blendmode == 24) {
        blended = blendSetLum(cs, blendLum(cb));
    } else if (u.blendmode == 25) {
        blended = blendSetLum(cb, blendLum(cs));
    } else {
        blended = cs;
    }

    let resultAlpha = liquidColor.a + dryColor.a * (1.0 - liquidColor.a);
    return vec4f(
        liquidColor.rgb * (1.0 - dryColor.a) + dryColor.rgb * (1.0 - liquidColor.a) + dryColor.a * liquidColor.a * blended,
        resultAlpha
    );
}
`;
