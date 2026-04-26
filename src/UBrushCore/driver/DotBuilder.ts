import { Dot } from "../common/Dot";
import { ExpressionHelper, ICalcExpressionParam } from "./ExpressionHelper";
import { Point } from "../common/Point";
import { Stylus } from "../common/Stylus";
import { IBrush, IBrushExpression, RotationType, ColorVariationType } from "../common/IBrush";
import { LineDriverDelegate } from "./LineDriver";
import { Common } from "../common/Common";
import { Color } from "../common/Color";

export class DotBuilder {

    private dotIndex: number = 0;
    private brush?: IBrush;

    private dotBuffer: Dot[] = [];
    private usedDotBuffer: Dot[] = [];

    private dotBufferSize: number = 0;
    private usedDotBufferSize: number = 0;

    private firstAngle: number = Number.NaN;

    private hue: number = 0;
    private sat: number = 0;
    private val: number = 0;

    // public property

    public color: Color = new Color();
    public color2: Color = new Color();

    public brushOpacity: number = 1;

    public delegate?: LineDriverDelegate; // weak

    // constructor() {
        
    // }

    public setBrush(brush?: IBrush): void {
        
        this.brush = brush;

        if (brush && (
            brush.rotationType === RotationType.DIRECTION ||
            brush.rotationType === RotationType.DIRECTION_FIRST_DOT ||
            brush.rotationType === RotationType.DIRECTION_OR_AZIMUTH ||
            brush.rotationType === RotationType.DIRECTION_FIRST_DOT_OR_AZIMUTH ||
            brush.dualTipRotationType === RotationType.DIRECTION ||
            brush.dualTipRotationType === RotationType.DIRECTION_FIRST_DOT ||
            brush.dualTipRotationType === RotationType.DIRECTION_OR_AZIMUTH ||
            brush.dualTipRotationType === RotationType.DIRECTION_FIRST_DOT_OR_AZIMUTH)) {

            this.usedDotBufferSize = 1;

        }

    }

    public setColor(color: Color): void {

        this.color = color.clone();

        const red = this.color.r;
        const green = this.color.g;
        const blue = this.color.b;

        const hsv: { h: number, s: number, v: number } = Common.convertRGB2HSV(red, green, blue);
        this.hue = hsv.h;
        this.sat = hsv.s;
        this.val = hsv.v;

    }

    public resetDotIndex(): void {

        this.dotIndex = 0;

    }

    public resetSecondColor(): void {

        if (!this.brush) return;

        const colorParam: ICalcExpressionParam = { progressLength: 0, level: 0, pressure: 0, altitudeAngle: 0, azimuthAngle: 0 };
        let hue2: number = ExpressionHelper.calcExpression(this.brush.hue, colorParam) + this.hue;
        let sat2: number = ExpressionHelper.calcExpression(this.brush.saturation, colorParam) + this.sat;
        let val2: number = ExpressionHelper.calcExpression(this.brush.brightness, colorParam) + this.val;

        hue2 = ((hue2 % 1.0) + 1.0) % 1.0;
        sat2 = Common.clamp0_1(sat2);
        val2 = Common.clamp0_1(val2);

        const rgb: { r: number, g: number, b: number } = Common.convertHSV2RGB(hue2, sat2, val2);

        this.color2 = new Color(rgb.r, rgb.g, rgb.b);

    }

    public clearFirstAngle(): void {

        this.firstAngle = Number.NaN;

    }

    // dot buffer

    public flushDotBuffer(): void {

        for (let i = 0; i < this.dotBuffer.length; i++) {

            const dot: Dot = this.dotBuffer[i];
            this.processDot(dot);

        }

        this.dotBuffer = []; // removeAllObjects;
        this.usedDotBuffer = []; // removeAllObjects;

    }

    public prepareDot(param: {pt: Point, size: number, progressLength: number, level: number, stylus: Stylus}): void {
        
        const dot: Dot = new Dot();
        dot.prepareX = param.pt.x;
        dot.prepareY = param.pt.y;
        dot.prepareSize = param.size;
        dot.prepareProgressLength = param.progressLength;
        dot.prepareLevel = param.level;
        dot.preparePressure = param.stylus.pressure;
        dot.prepareAltitudeAngle = param.stylus.altitudeAngle;
        dot.prepareAzimuthAngle = param.stylus.azimuthAngle;

        this.dotBuffer.push(dot);
        this.testDotBuffer();

    }

    // feedback

    private sendDot(dot: Dot): void {

        this.delegate?.lineDriverMakeDot(dot);

    }

    //////////////////////////////////////////////////////////
    ////////////////////////////////////////////////// PRIVATE
    //////////////////////////////////////////////////////////

