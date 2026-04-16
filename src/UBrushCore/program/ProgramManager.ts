import { FillRectProgram } from "./FillRectProgram";
import { UBrushContext } from "../gpu/UBrushContext";
import { DrawDotProgram } from "./DrawDotProgram";
import { HighLowCutProgram } from "./HighLowCutProgram";
import { MaskAndCutProgram } from "./MaskAndCutProgram";
import { MaskProgram } from "./MaskProgram";
import { MergeLayersProgram } from "./MergeLayersProgram";
import { SeparateLayersProgram } from "./SeparateLayersProgram";
import { SmudgingDrawDotProgram } from "./SmudgingDrawDotProgram";

export class ProgramManager {

    private static instance?: ProgramManager;

    static init(context: UBrushContext) {

        ProgramManager.instance = new ProgramManager(context); 

    }

    static getInstance() {

        if (!ProgramManager.instance) {

            throw(new Error("ProgramManager must be initialized with UBrushContext - ProgramManager.init(context: UBrushContext);"));
            
        }

        return ProgramManager.instance;

    }

    public drawDotProgram: DrawDotProgram;
    public smudgingDotProgram: SmudgingDrawDotProgram;
    public fillRectProgram: FillRectProgram;
    public highLowCutProgram: HighLowCutProgram;
    public maskAndCutProgram: MaskAndCutProgram;
    public maskProgram: MaskProgram;
    public mergeLayersProgram: MergeLayersProgram;
    public separateLayersProgram: SeparateLayersProgram;

    private constructor(context: UBrushContext) {

        this.drawDotProgram = new DrawDotProgram(context);
        this.smudgingDotProgram = new SmudgingDrawDotProgram(context);
        this.fillRectProgram = new FillRectProgram(context);
        this.highLowCutProgram = new HighLowCutProgram(context);
        this.maskAndCutProgram = new MaskAndCutProgram(context);
        this.maskProgram = new MaskProgram(context);
        this.mergeLayersProgram = new MergeLayersProgram(context);
        this.separateLayersProgram = new SeparateLayersProgram(context);
        
    }

    public destroy(): void {
        
        this.fillRectProgram.distroy();
        this.drawDotProgram.distroy();
        this.highLowCutProgram.distroy();
        this.maskAndCutProgram.distroy();
        this.maskProgram.distroy();
        this.mergeLayersProgram.distroy();
        this.separateLayersProgram.distroy();

        ProgramManager.instance = undefined;

    }

} 
     