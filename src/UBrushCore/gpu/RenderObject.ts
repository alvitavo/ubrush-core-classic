export interface Attribute {

    name: string;
    data: Float32Array;
    size: number;

}

export interface Uniform {

    name: string;
    value: any;

}

export enum RenderObjectBlend {

    None,
    Normal

}

export enum RenderObjectDrawModes {

    Triangles,
    TriangleStrip,
    TriangleFan

}

export class RenderObject {

    public attributes: Attribute[] = [];
    public uniforms: Uniform[] = [];

    public blend: RenderObjectBlend = RenderObjectBlend.None;
    public drawMode: RenderObjectDrawModes = RenderObjectDrawModes.Triangles;

    public indexData?: Uint16Array;
    public numberOfPoints: number = 0;

    public clear(): void {

        this.attributes = [];
        this.uniforms = [];
        this.blend = RenderObjectBlend.None;
        this.drawMode = RenderObjectDrawModes.Triangles;
        this.indexData = undefined;
        this.numberOfPoints = 0;

    }

}