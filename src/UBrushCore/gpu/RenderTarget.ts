import { Size } from "../common/Size";
import { Texture } from "./Texture";

export class RenderTarget {
    
    public readonly fbo: WebGLFramebuffer;
    public readonly texture: Texture;
    public readonly size: Size;
    
    private gl: WebGLRenderingContext;

    constructor(gl: WebGLRenderingContext, size: Size) {

        const width: number = size.width;
        const height: number = size.height;

        this.gl = gl;

        const texture = new Texture(gl);

        gl.bindTexture(gl.TEXTURE_2D, texture.get());
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        const framebuffer: WebGLFramebuffer | null = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.get(), 0);
        
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
        this.texture = texture;
        this.fbo = framebuffer!;
        this.size = size;

    }

    public distroy(): void {

        const gl = this.gl;

        gl.deleteFramebuffer(this.fbo);
        this.texture.destroy();
        
    }

}