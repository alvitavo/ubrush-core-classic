import { UBrushContext } from "../gpu/UBrushContext";
import { Program } from "../gpu/Program";
import { RenderObject, RenderObjectBlend, RenderObjectDrawModes } from "../gpu/RenderObject";
import { RenderTarget } from "../gpu/RenderTarget";
import { Texture } from "../gpu/Texture";

const QUAD_CORNERS = new Float32Array([
    -1.0, -1.0,
     1.0, -1.0,
    -1.0,  1.0,
     1.0,  1.0,
]);

export class DrawDotProgram {

    private vertexShaderSource: string = `
        attribute vec2 a_corner;

        attribute vec4 a_posCenterAxisU;
        attribute vec2 a_posAxisV;
        attribute vec4 a_tipUV;
        attribute vec4 a_patternUVa;
        attribute vec2 a_patternUVb;
        attribute vec4 a_smudging0UVa;
        attribute vec2 a_smudging0UVb;
        attribute vec4 a_smudgingUVa;
        attribute vec2 a_smudgingUVb;
        attribute vec4 a_tintColor;
        attribute vec4 a_opacity;
        attribute vec4 a_corrosion;

        varying vec4 v_tintColor;
        varying vec2 v_tipTextureCoordinate;
        varying vec2 v_patternTextureCoordinate;
        varying vec2 v_smudging0TexturePosition;
        varying vec2 v_smudgingTexturePosition;
        varying vec4 v_opacity;
        varying vec4 v_corrosion;

        void main()
        {
            vec2 clipCenter = a_posCenterAxisU.xy;
            vec2 axisU = a_posCenterAxisU.zw;
            vec2 axisV = a_posAxisV;
            vec2 clipPos = clipCenter + a_corner.x * axisU + a_corner.y * axisV;
            gl_Position = vec4(clipPos, 0.0, 1.0);

            vec2 bary = a_corner * 0.5 + 0.5;
            v_tipTextureCoordinate = a_tipUV.xy + bary * a_tipUV.zw;

            v_patternTextureCoordinate = a_patternUVa.xy + a_corner.x * a_patternUVa.zw + a_corner.y * a_patternUVb;
            v_smudging0TexturePosition = a_smudging0UVa.xy + a_corner.x * a_smudging0UVa.zw + a_corner.y * a_smudging0UVb;
            v_smudgingTexturePosition  = a_smudgingUVa.xy  + a_corner.x * a_smudgingUVa.zw  + a_corner.y * a_smudgingUVb;

            v_tintColor = a_tintColor;
            v_opacity = a_opacity;
            v_corrosion = a_corrosion;
        }`;

    private fragmentShaderSource: string = `
        varying lowp  vec4 v_tintColor;
        varying highp vec2 v_tipTextureCoordinate;
        varying highp vec2 v_patternTextureCoordinate;
        varying highp vec2 v_smudging0TexturePosition;
        varying highp vec2 v_smudgingTexturePosition;
        varying lowp  vec4 v_opacity; //0:opacity 1:pattern opacity 2:mixing opacity 3:smudging progress
        varying lowp  vec4 v_corrosion; //0:tipCorrosion 1:textureCorrosion 2:tipCorrosionSize 3:textureCorrosionSize

        uniform sampler2D u_tipTexture;
        uniform sampler2D u_patternTexture;
        uniform sampler2D u_smudging0RefTexture;
        uniform sampler2D u_smudgingRefTexture;

        lowp float corrosionFn(lowp float v, lowp float c, lowp float size) {
            lowp float s = max(0.001, size);
            return clamp((v - 1.0 + min(1.0, s + c)) / s, 0.0, 1.0);
        }

        lowp float textureCorrosionFn(lowp float v, lowp float c, lowp float size) {
            lowp float s = max(0.001, size);
            return 1.0 - clamp((min(1.0, s + c) - v) / s, 0.0, 1.0);
        }

        void main()
        {
            lowp float s_rawPatternAlpha = texture2D(u_patternTexture, v_patternTextureCoordinate).a;
            s_rawPatternAlpha = textureCorrosionFn(s_rawPatternAlpha, v_corrosion[1], v_corrosion[3]);
            lowp float s_patternMaskAlpha = 1.0 - s_rawPatternAlpha * v_opacity[1];

            lowp vec4 s_tipColor = texture2D(u_tipTexture, v_tipTextureCoordinate);
            s_tipColor.a = corrosionFn(s_tipColor.a, v_corrosion[0], v_corrosion[2]);

            s_tipColor.rgb *= s_tipColor.a;

            s_tipColor.rgb = s_tipColor.rgb * (1.0 - v_tintColor.a) + v_tintColor.rgb * s_tipColor.a * v_tintColor.a;

            lowp vec4 s_smudging0Color = texture2D(u_smudging0RefTexture, v_smudging0TexturePosition) * (1.0 - v_opacity[3]);
            lowp vec4 s_smudgingColor = texture2D(u_smudgingRefTexture, v_smudgingTexturePosition) * v_opacity[3];

            s_tipColor = (s_tipColor * v_opacity[0]) + ((s_smudging0Color + s_smudgingColor) * s_tipColor.a * v_opacity[2] * (1.0 - v_opacity[0]));

            s_tipColor *= s_patternMaskAlpha;

            gl_FragColor = s_tipColor;

        }`;

