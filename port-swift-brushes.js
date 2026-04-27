#!/usr/bin/env node
/**
 * Port Swift brush JSON (ubrushcore-for-swift) into Classic format (this repo).
 *
 * Conversion rules:
 *   - brushSize     -> defaultSize
 *   - brushOpacity  -> defaultOpacity
 *   - sizeRange[a,b]            -> minSize/maxSize
 *   - opacityRange[a,b]         -> minOpacity/maxOpacity
 *   - layerCutRange[a,b]        -> layerLowCut/layerHighCut
 *   - layerOpacityRange[a,b]    -> minLayerOpacity/maxLayerOpacity (+ layerOpacity = b)
 *   - dualTipOpacityRange[a,b]  -> dualTipMinOpacity/dualTipMaxOpacity
 *   - Expression { range:[a,b], sources } -> { min:a, max:b, sources }
 *   - "<LOCAL>Foo</LOCAL>"      -> "Foo"
 *   - Add classic-only defaults that the Swift schema dropped (oval, deltaAngle, ...)
 *
 * Swift-only fields (brushMode, sampleType, patternBlendmode, ...) are preserved
 * verbatim so future engine work can pick them up.
 */

const fs = require('fs');
const path = require('path');

const SWIFT_DIR = '/Users/hwanghochul/sourcetree_ind/ubrushcore-for-swift/resource/brushes';
const CLASSIC_DIR = path.join(__dirname, 'brushes');

// Swift filename -> { classicFile, key, displayName }
const FILE_MAPPING = [
    { swift: 'Airbrush.json',    classic: 'airbrush.json',     key: 'airbrush',     displayName: 'Airbrush'     },
    { swift: 'Artist.json',      classic: 'impressionist.json',key: 'impressionist',displayName: 'Impressionist'},
    { swift: 'Dry media.json',   classic: 'dry_media.json',    key: 'dry_media',    displayName: 'Dry Media'    },
    { swift: 'Watercolor.json',  classic: 'watercolor.json',   key: 'watercolor',   displayName: 'Watercolor'   },
    { swift: 'Wet media.json',   classic: 'wet.json',          key: 'wet',          displayName: 'Wet'          },
    { swift: 'Mix brush.json',   classic: 'oil_mix.json',      key: 'oil_mix',      displayName: 'Oil & Mix'    },
    { swift: 'Painting.json',    classic: 'acrylic.json',      key: 'acrylic',      displayName: 'Acrylic'      },
    { swift: 'Pen.json',         classic: 'pen.json',          key: 'pen',          displayName: 'Pen'          },
    { swift: 'Sketch.json',      classic: 'sketch.json',       key: 'sketch',       displayName: 'Sketch'       },
    { swift: 'Marker.json',      classic: 'marker.json',       key: 'marker',       displayName: 'Marker'       },
    { swift: 'Halftone.json',    classic: 'halftone.json',     key: 'halftone',     displayName: 'Halftone'     },
    { swift: 'Spread.json',      classic: 'spread.json',       key: 'spread',       displayName: 'Spread'       },
    { swift: 'Effect.json',      classic: 'special.json',      key: 'special',      displayName: 'Special'      },
];

// Swift range-array -> classic min/max key pair
const RANGE_KEY_MAP = {
    sizeRange:           ['minSize',         'maxSize'],
    opacityRange:        ['minOpacity',      'maxOpacity'],
    layerCutRange:       ['layerLowCut',     'layerHighCut'],
    layerOpacityRange:   ['minLayerOpacity', 'maxLayerOpacity'],
    dualTipOpacityRange: ['dualTipMinOpacity','dualTipMaxOpacity'],
};

// Classic-only defaults (Swift schema doesn't carry these)
const CLASSIC_DEFAULTS = {
    oval: 0,
    dualTipOval: 0,
    deltaAngle: 0,
    dualTipDeltaAngle: 0,
    tailLength: 0,
    skipInterval: 0,
    useTextureFitting: false,
    useLayerWetEdge: false,
    minMixingOpacity: 0,
    maxMixingOpacity: 1,
    offsetForAltitude: 0,
};

function isExpression(v) {
    return v && typeof v === 'object' && !Array.isArray(v)
        && Array.isArray(v.range) && v.range.length === 2
        && Array.isArray(v.sources);
}

function convertExpression(expr) {
    return {
        min: expr.range[0],
        max: expr.range[1],
        sources: expr.sources,
    };
}

function stripLocal(name) {
    if (typeof name !== 'string') return name;
    const m = name.match(/^<LOCAL>(.*)<\/LOCAL>$/);
    return m ? m[1] : name;
}

function convertBrush(swiftBrush) {
    const out = {};

    // 1) Walk every key, mapping range-arrays / expressions / renames as we go.
    for (const [k, v] of Object.entries(swiftBrush)) {
        if (k === 'brushSize')        { out.defaultSize    = v; continue; }
        if (k === 'brushOpacity')     { out.defaultOpacity = v; continue; }
        if (k === 'name')             { out.name = stripLocal(v); continue; }

        if (RANGE_KEY_MAP[k] && Array.isArray(v) && v.length === 2) {
            const [minKey, maxKey] = RANGE_KEY_MAP[k];
            out[minKey] = v[0];
            out[maxKey] = v[1];
            if (k === 'layerOpacityRange') out.layerOpacity = v[1];
            continue;
        }

        if (isExpression(v)) { out[k] = convertExpression(v); continue; }

        // Pass-through (preserves Swift-only fields verbatim).
        out[k] = v;
    }

    // 2) Fill classic-only defaults if the Swift brush didn't supply them.
    for (const [k, def] of Object.entries(CLASSIC_DEFAULTS)) {
        if (out[k] === undefined) out[k] = def;
    }

    return out;
}

function portFile(swiftFile, classicFile) {
    const swiftPath = path.join(SWIFT_DIR, swiftFile);
    const classicPath = path.join(CLASSIC_DIR, classicFile);
    if (!fs.existsSync(swiftPath)) {
        console.warn(`  ⚠️  missing Swift source: ${swiftFile}`);
        return 0;
    }
    const swiftBrushes = JSON.parse(fs.readFileSync(swiftPath, 'utf8'));
    const classicBrushes = swiftBrushes.map(convertBrush);
    fs.writeFileSync(classicPath, JSON.stringify(classicBrushes, null, 2), 'utf8');
    return classicBrushes.length;
}

function writeCategories() {
    const out = FILE_MAPPING.map(({ key, displayName, classic }) => ({
        key,
        displayName,
        file: `brushes/${classic}`,
    }));
    fs.writeFileSync(
        path.join(__dirname, 'brushCategories.json'),
        JSON.stringify(out, null, 2) + '\n',
        'utf8'
    );
}

function main() {
    if (!fs.existsSync(CLASSIC_DIR)) fs.mkdirSync(CLASSIC_DIR, { recursive: true });

    console.log('🔄 Porting Swift brushes -> Classic ...\n');
    let total = 0;
    for (const { swift, classic } of FILE_MAPPING) {
        const n = portFile(swift, classic);
        if (n) console.log(`  ✅ ${classic.padEnd(20)} ${n} brushes`);
        total += n;
    }
    writeCategories();
    console.log(`\n✨ ${total} brushes written to ${CLASSIC_DIR}`);
    console.log(`   brushCategories.json updated (${FILE_MAPPING.length} categories)`);
}

main();
