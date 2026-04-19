import { UBrushContext } from "../gpu/UBrushContext";
import { RenderTarget } from "../gpu/RenderTarget";
import { Rect } from "../common/Rect";
import { Point } from "../common/Point";
import { Texture } from "../gpu/Texture";
import { Program } from "../gpu/Program";
import { RenderObject, RenderObjectBlend, RenderObjectDrawModes } from "../gpu/RenderObject";
import { AffineTransform } from "../common/AffineTransform";
import { Common } from "../common/Common";
import { LayerBlendmode, EdgeStyle } from "../common/IBrush";

export class MaskAndCutProgram {

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

    uniform sampler2D  u_edgeTexture;
    uniform sampler2D  u_maskEdgeTexture;
    uniform sampler2D  u_dryTexture;
    uniform sampler2D  u_liquidTexture;
    uniform sampler2D  u_maskTexture;

    uniform lowp float u_opacity;
    uniform lowp float u_lowCut;
    uniform lowp float u_highCut;

    uniform int u_hasEdge;
    uniform int u_hasMaskEdge;
    uniform int u_blendmode;//0:normal 1:multiply 2:erase

    void main()
    {
        highp vec4 dryColor     = texture2D(u_dryTexture,    v_textureCoordinate);
        highp vec4 liquidColor  = texture2D(u_liquidTexture, v_textureCoordinate);
        highp float rawMask     = texture2D(u_maskTexture,   v_textureCoordinate).a;

        if (u_hasMaskEdge == 1)
        {
            rawMask = texture2D(u_maskEdgeTexture, vec2(((rawMask * 255.0) + 0.5) / 256.0, 0.5)).r;
        }

        highp float maskAlpha = rawMask * liquidColor.a;
        highp float newAlpha;

        if (u_lowCut == 0.0 && u_highCut == 1.0 && u_hasEdge == 0)
        {
            newAlpha = maskAlpha * u_opacity;
        }
        else
        {
            newAlpha = clamp((maskAlpha - u_lowCut) / (u_highCut - u_lowCut), 0.0, 1.0) * u_opacity;

            if (u_hasEdge == 1)
            {
                newAlpha = texture2D(u_edgeTexture, vec2(((newAlpha * 255.0) + 0.5) / 256.0, 0.5)).r;
            }
        }

        liquidColor = clamp(vec4(vec3((liquidColor.rgb / liquidColor.a) * newAlpha), newAlpha), vec4(0.0), vec4(1.0));

        if (u_blendmode == 0)
        {
            gl_FragColor = dryColor * (1.0 - liquidColor.a) + liquidColor;
        }
        else if (u_blendmode == 1)
        {
            gl_FragColor = (dryColor * liquidColor) + (dryColor * (1.0 - liquidColor.a)) + (liquidColor * (1.0 - dryColor.a));
        }
        else //if (u_blendmode == 2)
        {
            gl_FragColor = dryColor * (1.0 - liquidColor.a);
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
            maskSource: Texture,
            sourceRect: Rect,
            transform: AffineTransform,
            liquidSourceBlendmode: LayerBlendmode | string,
            canvasRect: Rect,
            opacity: number,
            lowCut: number,
            highCut: number,
            edgeStyle: EdgeStyle | string,
            maskEdgeStyle: EdgeStyle | string
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
        const maskEdgeTex = this.getEdgeTexture(param.maskEdgeStyle);
        const fallback = this.edgeTextures.get('WET')!;
        this.renderObject.uniforms.push({name: "u_edgeTexture", value: edgeTex ?? fallback});
        this.renderObject.uniforms.push({name: "u_maskEdgeTexture", value: maskEdgeTex ?? fallback});
        this.renderObject.uniforms.push({name: "u_dryTexture", value: param.drySource});
        this.renderObject.uniforms.push({name: "u_liquidTexture", value: param.liquidSource});
        this.renderObject.uniforms.push({name: "u_maskTexture", value: param.maskSource});

        this.renderObject.uniforms.push({name: "u_orthoMatrix", value: orthoMatrix});
        this.renderObject.uniforms.push({name: "u_opacity", value: param.opacity});
        this.renderObject.uniforms.push({name: "u_lowCut", value: param.lowCut});
        this.renderObject.uniforms.push({name: "u_highCut", value: param.highCut});
        this.renderObject.uniforms.push({name: "u_hasEdge", value: edgeTex ? 1 : 0});
        this.renderObject.uniforms.push({name: "u_hasMaskEdge", value: maskEdgeTex ? 1 : 0});
        
        const bm = param.liquidSourceBlendmode;
        const blendModeCode: number = (bm === LayerBlendmode.NORMAL) ? 0 : (bm === LayerBlendmode.MULTIPLY ? 1 : 2);
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