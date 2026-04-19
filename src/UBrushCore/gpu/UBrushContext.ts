import { Size } from "../common/Size";
import { RenderTarget } from "./RenderTarget";
import { Texture } from "./Texture";
import { Program } from "./Program";
import { Properties } from "./Properties";
import { Textures } from "./Textures";
import { RenderObject, Attribute, Uniform, RenderObjectBlend, RenderObjectDrawModes } from "./RenderObject";
import { Color } from "../common/Color";
import { Rect } from "../common/Rect";

export class UBrushContext {

    // private isContextLost: boolean = false;

    private properties: Properties;
    private textures: Textures;
    private size: Size;

    public readonly gl: WebGLRenderingContext;

    constructor(gl: WebGLRenderingContext, size: Size) {

        this.gl = gl;
        this.size = size;
        this.properties = new Properties();
        this.textures = new Textures(this.gl);
        
    }

    private initGLContext(): void {

    }

    public createTexture(): Texture {

        return new Texture(this.gl);

    }

    public deleteTexture(texture: Texture): void {

        texture.destroy();

    }

    public createRenderTarget(size: Size): RenderTarget {

        return new RenderTarget(this.gl, size);

    }

    public deleteRenderTarget(renderTarget: RenderTarget): void {

        renderTarget.distroy();

    }

    public activateRenderTarget(target?: RenderTarget): void {

        if (target) {

            this.gl.viewport(0, 0, target.size.width, target.size.height);
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.fbo);

        } else {

            this.gl.viewport(0, 0, this.size.width, this.size.height);
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

        }

    }

    public createProgram(vertexShader: string, fragmentShader: string): Program {

        return new Program(this.gl, vertexShader, fragmentShader);

    }

    public removeObject(renderObject: RenderObject): void {

        this.properties.remove(renderObject);

    }

    public render(renderObject: RenderObject, program: Program): void {

        const gl = this.gl;

        this.textures.resetTextureUnits();
        
        gl.useProgram(program.get());

        const buffers = this.properties.get(renderObject);

        for (let i = 0; i < renderObject.attributes.length; i++) {

            const attribute: Attribute = renderObject.attributes[i];

            if (!buffers[attribute.name]) buffers[attribute.name] = gl.createBuffer();

            gl.bindBuffer(gl.ARRAY_BUFFER, buffers[attribute.name]);
            gl.bufferData(gl.ARRAY_BUFFER, attribute.data, gl.DYNAMIC_DRAW);

            gl.enableVertexAttribArray(program.attributes[attribute.name]);
            gl.vertexAttribPointer(program.attributes[attribute.name], attribute.size, gl.FLOAT, false, 0, 0);

        }

        for (let i = 0; i < renderObject.uniforms.length; i++) {

            const uniform: Uniform = renderObject.uniforms[i];
            program.uniforms.setValue(uniform.name, uniform.value, this.textures);

        }

        if (renderObject.blend === RenderObjectBlend.None) {

            gl.disable(gl.BLEND);

        } else if (renderObject.blend === RenderObjectBlend.Add) {

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);

        } else if (renderObject.blend === RenderObjectBlend.Screen) {

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);

        } else if (renderObject.blend === RenderObjectBlend.Max) {

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            const ext = gl.getExtension('EXT_blend_minmax');
            if (ext) {
                gl.blendEquation(ext.MAX_EXT);
            }

        } else {

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        }

        let mode: number = gl.TRIANGLES;

        if (renderObject.drawMode === RenderObjectDrawModes.TriangleStrip) 

            mode = gl.TRIANGLE_STRIP;

        else if (renderObject.drawMode === RenderObjectDrawModes.TriangleFan) 
        
            mode = gl.TRIANGLE_FAN;

        if (renderObject.indexData) {

            if (!buffers["index"]) buffers["index"] = gl.createBuffer();

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers["index"]);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, renderObject.indexData, gl.STATIC_DRAW);
            gl.drawElements(gl.TRIANGLES, renderObject.numberOfPoints, gl.UNSIGNED_SHORT, 0);
            
        } else {

            gl.drawArrays(mode, 0, renderObject.numberOfPoints);

        }


        if (renderObject.blend === RenderObjectBlend.Max) {
            gl.blendEquation(gl.FUNC_ADD);
        }

        gl.disable(gl.BLEND);

        for (let i = 0; i < renderObject.attributes.length; i++) {

            const attribute: Attribute = renderObject.attributes[i];
            this.gl.disableVertexAttribArray(program.attributes[attribute.name]);

        }

    };

    clearRenderTarget(target: RenderTarget | null, color: Color): void {
        
        if (target) {

            this.activateRenderTarget(target);
            
        } else {
            
            this.activateRenderTarget();

        }

        this.gl.clearColor(color.r, color.g, color.b, color.a);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        if (target) {

            this.activateRenderTarget();

        }

    }
    
    public readPixelsByDataURL(renderTarget: RenderTarget, pixelBounds: Rect): string {

        // const array = this.readPixels(renderTarget, pixelBounds);

        // const w = pixelBounds.size.width;
        // const h = pixelBounds.size.height;
        // const canvas = document.createElement("canvas");
        // canvas.width = w;
        // canvas.height = h;
        // const ctx = canvas.getContext("2d");

        // if (ctx) {

        //     const imagedata = new ImageData(new Uint8ClampedArray(array), w, h);
        //     ctx.putImageData(imagedata, 0, 0);

        // }

        // return canvas.toDataURL();

        return "";

    }
    
    public readPixels(renderTarget: RenderTarget, pixelBounds: Rect): Uint8Array {

        this.activateRenderTarget(renderTarget);

        const data = new Uint8Array(pixelBounds.size.width * pixelBounds.size.height * 4);
        this.gl.readPixels(pixelBounds.origin.x, pixelBounds.origin.y, pixelBounds.size.width, pixelBounds.size.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, data);
    
        this.activateRenderTarget();
    
        return data;      

    }

    public pixelBound(renderTarget: RenderTarget): Rect {

        const canvasRect = new Rect(0, 0, renderTarget.size.width, renderTarget.size.height);
        const pixels = this.readPixels(renderTarget, canvasRect);
        const l = pixels.length;
        let x = 0;
        let y = 0;

        const bound = {
            top: renderTarget.size.height,
            left: renderTarget.size.width,
            right: 0,
            bottom: 0
        };

        for (let i = 0; i < l; i += 4) {

            if (pixels[i + 3] !== 0) {

                x = (i / 4) % canvasRect.size.width;
                y = ~~((i / 4) / canvasRect.size.width);
    
                if (y < bound.top) {
                    bound.top = y;
                }
    
                if (x < bound.left) {
                    bound.left = x;
                }
    
                if (bound.right < x) {
                    bound.right = x;
                }
    
                if (bound.bottom < y) {
                    bound.bottom = y;
                }

            }

        }

        return new Rect(bound.left, bound.top, bound.right - bound.left, bound.bottom - bound.top);
        
    }

    // test

    public copyTexture(target: RenderTarget, source: RenderTarget): void {

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.fbo);
        this.gl.bindTexture(this.gl.TEXTURE_2D, source.texture.get());
        this.gl.copyTexImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, 0, 0, 512, 512, 0);
        
    }

    // events

    private onContextLost(event: Event) {

        event.preventDefault();
        console.log("THREE.WebGLRenderer: Context Lost.");
        // this.isContextLost = true;

    }

    private onContextRestore( /* event: Event */) {

        console.log("THREE.WebGLRenderer: Context Restored.");
        // this.isContextLost = false;
        this.initGLContext();

    }

}