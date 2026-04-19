import { UBrushContext } from "../gpu/UBrushContext";
import { Program } from "../gpu/Program";
import { RenderObject, RenderObjectBlend } from "../gpu/RenderObject";
import { RenderTarget } from "../gpu/RenderTarget";
import { Texture } from "../gpu/Texture";

export class DrawDotProgram {

    private vertexShaderSource: string = `
        attribute vec4 a_tipPosition;

        attribute vec4 a_tintColor;
        attribute vec2 a_tipTextureCoordinate;
        attribute vec2 a_patternTextureCoordinate;
        attribute vec2 a_smudging0TexturePosition;
        attribute vec2 a_smudgingTexturePosition;
        attribute vec4 a_opacity;
        
        varying vec4 v_tintColor;
        varying vec2 v_tipTextureCoordinate;
        varying vec2 v_patternTextureCoordinate;
        varying vec2 v_smudging0TexturePosition;
        varying vec2 v_smudgingTexturePosition;
        varying vec4 v_opacity;
        
        void main()
        {
            gl_Position = a_tipPosition;
            v_tipTextureCoordinate = a_tipTextureCoordinate.xy;//TODO:xy 삭제
            v_patternTextureCoordinate = a_patternTextureCoordinate.xy;
            v_smudging0TexturePosition = a_smudging0TexturePosition.xy;
            v_smudgingTexturePosition = a_smudgingTexturePosition.xy;
            v_tintColor = a_tintColor;
            v_opacity = a_opacity;
        }`;

    private fragmentShaderSource: string = `
        varying lowp  vec4 v_tintColor;
        varying highp vec2 v_tipTextureCoordinate;
        varying highp vec2 v_patternTextureCoordinate;
        varying highp vec2 v_smudging0TexturePosition;
        varying highp vec2 v_smudgingTexturePosition;
        varying lowp  vec4 v_opacity; //0:opacity 1:pattern opacity 2:mixing opacity 3:smudging progress
        
        uniform sampler2D u_tipTexture;
        uniform sampler2D u_patternTexture;
        uniform sampler2D u_smudging0RefTexture;
        uniform sampler2D u_smudgingRefTexture;
        
        void main()
        {
            lowp float s_patternMaskAlpha = 1.0 - texture2D(u_patternTexture, v_patternTextureCoordinate).a * v_opacity[1];
            
            lowp vec4 s_tipColor = texture2D(u_tipTexture, v_tipTextureCoordinate);
            
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
            points: number[],
            indexData: number[],
            tipTextureCoordinates: number[],
            patternTextureCoordinates: number[],
            smudging0TexturePositions: number[],
            smudgingTexturePositions: number[],
            colors: number[],
            opacities: number[],
            numberOfPoints: number,
            useDualTip: boolean,
            blend: RenderObjectBlend

        }): void {
        
        this.context.activateRenderTarget(renderTarget);

        this.renderObject.clear();

        this.renderObject.attributes.push({name: "a_tipPosition", data: new Float32Array(param.points), size: 2});
        this.renderObject.attributes.push({name: "a_tintColor", data: new Float32Array(param.colors), size: 4});
        this.renderObject.attributes.push({name: "a_tipTextureCoordinate", data: new Float32Array(param.tipTextureCoordinates), size: 2});
        this.renderObject.attributes.push({name: "a_patternTextureCoordinate", data: new Float32Array(param.patternTextureCoordinates), size: 2});
        this.renderObject.attributes.push({name: "a_smudging0TexturePosition", data: new Float32Array(param.smudging0TexturePositions), size: 2});
        this.renderObject.attributes.push({name: "a_smudgingTexturePosition", data: new Float32Array(param.smudgingTexturePositions), size: 2});
        this.renderObject.attributes.push({name: "a_opacity", data: new Float32Array(param.opacities), size: 4});
        
        if (param.useDualTip) {

            this.renderObject.uniforms.push({name: "u_tipTexture", value: param.dualTipTexture});
            
        } else {

            this.renderObject.uniforms.push({name: "u_tipTexture", value: param.tipTexture});

        }

        this.renderObject.uniforms.push({name: "u_patternTexture", value: param.patternTexture});
        this.renderObject.uniforms.push({name: "u_smudging0RefTexture", value: param.smudging0Texture});
        this.renderObject.uniforms.push({name: "u_smudgingRefTexture", value: param.smudgingTexture});
        
        this.renderObject.blend = param.blend;
        this.renderObject.indexData = new Uint16Array(param.indexData);
        this.renderObject.numberOfPoints = param.numberOfPoints;

        this.context.render(this.renderObject, this.program);

        this.context.activateRenderTarget();

    }

}