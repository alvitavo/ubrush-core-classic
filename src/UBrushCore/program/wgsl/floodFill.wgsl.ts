export const floodFillSeedWGSL = /* wgsl */ `
struct Params {
    size : vec2u,
    seed : vec2u,
    tolerance : f32,
    edgeThreshold : f32,
    _pad0 : vec2u,
};

@group(0) @binding(0) var sourceTex : texture_2d<f32>;
@group(0) @binding(1) var maskTex : texture_storage_2d<r32uint, write>;
@group(0) @binding(2) var<uniform> params : Params;

fn colorDistance(a : vec4f, b : vec4f) -> f32 {
    let d = a - b;
    return sqrt(dot(d, d));
}

fn edgeStrength(p : vec2u) -> f32 {
    let maxP = params.size - vec2u(1u, 1u);
    let l = textureLoad(sourceTex, vec2i(vec2u(max(p.x, 1u) - 1u, p.y)), 0);
    let r = textureLoad(sourceTex, vec2i(vec2u(min(p.x + 1u, maxP.x), p.y)), 0);
    let d = textureLoad(sourceTex, vec2i(vec2u(p.x, max(p.y, 1u) - 1u)), 0);
    let u = textureLoad(sourceTex, vec2i(vec2u(p.x, min(p.y + 1u, maxP.y))), 0);
    return length(l.rgb - r.rgb) + abs(l.a - r.a) + length(d.rgb - u.rgb) + abs(d.a - u.a);
}

fn eligible(p : vec2u, seedColor : vec4f) -> bool {
    let c = textureLoad(sourceTex, vec2i(p), 0);
    return colorDistance(c, seedColor) <= params.tolerance && edgeStrength(p) <= params.edgeThreshold;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id : vec3u) {
    if (id.x >= params.size.x || id.y >= params.size.y) {
        return;
    }

    let p = id.xy;
    let seedColor = textureLoad(sourceTex, vec2i(params.seed), 0);
    let filled = p.x == params.seed.x && p.y == params.seed.y && eligible(p, seedColor);
    textureStore(maskTex, vec2i(p), vec4u(select(0u, 1u, filled), 0u, 0u, 0u));
}
`;

export const floodFillStepWGSL = /* wgsl */ `
struct Params {
    size : vec2u,
    seed : vec2u,
    tolerance : f32,
    edgeThreshold : f32,
    _pad0 : vec2u,
};

@group(0) @binding(0) var sourceTex : texture_2d<f32>;
@group(0) @binding(1) var prevMask : texture_2d<u32>;
@group(0) @binding(2) var nextMask : texture_storage_2d<r32uint, write>;
@group(0) @binding(3) var<uniform> params : Params;

fn colorDistance(a : vec4f, b : vec4f) -> f32 {
    let d = a - b;
    return sqrt(dot(d, d));
}

fn edgeBetween(a : vec2u, b : vec2u) -> f32 {
    let ca = textureLoad(sourceTex, vec2i(a), 0);
    let cb = textureLoad(sourceTex, vec2i(b), 0);
    return length(ca.rgb - cb.rgb) + abs(ca.a - cb.a);
}

fn edgeStrength(p : vec2u) -> f32 {
    let maxP = params.size - vec2u(1u, 1u);
    let l = textureLoad(sourceTex, vec2i(vec2u(max(p.x, 1u) - 1u, p.y)), 0);
    let r = textureLoad(sourceTex, vec2i(vec2u(min(p.x + 1u, maxP.x), p.y)), 0);
    let d = textureLoad(sourceTex, vec2i(vec2u(p.x, max(p.y, 1u) - 1u)), 0);
    let u = textureLoad(sourceTex, vec2i(vec2u(p.x, min(p.y + 1u, maxP.y))), 0);
    return length(l.rgb - r.rgb) + abs(l.a - r.a) + length(d.rgb - u.rgb) + abs(d.a - u.a);
}

fn eligible(p : vec2u, seedColor : vec4f) -> bool {
    let c = textureLoad(sourceTex, vec2i(p), 0);
    return colorDistance(c, seedColor) <= params.tolerance && edgeStrength(p) <= params.edgeThreshold;
}

fn neighborFilled(p : vec2u) -> bool {
    let maxP = params.size - vec2u(1u, 1u);
    var hit = false;
    if (p.x > 0u) {
        let n = vec2u(p.x - 1u, p.y);
        hit = hit || (textureLoad(prevMask, vec2i(n), 0).r != 0u && edgeBetween(p, n) <= params.edgeThreshold);
    }
    if (p.x < maxP.x) {
        let n = vec2u(p.x + 1u, p.y);
        hit = hit || (textureLoad(prevMask, vec2i(n), 0).r != 0u && edgeBetween(p, n) <= params.edgeThreshold);
    }
    if (p.y > 0u) {
        let n = vec2u(p.x, p.y - 1u);
        hit = hit || (textureLoad(prevMask, vec2i(n), 0).r != 0u && edgeBetween(p, n) <= params.edgeThreshold);
    }
    if (p.y < maxP.y) {
        let n = vec2u(p.x, p.y + 1u);
        hit = hit || (textureLoad(prevMask, vec2i(n), 0).r != 0u && edgeBetween(p, n) <= params.edgeThreshold);
    }
    return hit;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id : vec3u) {
    if (id.x >= params.size.x || id.y >= params.size.y) {
        return;
    }

    let p = id.xy;
    let alreadyFilled = textureLoad(prevMask, vec2i(p), 0).r != 0u;
    let seedColor = textureLoad(sourceTex, vec2i(params.seed), 0);
    let filled = alreadyFilled || (eligible(p, seedColor) && neighborFilled(p));
    textureStore(nextMask, vec2i(p), vec4u(select(0u, 1u, filled), 0u, 0u, 0u));
}
`;

