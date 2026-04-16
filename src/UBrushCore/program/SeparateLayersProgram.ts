import { UBrushContext } from "../gpu/UBrushContext";
import { RenderTarget } from "../gpu/RenderTarget";
import { Rect } from "../common/Rect";
import { Point } from "../common/Point";
import { Texture } from "../gpu/Texture";
import { Program } from "../gpu/Program";
import { RenderObject, RenderObjectBlend, RenderObjectDrawModes } from "../gpu/RenderObject";

export class SeparateLayersProgram {

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
 
    uniform sampler2D  u_texture;
    uniform int        u_targetChannel; //0:alpha 1:color
    void main()
    {
        if (u_targetChannel == 0)
        {
            //0:alpha
            gl_FragColor = vec4(vec3(texture2D(u_texture, v_textureCoordinate).a), 1.0);
        }
        else
        {
            //1:color
            gl_FragColor = vec4(texture2D(u_texture, v_textureCoordinate).rgb, 1.0);
        }
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
    
    public separate(
        alpharenderTarget: RenderTarget,
        colorrenderTarget: RenderTarget,
        param: {
            targetRect: Rect,
            source: Texture,
            sourceRect: Rect,
            canvasRect: Rect
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

        this.renderObject.clear();

        this.renderObject.attributes.push({name: "a_position", data: new Float32Array(imageVertices), size: 2});
        this.renderObject.attributes.push({name: "a_textureCoordinate", data: new Float32Array(textureCoordinates), size: 2});

        this.renderObject.uniforms.push({name: "u_orthoMatrix", value: orthoMatrix});
        this.renderObject.uniforms.push({name: "u_texture", value: param.source});

        this.renderObject.blend = RenderObjectBlend.None;

        const targetChannel = {name: "u_targetChannel", value: 0};
        this.renderObject.uniforms.push(targetChannel);
        
        //alpha

        this.context.activateRenderTarget(alpharenderTarget);

        this.renderObject.drawMode = RenderObjectDrawModes.TriangleStrip;
        this.renderObject.numberOfPoints = 4;

        this.context.render(this.renderObject, this.program);

        //color

        targetChannel.value = 1;

        this.context.activateRenderTarget(colorrenderTarget);

        this.renderObject.drawMode = RenderObjectDrawModes.TriangleStrip;
        this.renderObject.numberOfPoints = 4;

        this.context.render(this.renderObject, this.program);

        //
        
        this.context.activateRenderTarget();

    }

}