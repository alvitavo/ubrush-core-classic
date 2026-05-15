const TILE_SIZE = 16;

export const floodFillSeedWGSL = /* wgsl */ `
struct Params {
    size : vec2u,
    seed : vec2u,
    tolerance : f32,
    edgeThreshold : f32,
    tileGrid : vec2u,
};

@group(0) @binding(0) var sourceTex : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> mask : array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> activeList : array<u32>;
@group(0) @binding(3) var<storage, read_write> filledTiles : array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> activeCount : atomic<u32>;
@group(0) @binding(5) var<uniform> params : Params;

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

@compute @workgroup_size(1, 1)
fn main() {
    let p = params.seed;
    let seedColor = textureLoad(sourceTex, vec2i(p), 0);
    if (!eligible(p, seedColor)) {
        return;
    }

    let pixelIndex = p.y * params.size.x + p.x;
    let tile = p / vec2u(${TILE_SIZE}u, ${TILE_SIZE}u);
    let tileIndex = tile.y * params.tileGrid.x + tile.x;
    atomicStore(&mask[pixelIndex], 1u);
    let listIndex = atomicAdd(&activeCount, 1u);
    activeList[listIndex] = tileIndex;
    atomicStore(&filledTiles[tileIndex], 1u);
}
`;

export const floodFillIndirectWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> count : u32;
@group(0) @binding(1) var<storage, read_write> indirect : array<u32>;

@compute @workgroup_size(1, 1)
fn main() {
    indirect[0] = count;
    indirect[1] = 1u;
    indirect[2] = 1u;
}
`;

export const floodFillStepWGSL = /* wgsl */ `
struct Params {
    size : vec2u,
    seed : vec2u,
    tolerance : f32,
    edgeThreshold : f32,
    tileGrid : vec2u,
};

@group(0) @binding(0) var sourceTex : texture_2d<f32>;
@group(0) @binding(1) var<storage, read> activeList : array<u32>;
@group(0) @binding(2) var<storage, read_write> nextActiveList : array<u32>;
@group(0) @binding(3) var<storage, read_write> nextActiveFlags : array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> nextActiveCount : atomic<u32>;
@group(0) @binding(5) var<storage, read_write> filledTiles : array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> mask : array<atomic<u32>>;
@group(0) @binding(7) var<uniform> params : Params;

fn pixelIndex(p : vec2u) -> u32 {
    return p.y * params.size.x + p.x;
}

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

fn maskAt(p : vec2u) -> bool {
    return atomicLoad(&mask[pixelIndex(p)]) != 0u;
}

fn neighborFilled(p : vec2u) -> bool {
    let maxP = params.size - vec2u(1u, 1u);
    var hit = false;
    if (p.x > 0u) {
        let n = vec2u(p.x - 1u, p.y);
        hit = hit || (maskAt(n) && edgeBetween(p, n) <= params.edgeThreshold);
    }
    if (p.x < maxP.x) {
        let n = vec2u(p.x + 1u, p.y);
        hit = hit || (maskAt(n) && edgeBetween(p, n) <= params.edgeThreshold);
    }
    if (p.y > 0u) {
        let n = vec2u(p.x, p.y - 1u);
        hit = hit || (maskAt(n) && edgeBetween(p, n) <= params.edgeThreshold);
    }
    if (p.y < maxP.y) {
        let n = vec2u(p.x, p.y + 1u);
        hit = hit || (maskAt(n) && edgeBetween(p, n) <= params.edgeThreshold);
    }
    return hit;
}

fn wakeTile(tile : vec2u) {
    if (tile.x >= params.tileGrid.x || tile.y >= params.tileGrid.y) {
        return;
    }
    let tileIndex = tile.y * params.tileGrid.x + tile.x;
    if (atomicExchange(&nextActiveFlags[tileIndex], 1u) == 0u) {
        let listIndex = atomicAdd(&nextActiveCount, 1u);
        nextActiveList[listIndex] = tileIndex;
    }
}

fn wakeNeighbors(tile : vec2u, local : vec2u) {
    wakeTile(tile);
    if (local.x == 0u && tile.x > 0u) {
        wakeTile(vec2u(tile.x - 1u, tile.y));
    }
    if (local.x == ${TILE_SIZE - 1}u && tile.x + 1u < params.tileGrid.x) {
        wakeTile(vec2u(tile.x + 1u, tile.y));
    }
    if (local.y == 0u && tile.y > 0u) {
        wakeTile(vec2u(tile.x, tile.y - 1u));
    }
    if (local.y == ${TILE_SIZE - 1}u && tile.y + 1u < params.tileGrid.y) {
        wakeTile(vec2u(tile.x, tile.y + 1u));
    }
}

@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn main(
    @builtin(workgroup_id) workgroupId : vec3u,
    @builtin(local_invocation_id) localId : vec3u
) {
    let tileIndex = activeList[workgroupId.x];
    let tile = vec2u(tileIndex % params.tileGrid.x, tileIndex / params.tileGrid.x);

    let p = tile * vec2u(${TILE_SIZE}u, ${TILE_SIZE}u) + localId.xy;
    if (p.x >= params.size.x || p.y >= params.size.y) {
        return;
    }

    if (maskAt(p)) {
        return;
    }

    let seedColor = textureLoad(sourceTex, vec2i(params.seed), 0);
    if (eligible(p, seedColor) && neighborFilled(p)) {
        atomicStore(&mask[pixelIndex(p)], 1u);
        atomicStore(&filledTiles[tileIndex], 1u);
        wakeNeighbors(tile, localId.xy);
    }
}
`;

export const floodFillApplyWGSL = /* wgsl */ `
struct Params {
    size : vec2u,
    seed : vec2u,
    tolerance : f32,
    edgeThreshold : f32,
    tileGrid : vec2u,
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
@group(0) @binding(1) var<storage, read> mask : array<u32>;
@group(0) @binding(2) var<storage, read> filledTiles : array<u32>;
@group(0) @binding(3) var targetTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<uniform> params : Params;
@group(0) @binding(5) var<storage, read_write> bounds : Bounds;

fn pixelIndex(p : vec2u) -> u32 {
    return p.y * params.size.x + p.x;
}

fn maskAt(p : vec2u) -> u32 {
    return mask[pixelIndex(p)];
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

@compute @workgroup_size(${TILE_SIZE}, ${TILE_SIZE})
fn main(
    @builtin(workgroup_id) tileId : vec3u,
    @builtin(local_invocation_id) localId : vec3u
) {
    let tile = tileId.xy;
    let tileIndex = tile.y * params.tileGrid.x + tile.x;
    if (filledTiles[tileIndex] == 0u) {
        return;
    }

    let p = tile * vec2u(${TILE_SIZE}u, ${TILE_SIZE}u) + localId.xy;
    if (p.x >= params.size.x || p.y >= params.size.y) {
        return;
    }

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