    private program: Program;

    private context: UBrushContext;

    private renderObject: RenderObject;

    constructor(context: UBrushContext) {

        this.context = context;

        this.program = context.createProgram(this.vertexShaderSource, this.fragmentShaderSource);

        this.renderObject = new RenderObject();

    }

    public distroy(): void {

        this.context.removeObject(this.renderObject);

    }

    public drawRects(renderTarget: RenderTarget,
        param: {

            tipTexture: Texture,
            patternTexture: Texture,
            smudging0Texture: Texture,
            smudgingTexture: Texture,
            dualTipTexture: Texture,
            posCenterAxisU: Float32Array,
            posAxisV: Float32Array,
            tipUV: Float32Array,
            patternUVa: Float32Array,
            patternUVb: Float32Array,
            smudging0UVa: Float32Array,
            smudging0UVb: Float32Array,
            smudgingUVa: Float32Array,
            smudgingUVb: Float32Array,
            tintColor: Float32Array,
            opacity: Float32Array,
            corrosion: Float32Array,
            instanceCount: number,
            useDualTip: boolean,
            blend: RenderObjectBlend

        }): void {

        this.context.activateRenderTarget(renderTarget);

        this.renderObject.clear();

        this.renderObject.attributes.push({name: "a_corner",          data: QUAD_CORNERS,         size: 2});
        this.renderObject.attributes.push({name: "a_posCenterAxisU",  data: param.posCenterAxisU, size: 4, divisor: 1});
        this.renderObject.attributes.push({name: "a_posAxisV",        data: param.posAxisV,       size: 2, divisor: 1});
        this.renderObject.attributes.push({name: "a_tipUV",           data: param.tipUV,          size: 4, divisor: 1});
        this.renderObject.attributes.push({name: "a_patternUVa",      data: param.patternUVa,     size: 4, divisor: 1});
        this.renderObject.attributes.push({name: "a_patternUVb",      data: param.patternUVb,     size: 2, divisor: 1});
        this.renderObject.attributes.push({name: "a_smudging0UVa",    data: param.smudging0UVa,   size: 4, divisor: 1});
        this.renderObject.attributes.push({name: "a_smudging0UVb",    data: param.smudging0UVb,   size: 2, divisor: 1});
        this.renderObject.attributes.push({name: "a_smudgingUVa",     data: param.smudgingUVa,    size: 4, divisor: 1});
        this.renderObject.attributes.push({name: "a_smudgingUVb",     data: param.smudgingUVb,    size: 2, divisor: 1});
        this.renderObject.attributes.push({name: "a_tintColor",       data: param.tintColor,      size: 4, divisor: 1});
        this.renderObject.attributes.push({name: "a_opacity",         data: param.opacity,        size: 4, divisor: 1});
        this.renderObject.attributes.push({name: "a_corrosion",       data: param.corrosion,      size: 4, divisor: 1});

        if (param.useDualTip) {

            this.renderObject.uniforms.push({name: "u_tipTexture", value: param.dualTipTexture});

        } else {

            this.renderObject.uniforms.push({name: "u_tipTexture", value: param.tipTexture});

        }

        this.renderObject.uniforms.push({name: "u_patternTexture", value: param.patternTexture});
        this.renderObject.uniforms.push({name: "u_smudging0RefTexture", value: param.smudging0Texture});
        this.renderObject.uniforms.push({name: "u_smudgingRefTexture", value: param.smudgingTexture});

        this.renderObject.blend = param.blend;
        this.renderObject.drawMode = RenderObjectDrawModes.TriangleStrip;
        this.renderObject.numberOfPoints = 4;
        this.renderObject.instanceCount = param.instanceCount;

        this.context.render(this.renderObject, this.program);

        this.context.activateRenderTarget();

    }

}
