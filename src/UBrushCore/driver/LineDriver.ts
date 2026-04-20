import { Point } from "../common/Point";
import { Stylus } from "../common/Stylus";
import { DotBuilder } from "./DotBuilder";
import { ExpressionHelper, ICalcExpressionParam } from "./ExpressionHelper";
import { IBrush, StrokeType, ColorVariationType } from "../common/IBrush";
import { Dot } from "../common/Dot";
import { Common } from "../common/Common";
import { Color } from "../common/Color";

export interface LineDriverDelegate {

    lineDriverMakeDot(dot: Dot): void;

}

export class LineDriver {

    private SPLINE_STEP = 5;

    private tempPt: Point = new Point();
    private movedPt: Point = new Point();
    private followedPt: Point = new Point();
    private bSplineBufferPt: Point = new Point();
    private bSplineCenterPt: Point = new Point();

    private prevSize: number = 0;
    private prevLevel: number = 0;
    private prevStylus: Stylus = new Stylus();

    private progressLength: number = 0;

    private actionPrevPt: Point = new Point();
    private actionBuffer: number = 0;
    private actionPrevLevel: number = 0;
    private actionPrevStylus: Stylus = new Stylus();

    private dotBuilder: DotBuilder = new DotBuilder();

    private brush?: IBrush;

    private brushSize: number = 1;

    // constructor() {

    // }

    // API

    public setDelegate(delegate: LineDriverDelegate): void {

        this.dotBuilder.delegate = delegate;

    }

    public setBrushSize(value: number): void {

        this.brushSize = value;

    }

    public setBrushOpacity(value: number): void {

        this.dotBuilder.brushOpacity = value;

    }

    public setBrush(brush?: IBrush): void {

        this.dotBuilder.setBrush(brush);
        this.brush = brush;

    }

    public setColor(color: Color): void {

        this.dotBuilder.setColor(color);

    }

    public getColor(): Color {

        return this.dotBuilder.color;

    }

    // stroke level 1

    public moveTo(pt: Point, stylus: Stylus) {

        this.moveToLv2(pt, stylus);

    }

    public lineTo(pt: Point, stylus: Stylus) {

        this.lineToLv2(pt, stylus);

    }

    public endLine(pt: Point, stylus: Stylus) {

        this.endLineLv2(pt, stylus);

    }

    //////////////////////////////////////////////////////////
    ////////////////////////////////////////////////// PRIVATE
    //////////////////////////////////////////////////////////

    // stroke level 3 (stroke)

    private moveToLv2(pt: Point, stylus: Stylus): void {

        if (!this.brush) return;

        this.dotBuilder.resetDotIndex();

        switch (this.brush.strokeType) {

            case StrokeType.CURVE:
                this.cMoveTo(pt, stylus);
                break;
            case StrokeType.FOLLOW:
                this.fMoveTo(pt, stylus);
                break;
            case StrokeType.LINE:
                this.nMoveTo(pt, stylus);
                break;

        }

    }

    private lineToLv2(pt: Point, stylus: Stylus): void {

        if (!this.brush) return;

        switch (this.brush.strokeType) {

            case StrokeType.CURVE:
                this.cLineTo(pt, stylus);
                break;
            case StrokeType.FOLLOW:
                this.fLineTo(pt, stylus);
                break;
            case StrokeType.LINE:
                this.nLineTo(pt, stylus);
                break;

        }

    }

    private endLineLv2(pt: Point, stylus: Stylus): void {

        if (!this.brush) return;

        switch (this.brush.strokeType) {

            case StrokeType.CURVE:
                this.cEndLine(pt, stylus);
                break;
            case StrokeType.FOLLOW:
                this.fEndLine(pt, stylus);
                break;
            case StrokeType.LINE:
                this.nEndLine(pt, stylus);
                break;

        }

        this.dotBuilder.flushDotBuffer();

    }

    // stroke level 4 (normal mode)

    private nMoveTo(pt: Point, stylus: Stylus): void {

        this.tempPt = pt.clone();
        this.moveToAction(pt, 0, stylus);

    }

    private nLineTo(pt: Point, stylus: Stylus): void {

        const level: number = Common.distance(pt, this.tempPt) / 100;
        this.lineToAction(pt, level, stylus);
        this.tempPt = pt.clone();

    }

    private nEndLine(pt: Point, stylus: Stylus): void {

        const level: number = Common.distance(pt, this.tempPt) / 100;
        this.lineToAction(pt, level, stylus);
        this.tempPt = pt.clone();

    }

