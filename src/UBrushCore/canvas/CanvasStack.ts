import { Size } from "../common/Size";
import { RenderTarget } from "../gpu/RenderTarget";
import { UBrushContext } from "../gpu/UBrushContext";
import { IBrush } from "../common/IBrush";
import { Canvas, CanvasDelegate } from "./Canvas";
import { Color } from "../common/Color";
import { Common } from "../common/Common";
import { Rect } from "../common/Rect";
import { FixerGroup } from "../common/FixerGroup";

export interface CanvasStackDelegate {

    changeRect(canvasStack: CanvasStack, rect: Rect): void;
    didReleaseDrawing?(canvasStack: CanvasStack, fixerGroup: FixerGroup, canvasIndex: number): void;
    didDry?(canvasStack: CanvasStack, canvasIndex: number): void;
    willChangeCanvases?(canvasStack: CanvasStack, canvasArray: Canvas[]): void;
    didChangeCanvases?(canvasStack: CanvasStack, canvasArray: Canvas[]): void;

}

export class CanvasStack implements CanvasDelegate{

    public delegate?: CanvasStackDelegate;
    public outputRenderTarget: RenderTarget;
    public brush?: IBrush;
    public selectedCanvas?: Canvas;

    public updatelock: boolean = false;

    private size: Size;
    private context: UBrushContext;
    private canvasArray: Canvas[];
    private backgroundColor: Color = Color.white();

    // get / set
    private _brushSize: number = 1;

    public set brushSize(v: number) {

        this._brushSize = v;
        this.selectedCanvas?.lineDriver.setBrushSize(v);

    }

    public get brushSize(): number {

        return this._brushSize;
        
    }
    
    private _brushOpacity: number = 1;

    public set brushOpacity(v: number) {

        this._brushOpacity = v;
        this.selectedCanvas?.lineDriver.setBrushOpacity(v);

    }

    public get brushOpacity(): number {

        return this._brushOpacity;
        
    }

    private _color: Color = new Color();

    public set color(v: Color) {

        this._color = v;
        this.selectedCanvas?.setColor(v);

    }

    public get color(): Color {

        return this._color;
        
    }

    constructor(context: UBrushContext, size: Size) {

        this.outputRenderTarget = context.createRenderTarget(size);
        this.size = size;
        this.context = context;
        this.canvasArray = [];
        
    }

    public setBrush(brush: IBrush): void {
        
        this.brush = brush;
        
        if (this.selectedCanvas) {

            this.selectedCanvas.setBrush(brush);

        }

    }

    public selectCanvas(canvas: Canvas): void {

        this.selectedCanvas = canvas;
    
        for (canvas of this.canvasArray) {

            if (canvas === this.selectedCanvas) {

                canvas.setBrush(this.brush);
                canvas.selected = true;

            } else {

                canvas.dry();
                canvas.setBrush(undefined);
                canvas.selected = false;

            }

        }
        
        this.selectedCanvas?.lineDriver.setBrushSize(this.brushSize);
        this.selectedCanvas?.lineDriver.setBrushOpacity(this.brushOpacity);
        this.selectedCanvas?.setColor(this.color.clone());
        
    }

    public selectCanvasAt(index: number): void {

        if (index >= 0 || index < this.canvasArray.length) {

            this.selectCanvas(this.canvasArray[index]);

        }
        
    }

    public selectedCanvasIndex(): number {

        if (this.selectedCanvas) {

            return this.canvasArray.indexOf(this.selectedCanvas);

        } else {

            return -1;

        }

    }

    // TODO: setBackgroundColor 로변경 ( 프로젝트의 모든 요소에 적용 )
    public setBackgroundColor(backgroundColor: Color): void {
        
        this.backgroundColor = backgroundColor;
        this.updateCanvas();

    }

    public addCanvas(canvas: Canvas): void {

        this.insertCanvas(canvas, this.canvasArray.length - 1);

    }

    // TODO: temporary 를 canvas에서 빼고 insertCanvas 파라미터로 temporary 추가
    public insertCanvas(canvas: Canvas, index: number): void {

        if (canvas.temporary)
        {

            canvas.useFixer = false;
            this.canvasArray.splice(index, 0, canvas);
            return;

        }
        
        canvas.useFixer = true;
        
        if (this.delegate) {

            this.delegate.willChangeCanvases?.(this, this.canvasArray.concat());
            this.canvasArray.splice(index, 0, canvas);
            this.delegate.didChangeCanvases?.(this, this.canvasArray.concat());

        } else {

            this.canvasArray.splice(index, 0, canvas);

        }

        canvas.delegate = this;

    }
    
    public removeCanvas(canvas: Canvas): void {

        if (canvas.temporary) {

            this.canvasArray.splice(this.canvasArray.indexOf(canvas), 1);
            return;
            
        }

        if (this.delegate) {

            this.delegate.willChangeCanvases?.(this, this.canvasArray.concat());
            this.canvasArray.splice(this.canvasArray.indexOf(canvas), 1);
            this.delegate.didChangeCanvases?.(this, this.canvasArray.concat());

        } else {

            this.canvasArray.splice(this.canvasArray.indexOf(canvas), 1);

        }
        
        canvas.delegate = this;
        
        this.updateCanvas();

    }
    
    public insertCanvasFromIndex(fromIndex: number, toIndex: number): void {

        if (this.delegate) {

            this.delegate.willChangeCanvases?.(this, this.canvasArray.concat());

        }

        const canvas = this.canvasArray.splice(fromIndex, 1)[0];
        this.canvasArray.splice(toIndex, 0, canvas);
        
        if (this.delegate) {

            this.delegate.didChangeCanvases?.(this, this.canvasArray.concat());

        }
        
        this.updateCanvas();
        
    }

    // propertise

    // - (void)setVisible:(BOOL)visible withCanvas:(UBrushCanvas *)canvas
    // {
    //     [canvas setVisible:visible];
    //     [self updateCanvas];
    // }

    // - (void)setAlphaLock:(BOOL)alphaLock withCanvas:(UBrushCanvas *)canvas
    // {
    //     [canvas setAlphaLock:alphaLock];
    // }

    // - (void)setOpacity:(float)opacity withCanvas:(UBrushCanvas *)canvas
    // {
    //     [self setOpacity:opacity withCanvas:canvas forPreview:NO];
    // }

    // - (void)setOpacity:(float)opacity withCanvas:(UBrushCanvas *)canvas forPreview:(BOOL)forPreview
    // {
    //     float oldOpacity = canvas.opacity;
        
    //     [canvas setOpacity:opacity];
    //     [self updateCanvas];
        
    //     if (forPreview)
    //     {
    //         [canvas setOpacity:oldOpacity];
    //     }
    // }

    // - (void)setBlendmode:(UBrushCanvasBlendmode)blendmode withCanvas:(UBrushCanvas *)canvas
    // {
    //     [canvas setBlendmode:blendmode];
    //     [self updateCanvas];
    // }

    // update

    public updateCanvas(): void {

        this.updateCanvasInRect(Common.stageRect());

    }

    public updateCanvasInRect(rect: Rect): void {

        if (this.updatelock) {

            return;

        }
    
        // [self updateCanvasInRect:rect
        //     targetFramebuffer:self.outputFramebuffer
        //                 canvases:canvasArray
        //             forceVisible:NO
        //         useBackground:YES];

    }

    // canvas delegate

    public changeRect(canvas: Canvas, rect: Rect): void {

    }

    public didReleaseDrawingWithFixerGroup(canvas: Canvas, fixerGroup: FixerGroup): void {
        
    }

    public didDryCanvas(canvas: Canvas): void {

    }

}