    private testDotBuffer(): void {

        if (this.dotBuffer.length <= this.dotBufferSize) {

            return;

        }

        const dot: Dot = this.dotBuffer.shift()!;
        this.processDot(dot);

        if (this.usedDotBufferSize > 0) {

            this.usedDotBuffer.push(dot);

            if (this.usedDotBuffer.length > this.usedDotBufferSize) {

                this.usedDotBuffer.shift();

            }

        } else {

            this.usedDotBuffer = []; // removeAllObjects;
        }

    }

    private processDot(dot: Dot): void {

        if (!this.brush) return;

        const tipRepeatCount = Math.max(1, this.brush.tipRepeatCount ?? 1);

        if (this.brush.useDualTip) {

            if (this.brush.dualTipInterval >= 0 || this.dotIndex % this.brush.dualTipInterval === 0) {

                for (let r = 0; r < tipRepeatCount; r++) {
                    const repeatDot = dot.copyForPrepare();
                    if (this.buildDot(repeatDot)) {
                        this.sendDot(repeatDot);
                    }
                }

            }

            if (this.brush.dualTipInterval <= 0 || this.dotIndex % this.brush.dualTipInterval === 0) {

                const dualRepeatCount = Math.max(1, this.brush.dualTipRepeatCount ?? 1);
                for (let r = 0; r < dualRepeatCount; r++) {
                    const secondDot = dot.copyForPrepare();
                    if (this.buildSecondDot(secondDot)) {
                        this.sendDot(secondDot);
                    }
                }

            }

        } else {

            for (let r = 0; r < tipRepeatCount; r++) {
                const repeatDot = dot.copyForPrepare();
                if (this.buildDot(repeatDot)) {
                    this.sendDot(repeatDot);
                }
            }

        }

        this.dotIndex++;

    }