    // stroke level 4 (curve mode)

    private cMoveTo(pt: Point, stylus: Stylus): void {

        this.tempPt = pt.clone();
        this.bSplineMoveTo(pt, 0, stylus);

    }

    private cLineTo(pt: Point, stylus: Stylus): void {

        const level: number = Common.distance(pt, this.tempPt) / 100;
        this.bSplineLineTo(pt, level, stylus, 0.5);
        this.tempPt = pt.clone();

    }

    private cEndLine(pt: Point, stylus: Stylus): void {

        const level: number = Common.distance(pt, this.tempPt) / 100;
        this.bSplineLineTo(pt, level, stylus, 1.0);
        this.tempPt = pt.clone();

    }

    // stroke level 4 (follow mode)

    private fMoveTo(pt: Point, stylus: Stylus): void {

        this.bSplineMoveTo(pt, 0, stylus);
        this.movedPt = pt.clone();
        this.followedPt = pt.clone();

    }

    private fLineTo(pt: Point, stylus: Stylus): void {

        this.movedPt = pt.clone();
        this.followAction(stylus);

    }

    private fEndLine(pt: Point, stylus: Stylus): void {

        this.followAction(stylus);

    }

    //////////

    private followAction(stylus: Stylus): void {

        if (!this.brush) return;

        const level: number = Common.distance(this.followedPt, this.movedPt) / 100;

        this.followedPt.x = this.followedPt.x + (this.movedPt.x - this.followedPt.x) * this.brush.followAcceleration;
        this.followedPt.y = this.followedPt.y + (this.movedPt.y - this.followedPt.y) * this.brush.followAcceleration;

        this.bSplineLineTo(this.followedPt, level, stylus);

    }

    private bSplineMoveTo(pt: Point, level: number, stylus: Stylus): void {

        this.bSplineBufferPt = pt.clone();
        this.bSplineCenterPt = pt.clone();

        this.moveToAction(pt, level, stylus);

        this.prevLevel = level;

    }

    private bSplineLineTo(pt: Point, level: number, stylus: Stylus, rate: number = 0.5, step: number = this.SPLINE_STEP): void {

        const currentPt: Point = pt.clone();
        const currentCenterPt: Point = Common.interpolatePoint(this.bSplineBufferPt, currentPt, rate);

        const x1: number = this.bSplineCenterPt.x;
        const y1: number = this.bSplineCenterPt.y;
        const x2: number = this.bSplineBufferPt.x;
        const y2: number = this.bSplineBufferPt.y;
        const x3: number = currentCenterPt.x;
        const y3: number = currentCenterPt.y;

        const dl: number = (level - this.prevLevel) / step;

        const ds: Stylus = new Stylus();
        ds.pressure = (stylus.pressure - this.prevStylus.pressure) / step;
        ds.altitudeAngle = (stylus.altitudeAngle - this.prevStylus.altitudeAngle) / step;

        if (Math.abs(stylus.azimuthAngle - this.prevStylus.azimuthAngle) > 0.5) {

            if (stylus.azimuthAngle > this.prevStylus.azimuthAngle) {

                ds.azimuthAngle = (stylus.azimuthAngle - this.prevStylus.azimuthAngle - 1.0) / step;

            } else {

                ds.azimuthAngle = (stylus.azimuthAngle - this.prevStylus.azimuthAngle + 1.0) / step;

            }

        } else {

            ds.azimuthAngle = (stylus.azimuthAngle - this.prevStylus.azimuthAngle) / step;

        }

        for (let i = 1; i <= step; i++) {

            const t: number = i / step;
            const s: number = 1.0 - i / step;
            const tt: number = t * t;
            const ss: number = s * s;
            const ts2: number = 2 * t * s;

            const px: number = x1 * ss + x2 * ts2 + x3 * tt;
            const py: number = y1 * ss + y2 * ts2 + y3 * tt;

            const pt: Point = new Point(px, py);

            const l: number = this.prevLevel + dl * i;

            const p: Stylus = new Stylus(this.prevStylus.pressure + ds.pressure * i,
                this.prevStylus.altitudeAngle + ds.altitudeAngle * i,
                this.prevStylus.azimuthAngle + ds.azimuthAngle * i);

            this.lineToAction(pt, l, p);

        }

        this.bSplineBufferPt = currentPt.clone();
        this.bSplineCenterPt = currentCenterPt.clone();

        this.prevLevel = level;
        this.prevStylus = stylus;

    }

