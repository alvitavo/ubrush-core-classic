import base64Arraybuffer from 'base64-arraybuffer';
import UPNG from 'upng-js';

export class Texture {

    private gl: WebGL2RenderingContext;
    private t: WebGLTexture;
    
    constructor(gl: WebGL2RenderingContext) {

        this.gl = gl;
        
        const texture = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255]));
        
        if (!texture) {

            throw(new Error("texture is null"));

        }

        this.t = texture;
        
    }

    public get(): WebGLTexture {

        return this.t;

    }

    public async loadFromBase64(imageURL: string): Promise<void> {

        return new Promise((resolve, reject) => {

            const gl = this.gl;

            // const image = new Image();
            // image.crossOrigin = "Anonymous";
            // image.src = imageURL;

            // image.onload = () => {

            //     gl.bindTexture(gl.TEXTURE_2D, this.t);

            //     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            //     gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

            //     if (!this.isPowerOfTwo(image.width) || !this.isPowerOfTwo(image.height)) {

            //         gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            //         gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                    
            //     }

            //     gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,gl.UNSIGNED_BYTE, image);
                
            //     resolve();

            // }

            const base64 = base64Arraybuffer.decode(imageURL.split(/data:image\/.+;base64,/)[1]);
            const img = UPNG.decode(base64);
            const texture = gl.createTexture();
    
            gl.bindTexture(gl.TEXTURE_2D, this.t);

            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

            if (!this.isPowerOfTwo(img.width) || !this.isPowerOfTwo(img.height)) {

                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                
            }

            const raw = new Uint8Array(UPNG.toRGBA8(img)[0]);
            const rowBytes = img.width * 4;
            const flipped = new Uint8Array(raw.length);
            for (let row = 0; row < img.height; row++) {
                flipped.set(raw.subarray(row * rowBytes, (row + 1) * rowBytes), (img.height - 1 - row) * rowBytes);
            }
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
            
            resolve();
                
        });
        
    }

    public loadFromRGBA(data: Uint8Array, width: number, height: number): void {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    public setEmpty(): void {

        const gl = this.gl;

        gl.bindTexture(gl.TEXTURE_2D, this.t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255]));
        
    }

    public destroy(): void {

        this.gl.deleteTexture(this.t);

    }

    private isPowerOfTwo(x: number): boolean {

        return (x !== 0) && ((x & (x - 1)) === 0);

    }

}