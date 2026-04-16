import { Uniforms } from "./Uniforms";


// export interface Attribute {

//     name: string,
//     type: string

// }

export class Program {

    private gl: WebGLRenderingContext;
    private program: WebGLProgram;

    public uniforms: Uniforms;
    public attributes: { [key: string]: number };

    constructor(gl: WebGLRenderingContext, vertexShaderSource: string, fragmentShaderSource: string) {

        this.gl = gl;

        const vertexShader: WebGLShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource)!;
        const fragmentShader: WebGLShader = this.createShader(gl.FRAGMENT_SHADER, fragmentShaderSource)!;

        this.program = this.createProgram(vertexShader, fragmentShader)!;

        this.uniforms = new Uniforms(gl, this.program);
        this.attributes = this.fetchAttributeLocations(this.program);

    }

    public get(): WebGLProgram {

        return this.program;

    }

    private createShader(type: GLint, source: string): WebGLShader | null {

        const gl = this.gl;

        const shader: WebGLShader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
        if (success) {
            return shader;
        }

        gl.deleteShader(shader);

        return null;

    }

    private createProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram | null {

        const gl = this.gl;

        const program: WebGLProgram = gl.createProgram()!;
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        var success = gl.getProgramParameter(program, gl.LINK_STATUS);
        if (success) {
            return program;
        }

        gl.deleteProgram(program);

        return null;

    }

    private fetchAttributeLocations(program: WebGLProgram): { [key: string]: number } {

        const attributes: { [key: string]: number } = {};

        const n = this.gl.getProgramParameter(program, this.gl.ACTIVE_ATTRIBUTES);

        for (let i = 0; i < n; i++) {

            const info = this.gl.getActiveAttrib(program, i)!;
            const name = info.name;

            // console.log( 'THREE.WebGLProgram: ACTIVE VERTEX ATTRIBUTE:', name, i );

            attributes[name] = this.gl.getAttribLocation(program, name);

        }

        return attributes;

    }

}