    private buildDot(dot: Dot): boolean {
        
        if (!this.brush) return false;
        
        const oval: number = this.brush.oval;

        if (oval === 0) {

            dot.width = dot.prepareSize;
            dot.height = dot.prepareSize;

        } if (oval > 0.0) {

            dot.width = dot.prepareSize * (1 - oval);
            dot.height = dot.prepareSize;

        } else {

            dot.width = dot.prepareSize;
            dot.height = dot.prepareSize * (1 + oval);

        }

        this.buildDiv(dot);

        if (this.buildRotation(dot, false) === false) {

            return false;

        }

        const spray: number = ExpressionHelper.calcExpression(this.brush.spray, dot.expresstionParam);

        let offsetX: number = 0;
        let offsetY: number = 0;

        if (spray !== 0) {

            const offsetDistance: number = Common.random() * dot.prepareSize * spray;
            const offsetDirection: number = Common.random() * Math.PI * 2;
            offsetX = Math.cos(offsetDirection) * offsetDistance;
            offsetY = Math.sin(offsetDirection) * offsetDistance;

        }

        const scaleForAltitude = this.brush.scaleForAltitude ?? 0;
        if ((scaleForAltitude > 0 || this.brush.offsetForAltitude > 0) && !isNaN(dot.prepareAzimuthAngle)) {

            const altitudeAngleHeavy = Math.max(0.0, dot.prepareAltitudeAngle - 0.7) / 0.3;
            const tiltShift = altitudeAngleHeavy * scaleForAltitude + 1.0;

            if (scaleForAltitude > 0) {
                dot.width *= tiltShift;
            }

            if (this.brush.offsetForAltitude > 0) {
                const distance = dot.prepareSize * dot.prepareAltitudeAngle * tiltShift * this.brush.offsetForAltitude;
                const direction = Math.PI * 2 * dot.prepareAzimuthAngle;
                offsetX += Math.cos(direction) * distance;
                offsetY += Math.sin(direction) * distance;
            }

        }

        dot.centerX = dot.prepareX + offsetX;
        dot.centerY = dot.prepareY + offsetY;

        const brushOpacityFactor: number = Common.interpolate(this.brush.minOpacity, this.brush.maxOpacity, this.brushOpacity);
        const layerOpacityFactor: number = Common.interpolate(this.brush.minLayerOpacity, this.brush.maxLayerOpacity, this.brushOpacity);
        const mixingOpacityFactor: number = Common.interpolate(this.brush.minMixingOpacity, this.brush.maxMixingOpacity, this.brushOpacity);

        dot.layerOpacity = layerOpacityFactor;

        dot.opacity = ExpressionHelper.calcExpression(this.brush.opacity, dot.expresstionParam) * brushOpacityFactor;
        dot.patternOpacity = ExpressionHelper.calcExpression(this.brush.textureOpacity, dot.expresstionParam);

        const noCorrosion: import("../common/IBrush").IBrushExpression = { min: 0, max: 0, sources: [] };
        dot.tipCorrosion = ExpressionHelper.calcExpression(this.brush.tipCorrosion ?? noCorrosion, dot.expresstionParam);
        dot.textureCorrosion = ExpressionHelper.calcExpression(this.brush.textureCorrosion ?? noCorrosion, dot.expresstionParam);
        dot.tipCorrosionSize = this.brush.tipCorrosionSize ?? 1;
        dot.textureCorrosionSize = this.brush.textureCorrosionSize ?? 1;

        dot.patternOffsetX = this.brush.textureOffset;
        dot.patternOffsetY = this.brush.textureOffset;

        if (this.brush.useTextureFitting) {

            dot.patternWidth = -1;
            dot.patternHeight = -1;

        } else {

            dot.patternWidth = 128 * this.brush.textureScale;
            dot.patternHeight = 128 * this.brush.textureScale;

        }

        dot.mixingOpacity = ExpressionHelper.calcExpression(this.brush.mixingOpacity, dot.expresstionParam) * mixingOpacityFactor;
        dot.tinting = ExpressionHelper.calcExpression(this.brush.tint, dot.expresstionParam);

        if (this.brush.colorVariationType === ColorVariationType.NONE) {

            dot.tintRed = this.color.r;
            dot.tintGreen = this.color.g;
            dot.tintBlue = this.color.b;

        } else if (this.brush.colorVariationType === ColorVariationType.FIRST_DOT) {

            dot.tintRed = this.color2.r;
            dot.tintGreen = this.color2.g;
            dot.tintBlue = this.color2.b;

        } else { // ColorVariationType.ALWAYS

            let hue2: number = ExpressionHelper.calcExpression(this.brush.hue, dot.expresstionParam) + this.hue;
            let sat2: number = ExpressionHelper.calcExpression(this.brush.saturation, dot.expresstionParam) + this.sat;
            let val2: number = ExpressionHelper.calcExpression(this.brush.brightness, dot.expresstionParam) + this.val;

            hue2 = ((hue2 % 1.0) + 1.0) % 1.0;
            sat2 = Common.clamp0_1(sat2);
            val2 = Common.clamp0_1(val2);

            const rgb: { r: number, g: number, b: number } = Common.convertHSV2RGB(hue2, sat2, val2);

            dot.tintRed = rgb.r;
            dot.tintGreen = rgb.g;
            dot.tintBlue = rgb.b;

        }

        // small tip modify

        if (dot.width < this.brush.tipMinSize) {

            dot.opacity *= (dot.width / this.brush.tipMinSize);
            dot.width = this.brush.tipMinSize;

        }

        if (dot.height < this.brush.tipMinSize) {

            dot.opacity *= (dot.height / this.brush.tipMinSize);
            dot.height = this.brush.tipMinSize;

        }

        const textureJitter = this.brush.textureJitter ?? 0;
        if (textureJitter > 0) {
            dot.textureJitterOffsetX = (Common.random() * 2 - 1) * textureJitter;
            dot.textureJitterOffsetY = (Common.random() * 2 - 1) * textureJitter;
        } else {
            dot.textureJitterOffsetX = 0;
            dot.textureJitterOffsetY = 0;
        }

        return true;

    }

    private buildSecondDot(dot: Dot): boolean {

        if (!this.brush) return false;
        
        dot.isMask = true;

        const oval: number = this.brush.dualTipOval;
        const dualTipScale: number = ExpressionHelper.calcExpression(this.brush.dualTipScale, dot.expresstionParam);

        const size: number = dot.prepareSize * dualTipScale;

        if (oval === 0.0) {

            dot.width = size;
            dot.height = size;

        } if (oval > 0.0) {

            dot.width = size * (1 - oval);
            dot.height = size;

        } else {

            dot.width = size;
            dot.height = size * (1 + oval);

        }

        this.buildDiv(dot);

        if (this.buildRotation(dot, true) === false) {

            return false;

        }

        const dualTipOpacityFactor: number = Common.interpolate(this.brush.dualTipMinOpacity, this.brush.dualTipMaxOpacity, this.brushOpacity);

        dot.opacity = ExpressionHelper.calcExpression(this.brush.dualTipOpacity, dot.expresstionParam) * dualTipOpacityFactor;

        const noCorrosion2: import("../common/IBrush").IBrushExpression = { min: 0, max: 0, sources: [] };
        dot.tipCorrosion = ExpressionHelper.calcExpression(this.brush.dualTipCorrosion ?? noCorrosion2, dot.expresstionParam);
        dot.textureCorrosion = ExpressionHelper.calcExpression(this.brush.dualTipTextureCorrosion ?? noCorrosion2, dot.expresstionParam);
        dot.tipCorrosionSize = this.brush.dualTipCorrosionSize ?? 1;
        dot.textureCorrosionSize = this.brush.dualTipTextureCorrosionSize ?? 1;

        const spray: number = ExpressionHelper.calcExpression(this.brush.dualTipSpray, dot.expresstionParam)

        if (spray === 0) {

            dot.centerX = dot.prepareX;
            dot.centerY = dot.prepareY;
            
        } else {

            const offsetDistance: number = Common.random() * dot.prepareSize * spray;
            const offsetDirection: number = Common.random() * Math.PI * 2;
            dot.centerX = dot.prepareX + Math.cos(offsetDirection) * offsetDistance;
            dot.centerY = dot.prepareY + Math.sin(offsetDirection) * offsetDistance;

        }

        return true;

    }

