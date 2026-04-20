import { UBrushContext } from "../gpu/UBrushContext";
import { RenderTarget } from "../gpu/RenderTarget";
import { Rect } from "../common/Rect";
import { Point } from "../common/Point";
import { Texture } from "../gpu/Texture";
import { Program } from "../gpu/Program";
import { RenderObject, RenderObjectBlend, RenderObjectDrawModes } from "../gpu/RenderObject";
import { AffineTransform } from "../common/AffineTransform";
import { Color } from "../common/Color";
import { Common } from "../common/Common";
import { LayerBlendmode, EdgeStyle } from "../common/IBrush";

export class HighLowCutProgram {

    private vertexShaderSource: string = `
    attribute vec4 a_position;
    attribute vec2 a_textureCoordinate;
    varying   vec2 v_textureCoordinate;
    
    uniform   mat4 u_orthoMatrix;
    
    void main()
    {
        gl_Position = u_orthoMatrix * a_position;
        v_textureCoordinate = a_textureCoordinate.xy;
    }`;

    private fragmentShaderSource: string = `
    varying highp vec2 v_textureCoordinate;

    uniform sampler2D  u_wetedgeTexture;
    uniform sampler2D  u_dryTexture;
    uniform sampler2D  u_liquidTexture;

    uniform lowp vec4  u_liquidColor;
    uniform lowp float u_opacity;
    uniform lowp float u_lowCut;
    uniform lowp float u_highCut;

    uniform int u_liquidTinting;
    uniform int u_hasEdge;
    uniform int u_blendmode;

    highp float blendLum(highp vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    highp float blendSat(highp vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
    highp vec3 blendClipColor(highp vec3 c) {
        highp float l = blendLum(c);
        highp float n = min(min(c.r, c.g), c.b);
        highp float x = max(max(c.r, c.g), c.b);
        if (n < 0.0) { c = l + (c - l) * l / (l - n); }
        if (x > 1.0) { c = l + (c - l) * (1.0 - l) / (x - l); }
        return c;
    }
    highp vec3 blendSetLum(highp vec3 c, highp float l) { return blendClipColor(c + (l - blendLum(c))); }
    highp vec3 blendSetSat(highp vec3 c, highp float s) {
        highp float lo = min(min(c.r, c.g), c.b);
        highp float hi = max(max(c.r, c.g), c.b);
        if (hi > lo) { return (c - lo) * s / (hi - lo); }
        return vec3(0.0);
    }

    void main()
    {
        highp vec4 dryColor     = texture2D(u_dryTexture,    v_textureCoordinate);
        highp vec4 liquidColor  = texture2D(u_liquidTexture, v_textureCoordinate);

        if (u_lowCut == 0.0 && u_highCut == 1.0 && u_hasEdge == 0)
        {
            liquidColor = liquidColor * u_opacity;
        }
        else
        {
            lowp float newAlpha = clamp((liquidColor.a - u_lowCut) / (u_highCut - u_lowCut), 0.0, 1.0) * u_opacity;

            if (u_hasEdge == 1)
            {
                newAlpha = texture2D(u_wetedgeTexture, vec2(((newAlpha * 255.0) + 0.5) / 256.0, 0.5)).r;
            }

            liquidColor = clamp(vec4(vec3((liquidColor.rgb / liquidColor.a) * newAlpha), newAlpha), vec4(0.0), vec4(1.0));
        }

        if (u_liquidTinting == 1)
        {
            liquidColor = u_liquidColor * liquidColor.a;
        }

        if (u_blendmode == 26)
        {
            gl_FragColor = dryColor * (1.0 - liquidColor.a);
        }
        else
        {
            highp vec3 cb = (dryColor.a > 0.0) ? dryColor.rgb / dryColor.a : vec3(0.0);
            highp vec3 cs = (liquidColor.a > 0.0) ? liquidColor.rgb / liquidColor.a : vec3(0.0);
            highp vec3 blended;
            highp vec3 sl_d = vec3(0.0);

            if (u_blendmode == 1) {
                blended = min(cb, cs);
            } else if (u_blendmode == 2) {
                blended = cb * cs;
            } else if (u_blendmode == 3) {
                blended = clamp(1.0 - (1.0 - cb) / max(cs, vec3(0.0001)), vec3(0.0), vec3(1.0));
            } else if (u_blendmode == 4) {
                blended = clamp(cb + cs - 1.0, vec3(0.0), vec3(1.0));
            } else if (u_blendmode == 5) {
                blended = (blendLum(cb) <= blendLum(cs)) ? cb : cs;
            } else if (u_blendmode == 6) {
                blended = max(cb, cs);
            } else if (u_blendmode == 7) {
                blended = cb + cs - cb * cs;
            } else if (u_blendmode == 8) {
                blended = clamp(cb / max(1.0 - cs, vec3(0.0001)), vec3(0.0), vec3(1.0));
            } else if (u_blendmode == 9) {
                blended = clamp(cb + cs, vec3(0.0), vec3(1.0));
            } else if (u_blendmode == 10) {
                blended = (blendLum(cb) >= blendLum(cs)) ? cb : cs;
            } else if (u_blendmode == 11) {
                blended = mix(2.0*cb*cs, 1.0 - 2.0*(1.0-cb)*(1.0-cs), step(0.5, cb));
            } else if (u_blendmode == 12) {
                sl_d = mix(((16.0*cb - 12.0)*cb + 4.0)*cb, sqrt(max(cb, vec3(0.0))), step(0.25, cb));
                blended = mix(cb - (1.0 - 2.0*cs)*cb*(1.0 - cb), cb + (2.0*cs - 1.0)*(sl_d - cb), step(0.5, cs));
            } else if (u_blendmode == 13) {
                blended = mix(2.0*cb*cs, 1.0 - 2.0*(1.0-cb)*(1.0-cs), step(0.5, cs));
            } else if (u_blendmode == 14) {
                blended = mix(
                    clamp(1.0 - (1.0-cb) / max(2.0*cs, vec3(0.0001)), vec3(0.0), vec3(1.0)),
                    clamp(cb / max(2.0*(1.0-cs), vec3(0.0001)), vec3(0.0), vec3(1.0)),
                    step(0.5, cs));
            } else if (u_blendmode == 15) {
                blended = clamp(cb + 2.0*cs - 1.0, vec3(0.0), vec3(1.0));
            } else if (u_blendmode == 16) {
                blended = mix(min(cb, 2.0*cs), max(cb, 2.0*cs - 1.0), step(0.5, cs));
            } else if (u_blendmode == 17) {
                blended = step(1.0, cb + cs);
            } else if (u_blendmode == 18) {
                blended = abs(cb - cs);
            } else if (u_blendmode == 19) {
                blended = cb + cs - 2.0*cb*cs;
            } else if (u_blendmode == 20) {
                blended = clamp(cb - cs, vec3(0.0), vec3(1.0));
            } else if (u_blendmode == 21) {
                blended = clamp(cb / max(cs, vec3(0.0001)), vec3(0.0), vec3(1.0));
            } else if (u_blendmode == 22) {
                blended = blendSetLum(blendSetSat(cs, blendSat(cb)), blendLum(cb));
            } else if (u_blendmode == 23) {
                blended = blendSetLum(blendSetSat(cb, blendSat(cs)), blendLum(cb));
            } else if (u_blendmode == 24) {
                blended = blendSetLum(cs, blendLum(cb));
            } else if (u_blendmode == 25) {
                blended = blendSetLum(cb, blendLum(cs));
            } else {
                blended = cs;
            }

            highp float resultAlpha = liquidColor.a + dryColor.a * (1.0 - liquidColor.a);
            gl_FragColor = vec4(
                liquidColor.rgb * (1.0 - dryColor.a) + dryColor.rgb * (1.0 - liquidColor.a) + dryColor.a * liquidColor.a * blended,
                resultAlpha
            );
        }
    }`;
    
