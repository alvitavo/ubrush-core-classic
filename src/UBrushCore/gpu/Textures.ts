import { Texture } from "./Texture";

export class Textures {

    private gl: WebGLRenderingContext;

    private textureUnits: number = 0;
    private maxTextures: number;

    constructor(gl: WebGLRenderingContext) {

        this.gl = gl;
        this.maxTextures = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);

    }

    public resetTextureUnits() {

        this.textureUnits = 0;

    }

    public allocateTextureUnit() {

        const textureUnit = this.textureUnits;

        if (textureUnit >= this.maxTextures) {

            console.warn('THREE.WebGLTextures: Trying to use ' + textureUnit + ' texture units while this GPU supports only ' + this.maxTextures);

        }

        this.textureUnits += 1;

        return textureUnit;

    }

    //

    public setTexture2D(texture: Texture, slot: number) {

        this.gl.activeTexture(this.gl.TEXTURE0 + slot);
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture.get());

    }

}