    private buildDiv(dot: Dot): void {

        if (!this.brush) return;
        
        const divX: number = Math.max(1, this.brush.tipDivideX);
        const divY: number = Math.max(1, this.brush.tipDivideY);
        const index: number = Math.floor(ExpressionHelper.calcExpression(this.brush.tipIndex, dot.expresstionParam) * divX * divY);
        const indexX: number = index % divX;
        const indexY: number = Math.floor(index / divX);

        const divW: number = 1 / divX;
        const divH: number = 1 / divY;

        dot.textureL = indexX * divW;
        dot.textureR = (indexX + 1) * divW;
        dot.textureT = indexY * divH;
        dot.textureB = (indexY + 1) * divH;

    }

    private buildRotation(dot: Dot, isDualTip: boolean): boolean {

        if (!this.brush) return false;
        
        const initialAngle: number = isDualTip ? this.brush.dualTipInitialAngle : this.brush.initialAngle;
        const deltaAngle: number = isDualTip ? this.brush.dualTipDeltaAngle : this.brush.deltaAngle;
        const angleJitter: number = isDualTip ? this.brush.dualTipAngleJitter : this.brush.angleJitter;
        const rotationType = isDualTip ? this.brush.dualTipRotationType : this.brush.rotationType;

        const noExpression: IBrushExpression = { min: 0, max: 0, sources: [] };
        const alphaAngleExpr = isDualTip
            ? (this.brush.dualTipAlphaAngle ?? noExpression)
            : (this.brush.alphaAngle ?? noExpression);
        const alphaAngle = ExpressionHelper.calcExpression(alphaAngleExpr, dot.expresstionParam);

        const angle: number = Math.PI * 2 * (initialAngle + Common.random() * angleJitter + deltaAngle * this.dotIndex + alphaAngle);

        if (rotationType === RotationType.FIXED || rotationType === RotationType.FIXED_OR_AZIMUTH) {
            
            dot.rotation = angle;

        } else if (rotationType === RotationType.DIRECTION || rotationType === RotationType.DIRECTION_OR_AZIMUTH) {
            
            if (this.usedDotBuffer.length > 0) {

                const prevDot: Dot = this.usedDotBuffer[this.usedDotBuffer.length - 1]; // last object
                const nextDot: Dot = (this.dotBuffer.length > 0) ? this.dotBuffer[0] : dot;
                dot.rotation = angle + Math.atan2(prevDot.prepareY - nextDot.prepareY, prevDot.prepareX - nextDot.prepareX);
                
            } else {

                return false;

            }

        } else if (rotationType === RotationType.DIRECTION_FIRST_DOT || rotationType === RotationType.DIRECTION_FIRST_DOT_OR_AZIMUTH) {

            if (isNaN(this.firstAngle)) {

                if (this.usedDotBuffer.length > 0) {

                    const prevDot: Dot = this.usedDotBuffer[this.usedDotBuffer.length - 1]; // last object
                    const nextDot: Dot = (this.dotBuffer.length > 0) ? this.dotBuffer[0] : dot;
                    this.firstAngle = angle + Math.atan2(prevDot.prepareY - nextDot.prepareY, prevDot.prepareX - nextDot.prepareX);

                } else {

                    return false;

                }

            }

            dot.rotation = this.firstAngle;

        }

        if (!isNaN(dot.prepareAzimuthAngle) && (
            rotationType === RotationType.FIXED_OR_AZIMUTH ||
            rotationType === RotationType.DIRECTION_OR_AZIMUTH ||
            rotationType === RotationType.DIRECTION_FIRST_DOT_OR_AZIMUTH
        )) {

            dot.rotation = angle + Math.PI * 2 * dot.prepareAzimuthAngle;

        }

        return true;
    }

}