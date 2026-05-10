import { Rect } from "./Rect";

export enum FixerRenderTarget {

    Liquid, Dry, Merged
    
}

export class Fixer {

    // public 

    public readonly patchRect: Rect;
    public readonly patchStageRect: Rect;
    public readonly renderTarget: FixerRenderTarget;
    public readonly patchPixels?: Uint8Array;
    public readonly patchMaskPixels?: Uint8Array;

    constructor(patchRect: Rect, patchStageRect: Rect, renderTarget: FixerRenderTarget, patchPixels: Uint8Array, patchMaskPixels?: Uint8Array) {

        this.patchRect = patchRect;
        this.patchStageRect = patchStageRect;
        this.renderTarget = renderTarget;
        this.patchPixels = patchPixels;
        this.patchMaskPixels = patchMaskPixels;

    }

}