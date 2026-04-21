import { ICalcExpressionParam } from "../driver/ExpressionHelper";

export class Dot {

    public isMask: boolean = false;

    public prepareX: number = 0;
    public prepareY: number = 0;
    public prepareSize: number = 0;
    public prepareProgressLength: number = 0;
    public prepareLevel: number = 0;
    public preparePressure: number = 0;
    public prepareAltitudeAngle: number = 0;
    public prepareAzimuthAngle: number = 0;

    public textureL: number = 0;
    public textureR: number = 0;
    public textureT: number = 0;
    public textureB: number = 0;

    public centerX: number = 0;
    public centerY: number = 0;
    public width: number = 1;
    public height: number = 1;
    public rotation: number = 0;

    public patternOffsetX: number = 0;
    public patternOffsetY: number = 0;
    public patternWidth: number = 1;
    public patternHeight: number = 1;

    public layerOpacity: number = 1;
    public opacity: number = 1;
    public mixingOpacity: number = 0;
    public patternOpacity: number = 0;

    public tintRed: number = 0;
    public tintGreen: number = 0;
    public tintBlue: number = 0;
    public tinting: number = 1;

    public tipCorrosion: number = 0;
    public textureCorrosion: number = 0;
    public tipCorrosionSize: number = 1;
    public textureCorrosionSize: number = 1;

    public copyForPrepare(): Dot {
        const dot: Dot = new Dot();
        dot.prepareX = this.prepareX;
        dot.prepareY = this.prepareY;
        dot.prepareSize = this.prepareSize;
        dot.prepareProgressLength = this.prepareProgressLength;
        dot.prepareLevel = this.prepareLevel;
        dot.preparePressure = this.preparePressure;
        dot.prepareAltitudeAngle = this.prepareAltitudeAngle;
        dot.prepareAzimuthAngle = this.prepareAzimuthAngle;

        return dot;
    }

    public get expresstionParam(): ICalcExpressionParam {
        return {
            progressLength: this.prepareProgressLength,
            level: this.prepareLevel,
            pressure: this.preparePressure,
            altitudeAngle: this.prepareAltitudeAngle,
            azimuthAngle: this.prepareAzimuthAngle
        };
    }
}