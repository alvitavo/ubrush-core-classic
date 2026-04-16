export class Size {

    public width: number;
    public height: number;

    public constructor(width: number = 0, height: number = 0) {
        this.width = width;
        this.height = height;
    }

    public equals(size: Size): boolean {
        if (Math.abs(size.width - this.width) < Number.EPSILON && Math.abs(size.height - this.height) < Number.EPSILON) {
            return true;
        }
        return false;
    }

    public clone(): Size {

        return new Size(this.width, this.height);

    }

    public toString(): string {
        return " width = " + this.width + " height = " + this.height;
    }
}