    private edgeTextures: Map<string, Texture> = new Map();

    private program: Program;

    private context: UBrushContext;

    private renderObject: RenderObject;

    constructor(context: UBrushContext) {

        this.context = context;

        this.program = context.createProgram(this.vertexShaderSource, this.fragmentShaderSource);

        this.renderObject = new RenderObject();

        for (const style of ['WET', 'BURN', 'HARD', 'SOFT']) {
            const lut = Common.edgeLUT(style);
            if (lut) {
                const tex = context.createTexture();
                tex.loadFromRGBA(lut, 256, 1);
                this.edgeTextures.set(style, tex);
            }
        }

    }

    private getEdgeTexture(style: EdgeStyle | string): Texture | null {
        return this.edgeTextures.get(style as string) ?? null;
    }
    
    public distroy(): void {

        this.context.removeObject(this.renderObject);

    }
    
    public fill(renderTarget: RenderTarget | null,
        param: {
            targetRect: Rect,
            drySource: Texture,
            liquidSource: Texture,
            sourceRect: Rect,
            transform: AffineTransform,
            liquidSourceBlendmode: LayerBlendmode | string,
            canvasRect: Rect,
            opacity: number,
            lowCut: number,
            highCut: number,
            liquidColor: Color,
            liquidTinting: boolean,
            edgeStyle: EdgeStyle | string
        }): void {
        
        const imageVertices = new Array<number>(8);
        
        const x1 = param.targetRect.minX;
        const x2 = param.targetRect.maxX;
        const y1 = param.targetRect.minY;
        const y2 = param.targetRect.maxY;

        let p1 = new Point(x1, y1);
        let p2 = new Point(x2, y1);
        let p3 = new Point(x1, y2);
        let p4 = new Point(x2, y2);
        
        if (!param.transform.isIdentity()) {

            const t = param.transform;
            p1 = t.applyToPoint(p1);
            p2 = t.applyToPoint(p2);
            p3 = t.applyToPoint(p3);
            p4 = t.applyToPoint(p4);

        }

        imageVertices[0] = p1.x;
        imageVertices[1] = p1.y;
        imageVertices[2] = p2.x;
        imageVertices[3] = p2.y;
        imageVertices[4] = p3.x;
        imageVertices[5] = p3.y;
        imageVertices[6] = p4.x;
        imageVertices[7] = p4.y;
        
        const textureCoordinates = new Array<number>(8);
        
        let sx1 = param.sourceRect.origin.x;
        let sx2 = param.sourceRect.origin.x + param.sourceRect.size.width;
        let sy1 = param.sourceRect.origin.y;
        let sy2 = param.sourceRect.origin.y + param.sourceRect.size.height;
        
        sx1 = (sx1 - param.canvasRect.origin.x) / param.canvasRect.size.width;
        sx2 = (sx2 - param.canvasRect.origin.x) / param.canvasRect.size.width;
        sy1 = (sy1 - param.canvasRect.origin.y) / param.canvasRect.size.height;
        sy2 = (sy2 - param.canvasRect.origin.y) / param.canvasRect.size.height;

        textureCoordinates[0] = sx1;
        textureCoordinates[1] = sy1;
        textureCoordinates[2] = sx2;
        textureCoordinates[3] = sy1;
        textureCoordinates[4] = sx1;
        textureCoordinates[5] = sy2;
        textureCoordinates[6] = sx2;
        textureCoordinates[7] = sy2;
        
        const left = param.canvasRect.minX;
        const right = param.canvasRect.maxX;
        const bottom = param.canvasRect.minY;
        const top = param.canvasRect.maxY;
        const farZ = 1.0;
        const nearZ = -1.0;
    
        const ral = right + left;
        const rsl = right - left;
        const tab = top + bottom;
        const tsb = top - bottom;
        const fan = farZ + nearZ;
        const fsn = farZ - nearZ;
        
        const orthoMatrix = [ 2.0 / rsl, 0.0, 0.0, 0.0,  0.0, 2.0 / tsb, 0.0, 0.0,  0.0, 0.0, -2.0 / fsn, 0.0,  -ral / rsl, -tab / tsb, -fan / fsn, 1.0];

        if (renderTarget) {

            this.context.activateRenderTarget(renderTarget);
            
        } else {
            
            this.context.activateRenderTarget();

        }

        this.renderObject.clear();

        this.renderObject.attributes.push({name: "a_position", data: new Float32Array(imageVertices), size: 2});
        this.renderObject.attributes.push({name: "a_textureCoordinate", data: new Float32Array(textureCoordinates), size: 2});

        const edgeTex = this.getEdgeTexture(param.edgeStyle);
        this.renderObject.uniforms.push({name: "u_wetedgeTexture", value: edgeTex ?? this.edgeTextures.get('WET')!});
        this.renderObject.uniforms.push({name: "u_dryTexture", value: param.drySource});
        this.renderObject.uniforms.push({name: "u_liquidTexture", value: param.liquidSource});
        this.renderObject.uniforms.push({name: "u_liquidColor", value: param.liquidColor});

        this.renderObject.uniforms.push({name: "u_orthoMatrix", value: orthoMatrix});
        this.renderObject.uniforms.push({name: "u_opacity", value: param.opacity});
        this.renderObject.uniforms.push({name: "u_lowCut", value: param.lowCut});
        this.renderObject.uniforms.push({name: "u_highCut", value: param.highCut});
        this.renderObject.uniforms.push({name: "u_liquidTinting", value: param.liquidTinting ? 1 : 0});
        this.renderObject.uniforms.push({name: "u_hasEdge", value: edgeTex ? 1 : 0});
        
        const bm = param.liquidSourceBlendmode;
        const blendModeMap: {[key: string]: number} = {
            [LayerBlendmode.NORMAL]: 0,
            [LayerBlendmode.DARKEN]: 1,
            [LayerBlendmode.MULTIPLY]: 2,
            [LayerBlendmode.COLOR_BURN]: 3,
            [LayerBlendmode.LINEAR_BURN]: 4,
            [LayerBlendmode.DARKER_COLOR]: 5,
            [LayerBlendmode.LIGHTEN]: 6,
            [LayerBlendmode.SCREEN]: 7,
            [LayerBlendmode.COLOR_DODGE]: 8,
            [LayerBlendmode.LINEAR_DODGE]: 9,
            [LayerBlendmode.LIGHTER_COLOR]: 10,
            [LayerBlendmode.OVERLAY]: 11,
            [LayerBlendmode.SOFT_LIGHT]: 12,
            [LayerBlendmode.HARD_LIGHT]: 13,
            [LayerBlendmode.VIVID_LIGHT]: 14,
            [LayerBlendmode.LINEAR_LIGHT]: 15,
            [LayerBlendmode.PIN_LIGHT]: 16,
            [LayerBlendmode.HARD_MIX]: 17,
            [LayerBlendmode.DIFFERENCE]: 18,
            [LayerBlendmode.EXCLUSION]: 19,
            [LayerBlendmode.SUBTRACT]: 20,
            [LayerBlendmode.DIVIDE]: 21,
            [LayerBlendmode.HUE]: 22,
            [LayerBlendmode.SATURATION]: 23,
            [LayerBlendmode.COLOR]: 24,
            [LayerBlendmode.LUMINOSITY]: 25,
            [LayerBlendmode.ERASE]: 26,
        };
        const blendModeCode: number = blendModeMap[bm as string] ?? 0;
        this.renderObject.uniforms.push({name: "u_blendmode", value: blendModeCode});

        this.renderObject.blend = RenderObjectBlend.None;
        this.renderObject.drawMode = RenderObjectDrawModes.TriangleStrip;
        this.renderObject.numberOfPoints = 4;

        this.context.render(this.renderObject, this.program);

        if (renderTarget) {

            this.context.activateRenderTarget();

        }

    }

}