    private moveToAction(pt: Point, level: number, stylus: Stylus): void {

        if (!this.brush) return;

        this.progressLength = 0;
        this.actionPrevPt = pt;
        this.actionBuffer = 0;

        this.dotBuilder.clearFirstAngle();

        const size: number = Common.interpolate(this.brush.minSize, this.brush.maxSize, this.brushSize);
        const scaleParam: ICalcExpressionParam = {

            progressLength: 0,
            level: level,
            pressure: stylus.pressure,
            altitudeAngle: stylus.altitudeAngle,
            azimuthAngle: stylus.azimuthAngle

        }

        const scale: number = ExpressionHelper.calcExpression(this.brush.scale, scaleParam);
        const actualSize: number = size * scale;
        this.prevLevel = level;
        this.prevStylus = stylus;
        this.prevSize = actualSize;
        this.actionPrevLevel = level;
        this.actionPrevStylus = stylus;

        if (this.brush.colorVariationType === ColorVariationType.FIRST_DOT) {

            this.dotBuilder.resetSecondColor();

        }

    }

    private lineToAction(pt: Point, level: number, stylus: Stylus): void {

        if (!this.brush) return;

        const pointDistance: number = Common.distance(pt, this.actionPrevPt);
        if (pointDistance === 0) return;

        let buffer: number = this.actionBuffer;

        let pointInterval: number;
        let ratio: number;
        let size: number;
        let scale: number;
        let actualSize: number;

        let drawPoint: Point;

        size = Common.interpolate(this.brush.minSize, this.brush.maxSize, this.brushSize);
        const minSpacing: number = this.brush.minSpacing;
        const spacing: number = this.brush.spacing;

        while (true) {

            ratio = buffer / pointDistance;

            if (ratio > 1.0) {

                this.actionBuffer = buffer - pointDistance;
                break;

            }

            drawPoint = Common.interpolatePoint(this.actionPrevPt, pt, ratio);

            const currentLevel: number = (this.actionPrevLevel + (level - this.actionPrevLevel) * ratio);
            const currentLength: number = (this.progressLength + pointDistance * ratio);

            const currentPressure: number = this.actionPrevStylus.pressure + (stylus.pressure - this.actionPrevStylus.pressure) * ratio;
            const currentAltitudeAngle: number = this.actionPrevStylus.altitudeAngle + (stylus.altitudeAngle - this.actionPrevStylus.altitudeAngle) * ratio;
            let currentAzimuthAngle: number;

            if (Math.abs(stylus.azimuthAngle - this.actionPrevStylus.azimuthAngle) > 0.5) {

                if (stylus.azimuthAngle > this.actionPrevStylus.azimuthAngle) {

                    currentAzimuthAngle = this.actionPrevStylus.azimuthAngle + (stylus.azimuthAngle - this.actionPrevStylus.azimuthAngle - 1) * ratio;

                } else {

                    currentAzimuthAngle = this.actionPrevStylus.azimuthAngle + (stylus.azimuthAngle - this.actionPrevStylus.azimuthAngle + 1) * ratio;

                }

            } else {

                currentAzimuthAngle = this.actionPrevStylus.azimuthAngle + (stylus.azimuthAngle - this.actionPrevStylus.azimuthAngle) * ratio;

            }

            const currentStylus: Stylus = new Stylus(currentPressure, currentAltitudeAngle, currentAzimuthAngle);

            this.dotBuilder.prepareDot({

                pt: drawPoint,
                size: this.prevSize,
                progressLength: currentLength,
                level: currentLevel,
                stylus: currentStylus

            });

            // save current point

            scale = ExpressionHelper.calcExpression(this.brush.scale, {

                progressLength: currentLength,
                level: currentLevel,
                pressure: currentStylus.pressure,
                altitudeAngle: currentStylus.altitudeAngle,
                azimuthAngle: currentStylus.azimuthAngle

            });

            actualSize = size * scale;

            pointInterval = Math.max(0.2, Math.max(minSpacing, (this.prevSize + actualSize) * 0.5 * spacing));

            buffer += pointInterval;
            this.prevSize = actualSize;

        }

        this.progressLength += pointDistance;

        this.actionPrevPt = pt.clone();
        this.actionPrevLevel = level;
        this.actionPrevStylus = stylus;

    }

}
