import { Point } from "./Point";
import { Size } from "./Size";

export class Rect {

    public origin: Point;
    public size: Size;

    public constructor(x: number = 0, y: number = 0, width: number = 0, height: number = 0) {

        this.origin = new Point(x, y);
        this.size = new Size(width, height);

    }

    public get maxX(): number {

        return this.origin.x + this.size.width;

    }

    public get maxY(): number {

        return this.origin.y + this.size.height;

    }

    public get minX(): number {

        return this.origin.x;

    }

    public get minY(): number {

        return this.origin.y;

    }

    public set(x: number = 0, y: number = 0, width: number = 0, height: number = 0) {

        this.origin.x = x;
        this.origin.y = y;
        this.size.width = width;
        this.size.height = height;

    }

    public copy(rect: Rect) {

        this.origin.x = rect.origin.x;
        this.origin.y = rect.origin.y;
        this.size.width = rect.size.width;
        this.size.height = rect.size.height;

    }

    public equals(rect: Rect): boolean {

        if (rect.origin.equals(rect.origin) && rect.size.equals(rect.size)) {
            return true;
        }
        return false;

    }

    public static union(src: Rect, dest: Rect): Rect {

        const x1: number = Math.min(src.minX, dest.minX);
        const x2: number = Math.max(src.maxX, dest.maxX);
        const y1: number = Math.min(src.minY, dest.minY);
        const y2: number = Math.max(src.maxY, dest.maxY);
        return new Rect(x1, y1, x2 - x1, y2 - y1);

    }

    public clone(): Rect {

        return new Rect(this.origin.x, this.origin.y, this.size.width, this.size.height);

    }

    public toString(): string {

        return this.origin.toString() + this.size.toString();
        
    }
}