export const floodFillApplyWGSL = /* wgsl */ `
struct Params {
    size : vec2u,
    seed : vec2u,
    tolerance : f32,
    edgeThreshold : f32,
    fillColor : vec4f,
};

struct Bounds {
    minX : atomic<u32>,
    minY : atomic<u32>,
    maxX : atomic<u32>,
    maxY : atomic<u32>,
    count : atomic<u32>,
};

@group(0) @binding(0) var sourceTex : texture_2d<f32>;
@group(0) @binding(1) var maskTex : texture_2d<u32>;
@group(0) @binding(2) var targetTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params : Params;
@group(0) @binding(4) var<storage, read_write> bounds : Bounds;

fn maskAt(p : vec2u) -> u32 {
    return textureLoad(maskTex, vec2i(p), 0).r;
}

fn edgeWeight(p : vec2u) -> f32 {
    let maxP = params.size - vec2u(1u, 1u);
    var insideCount = 0.0;
    var total = 0.0;

    for (var oy : i32 = -1; oy <= 1; oy = oy + 1) {
        for (var ox : i32 = -1; ox <= 1; ox = ox + 1) {
            let nx = clamp(i32(p.x) + ox, 0, i32(maxP.x));
            let ny = clamp(i32(p.y) + oy, 0, i32(maxP.y));
            insideCount = insideCount + select(0.0, 1.0, maskAt(vec2u(u32(nx), u32(ny))) != 0u);
            total = total + 1.0;
        }
    }

    return clamp(insideCount / total, 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id : vec3u) {
    if (id.x >= params.size.x || id.y >= params.size.y) {
        return;
    }

    let p = id.xy;
    let src = textureLoad(sourceTex, vec2i(p), 0);
    if (maskAt(p) == 0u) {
        textureStore(targetTex, vec2i(p), src);
        return;
    }

    atomicMin(&bounds.minX, p.x);
    atomicMin(&bounds.minY, p.y);
    atomicMax(&bounds.maxX, p.x);
    atomicMax(&bounds.maxY, p.y);
    atomicAdd(&bounds.count, 1u);

    let feather = edgeWeight(p);
    let alpha = params.fillColor.a * smoothstep(0.05, 0.95, feather);
    let outColor = mix(src, vec4f(params.fillColor.rgb, 1.0), alpha);
    textureStore(targetTex, vec2i(p), vec4f(outColor.rgb, max(src.a, alpha)));
}
`;
