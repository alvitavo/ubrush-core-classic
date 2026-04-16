import { Rect } from "./Rect";
import { Point } from "./Point";
import { Size } from "./Size";

export class Common {
    
    public static wetedgeBase64(): string {

        return "iVBORw0KGgoAAAANSUhEUgAAAQAAAAABCAAAAAAUMi+rAAAASklEQVR4AV1LCwpEQQiqvP+Vt6e4wtDI+EHrmsagp1AkRopQoYI7VuDXUgVoDbAy8z/Q2hrJUc4yu28f2diYTbR3FA7Z3CL8l99+meUomQdKwnwAAAAASUVORK5CYII=";
        
    }

    public static pointInStage(point: Point, size: Size): Point {

        return new Point(
            (point.x - size.width * 0.5) / (size.width * 0.5), 
            (point.y - size.height * 0.5) / (size.height * 0.5));

    }
    
    public static pointInTexture(point: Point, size: Size): Point {

        return new Point(point.x / size.width, point.y / size.height);

    }

    public static stageRect(): Rect {

        return new Rect(-1, -1, 2, 2);

    }

    public static clamp0_1(v: number): number {

        return Math.min(Math.max(0, v), 1);

    }

    // TODO: seed
    public static random(): number {

        return Math.random();

    }

    public static interpolate(min: number, max: number, f: number): number {
        
        return min + (max - min) * f;

    }

    public static interpolatePoint(minPt: Point, maxPt: Point, f: number): Point {
        
        return new Point(minPt.x + (maxPt.x - minPt.x) * f, minPt.y + (maxPt.y - minPt.y) * f);
    
    }
    
    public static distance(p1: Point, p2: Point): number {
        
        return Math.sqrt((p1.x - p2.x) * (p1.x - p2.x) + (p1.y - p2.y) * (p1.y - p2.y));
    
    }

    public static convertRGB2HSV(r: number, g: number, b: number): {h: number, s: number, v: number} {
        
        const result: {h: number, s: number, v: number} = {h: 0, s: 0, v: 0};

        const minRGB: number = Math.min(r, Math.min(g, b));
        const maxRGB: number = Math.max(r, Math.max(g, b));

        if (minRGB === maxRGB) {
            result.h = 0;
            result.s = 0;
            result.v = minRGB;
        } else {
            const d: number = (r === minRGB) ? g - b : ((b === minRGB) ? r - g : b - r);
            const h: number = (r === minRGB) ? 3 : ((b === minRGB) ? 1 : 5);
            result.h = (60 * (h - d / (maxRGB - minRGB))) / 360;
            result.s = ((maxRGB - minRGB) / maxRGB);
            result.v = maxRGB;
        }

        return result;

    }

    public static convertHSV2RGB(h: number, s: number, v: number): {r: number, g: number, b: number} {
        
        h = h * 6;

        if (h === 0) {
            h=.01;
        }

        if (isNaN(h)) {
            return {r: v, g: v, b: v};
        }

        const i: number = Math.floor(h);
        let f: number = h - i;

        if (!(i & 1)) { // if i is even
            f = 1 - f
        }

        let m: number = v * (1 - s);
        let n: number = v * (1 - s * f);

        switch (i) {
            case 6:
            case 0: return {r: v, g: n, b: m};
            case 1: return {r: n, g: v, b: m};
            case 2: return {r: m, g: v, b: n};
            case 3: return {r: m, g: n, b: v};
            case 4: return {r: n, g: m, b: v};
            case 5: return {r: v, g: m, b: n};
            default: return {r: v, g: n, b: m};
        }

    }

}