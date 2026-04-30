import { Texture } from "./Texture";
import { Textures } from "./Textures";

const mat4array = new Float32Array(16);
const mat3array = new Float32Array(9);
const mat2array = new Float32Array(4);

export class SingleUniform {

    id: string;
    addr: WebGLUniformLocation;
    cache: any[];
    setValue: (gl: WebGL2RenderingContext, v: any, t: any) => (void);

    arrayCacheF32: number[] = [];


    constructor(activeInfo: WebGLActiveInfo, addr: WebGLUniformLocation) {

        this.id = activeInfo.name;
        this.addr = addr;
        this.cache = [];
        this.setValue = this.getSingularSetter(activeInfo.type);

    }

    private getSingularSetter(type: GLenum): (gl: WebGL2RenderingContext, v: any, t?: Textures) => (void) {

        switch (type) {

            case 0x1406: return this.setValueV1f; // FLOAT
            case 0x8b50: return this.setValueV2f; // _VEC2
            case 0x8b51: return this.setValueV3f; // _VEC3
            case 0x8b52: return this.setValueV4f; // _VEC4

            case 0x8b5a: return this.setValueM2; // _MAT2
            case 0x8b5b: return this.setValueM3; // _MAT3
            case 0x8b5c: return this.setValueM4; // _MAT4

            case 0x1404: case 0x8b56: return this.setValueV1i; // INT, BOOL
            case 0x8b53: case 0x8b57: return this.setValueV2i; // _VEC2
            case 0x8b54: case 0x8b58: return this.setValueV3i; // _VEC3
            case 0x8b55: case 0x8b59: return this.setValueV4i; // _VEC4

            case 0x1405: return this.setValueV1ui; // UINT // webgl2 only

            case 0x8b5e: // SAMPLER_2D
            case 0x8d66: // SAMPLER_EXTERNAL_OES
            case 0x8dca: // INT_SAMPLER_2D
            case 0x8dd2: // UNSIGNED_INT_SAMPLER_2D
            case 0x8b62: // SAMPLER_2D_SHADOW
                return this.setValueT1;

        }

        return this.setValueV1f;
    }

    private arraysEqual(a: number[], b: number[]) {

        if (a.length !== b.length) return false;

        for (let i = 0, l = a.length; i < l; i++) {

            if (a[i] !== b[i]) return false;

        }

        return true;

    }

    private copyArray(a: number[], b: number[]) {

        for (let i = 0, l = b.length; i < l; i++) {

            a[i] = b[i];

        }

    }

    // Single scalar

    private setValueV1f(gl: WebGL2RenderingContext, v: number) {

        const cache = this.cache;

        if (cache[0] === v) return;

        gl.uniform1f(this.addr, v);

        cache[0] = v;

    }

    // Single float vector (from flat array or THREE.VectorN)

    private setValueV2f(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (v.x !== undefined) {

            if (cache[0] !== v.x || cache[1] !== v.y) {

                gl.uniform2f(this.addr, v.x, v.y);

                cache[0] = v.x;
                cache[1] = v.y;

            }

        } else if (v.width !== undefined) {

            if (cache[0] !== v.width || cache[1] !== v.height) {

                gl.uniform2f(this.addr, v.width, v.height);

                cache[0] = v.width;
                cache[1] = v.height;

            }

        } else {

            if (this.arraysEqual(cache, v)) return;

            gl.uniform2fv(this.addr, v);

            this.copyArray(cache, v);

        }

    }

