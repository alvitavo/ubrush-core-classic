import { Rect } from "./Rect";

export enum FixerRenderTarget {

    Liquid, Dry, Merged
    
}

export class Fixer {

    // public 

    public readonly patchRect: Rect;
    public readonly patchStageRect: Rect;
    public readonly renderTarget: FixerRenderTarget;
    public readonly patchImageUrl?: string;
    public readonly patchMaskImageUrl?: string;

    constructor(patchRect: Rect, patchStageRect: Rect, renderTarget: FixerRenderTarget, patchImageUrl: string, patchMaskImageUrl?: string) {

        this.patchRect = patchRect;
        this.patchStageRect = patchStageRect;
        this.renderTarget = renderTarget;
        this.patchImageUrl = patchImageUrl;
        this.patchMaskImageUrl = patchMaskImageUrl;

    }

}