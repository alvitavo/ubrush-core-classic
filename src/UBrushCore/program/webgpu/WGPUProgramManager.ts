import { WGPUContext } from "../../gpu/webgpu/WGPUContext";
import { WGPUDrawDotProgram } from "./WGPUDrawDotProgram";
import { WGPUFillRectProgram } from "./WGPUFillRectProgram";
import { WGPUFloodFillProgram } from "./WGPUFloodFillProgram";
import { WGPUHighLowCutProgram } from "./WGPUHighLowCutProgram";
import { WGPULayerCompositeProgram } from "./WGPULayerCompositeProgram";
import { WGPUMaskAndCutProgram } from "./WGPUMaskAndCutProgram";
import { WGPUMaskProgram } from "./WGPUMaskProgram";
import { WGPUMergeLayersProgram } from "./WGPUMergeLayersProgram";
import { WGPUSeparateLayersProgram } from "./WGPUSeparateLayersProgram";
import { WGPUSmudgingDrawDotProgram } from "./WGPUSmudgingDrawDotProgram";

// Singleton mirroring ../ProgramManager.ts. BrushEditorScreen swaps
// `instance` directly to switch between the main and preview contexts —
// keep `instance` as a public-static field for that pattern.

export class WGPUProgramManager {

    public static instance?: WGPUProgramManager;

    static init(context: WGPUContext): void {

        WGPUProgramManager.instance = new WGPUProgramManager(context);

    }

    static getInstance(): WGPUProgramManager {

        if (!WGPUProgramManager.instance) {

            throw new Error("WGPUProgramManager must be initialized — call WGPUProgramManager.init(context)");

        }

        return WGPUProgramManager.instance;

    }

    public drawDotProgram: WGPUDrawDotProgram;
    public smudgingDotProgram: WGPUSmudgingDrawDotProgram;
    public fillRectProgram: WGPUFillRectProgram;
    public floodFillProgram: WGPUFloodFillProgram;
    public highLowCutProgram: WGPUHighLowCutProgram;
    public layerCompositeProgram: WGPULayerCompositeProgram;
    public maskAndCutProgram: WGPUMaskAndCutProgram;
    public maskProgram: WGPUMaskProgram;
    public mergeLayersProgram: WGPUMergeLayersProgram;
    public separateLayersProgram: WGPUSeparateLayersProgram;

    private constructor(context: WGPUContext) {

        this.drawDotProgram = new WGPUDrawDotProgram(context);
        this.smudgingDotProgram = new WGPUSmudgingDrawDotProgram(context);
        this.fillRectProgram = new WGPUFillRectProgram(context);
        this.floodFillProgram = new WGPUFloodFillProgram(context);
        this.highLowCutProgram = new WGPUHighLowCutProgram(context);
        this.layerCompositeProgram = new WGPULayerCompositeProgram(context);
        this.maskAndCutProgram = new WGPUMaskAndCutProgram(context);
        this.maskProgram = new WGPUMaskProgram(context);
        this.mergeLayersProgram = new WGPUMergeLayersProgram(context);
        this.separateLayersProgram = new WGPUSeparateLayersProgram(context);

    }

    public destroy(): void {

        this.fillRectProgram.distroy();
        this.floodFillProgram.distroy();
        this.drawDotProgram.distroy();
        this.smudgingDotProgram.distroy();
        this.highLowCutProgram.distroy();
        this.layerCompositeProgram.distroy();
        this.maskAndCutProgram.distroy();
        this.maskProgram.distroy();
        this.mergeLayersProgram.distroy();
        this.separateLayersProgram.distroy();

        WGPUProgramManager.instance = undefined;

    }

}