    private setValueV3f(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (v.x !== undefined) {

            if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z) {

                gl.uniform3f(this.addr, v.x, v.y, v.z);

                cache[0] = v.x;
                cache[1] = v.y;
                cache[2] = v.z;

            }

        } else if (v.r !== undefined) {

            if (cache[0] !== v.r || cache[1] !== v.g || cache[2] !== v.b) {

                gl.uniform3f(this.addr, v.r, v.g, v.b);

                cache[0] = v.r;
                cache[1] = v.g;
                cache[2] = v.b;

            }

        } else {

            if (this.arraysEqual(cache, v)) return;

            gl.uniform3fv(this.addr, v);

            this.copyArray(cache, v);

        }

    }

    private setValueV4f(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (v.x !== undefined) {

            if (cache[0] !== v.x || cache[1] !== v.y || cache[2] !== v.z || cache[3] !== v.w) {

                gl.uniform4f(this.addr, v.x, v.y, v.z, v.w);

                cache[0] = v.x;
                cache[1] = v.y;
                cache[2] = v.z;
                cache[3] = v.w;

            }

        } else if (v.r !== undefined) {

            if (cache[0] !== v.r || cache[1] !== v.g || cache[2] !== v.b || cache[3] !== v.a) {

                gl.uniform4f(this.addr, v.r, v.g, v.b, v.a);

                cache[0] = v.x;
                cache[1] = v.y;
                cache[2] = v.z;
                cache[3] = v.w;

            }

        } else {

            if (this.arraysEqual(cache, v)) return;

            gl.uniform4fv(this.addr, v);

            this.copyArray(cache, v);

        }

    }

    // Single matrix (from flat array or MatrixN)

    private setValueM2(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;
        const elements = v.elements;

        if (elements === undefined) {

            if (this.arraysEqual(cache, v)) return;

            gl.uniformMatrix2fv(this.addr, false, v);

            this.copyArray(cache, v);

        } else {

            if (this.arraysEqual(cache, elements)) return;

            mat2array.set(elements);

            gl.uniformMatrix2fv(this.addr, false, mat2array);

            this.copyArray(cache, elements);

        }

    }

    private setValueM3(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;
        const elements = v.elements;

        if (elements === undefined) {

            if (this.arraysEqual(cache, v)) return;

            gl.uniformMatrix3fv(this.addr, false, v);

            this.copyArray(cache, v);

        } else {

            if (this.arraysEqual(cache, elements)) return;

            mat3array.set(elements);

            gl.uniformMatrix3fv(this.addr, false, mat3array);

            this.copyArray(cache, elements);

        }

    }

    private setValueM4(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;
        const elements = v.elements;

        if (elements === undefined) {

            if (this.arraysEqual(cache, v)) return;

            gl.uniformMatrix4fv(this.addr, false, v);

            this.copyArray(cache, v);

        } else {

            if (this.arraysEqual(cache, elements)) return;

            mat4array.set(elements);

            gl.uniformMatrix4fv(this.addr, false, mat4array);

            this.copyArray(cache, elements);

        }

    }

    // // Single texture 

    private setValueT1(gl: WebGL2RenderingContext, v: Texture, textures?: Textures) {

        if (!textures) return;

        const cache = this.cache;
        const unit = textures?.allocateTextureUnit();

        if (cache[0] !== unit) {

            gl.uniform1i(this.addr, unit);
            cache[0] = unit;

        }

        textures.setTexture2D(v, unit);

    }

    // // Integer / Boolean vectors or arrays thereof (always flat arrays)

    private setValueV1i(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (cache[0] === v) return;

        gl.uniform1i(this.addr, v);

        cache[0] = v;

    }

    private setValueV2i(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (this.arraysEqual(cache, v)) return;

        gl.uniform2iv(this.addr, v);

        this.copyArray(cache, v);

    }

    private setValueV3i(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (this.arraysEqual(cache, v)) return;

        gl.uniform3iv(this.addr, v);

        this.copyArray(cache, v);

    }

    private setValueV4i(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (this.arraysEqual(cache, v)) return;

        gl.uniform4iv(this.addr, v);

        this.copyArray(cache, v);

    }

    // uint

    private setValueV1ui(gl: WebGL2RenderingContext, v: any) {

        const cache = this.cache;

        if (cache[0] === v) return;

        (gl as any).uniform1ui(this.addr, v);

        cache[0] = v;

    }

}

export class Uniforms {

    gl: WebGL2RenderingContext;
    singleUniforms: SingleUniform[] = [];
    map: { [key: string]: SingleUniform } = {};

    constructor(gl: WebGL2RenderingContext, program: WebGLProgram) {

        this.gl = gl;

        const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);

        for (let i = 0; i < n; ++i) {

            const info = gl.getActiveUniform(program, i)!;
            const addr = gl.getUniformLocation(program, info.name)!;

            const singleUniform = new SingleUniform(info, addr);
            this.singleUniforms.push(singleUniform);

            this.map[singleUniform.id] = singleUniform;

        }

    }

    public setValue(name: string, value: any, textures?: Textures) {

        const u = this.map[name];

        if (u !== undefined) {
            u.setValue(this.gl, value, textures);
        }

    };

}