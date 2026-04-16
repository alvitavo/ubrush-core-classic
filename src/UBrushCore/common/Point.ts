export class Point {

    public x: number;
    public y: number;

    public constructor(x: number = 0, y: number = 0) {

        this.x = x;
        this.y = y;

    }

    public equals(point: Point): boolean {

        if (Math.abs(point.x - this.x) < Number.EPSILON && Math.abs(point.y - this.y) < Number.EPSILON) {

            return true;

        }

        return false;

    }
    
    public clone(): Point {
        
        return new Point(this.x, this.y);

    }

    public toString(): string {

        return " x = " + this.x + " y = " + this.y;
        
    }
}