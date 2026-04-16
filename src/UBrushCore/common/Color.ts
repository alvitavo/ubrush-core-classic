export class Color {

    public r: number;
    public g: number;
    public b: number;
    public a: number;
    
    constructor(r: number = 0, g: number = 0, b: number = 0, a: number = 1) {

        this.r = r;
        this.g = g;
        this.b = b;
        this.a = a;

    }

    public clone(): Color {

        return new Color(this.r, this.g, this.b, this.a);
        
    }

    public static white(): Color {

        return new Color(1, 1, 1, 1);

    }

    public static black(): Color {

        return new Color(0, 0, 0, 1);

    }

    public static clear(): Color {

        return new Color(0, 0, 0, 0);

    }

}