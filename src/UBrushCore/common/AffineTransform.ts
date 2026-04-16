import { Point } from "./Point";

export class AffineTransform {

    public a: number;
    public b: number;
    public c: number;
    public d: number;
    public tx: number;
    public ty: number;

    constructor(a: number = 1, b: number = 0, c: number = 0, d: number = 1, tx: number = 0, ty: number = 0) {

        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.tx = tx;
        this.ty = ty;
        
    }

    set(a: number = 1, b: number = 0, c: number = 0, d: number = 1, tx: number = 0, ty: number = 0): AffineTransform {

		this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.tx = tx;
        this.ty = ty;

        return this;
        
    }

	public flipX(): AffineTransform {

		this.transform(-1, 0, 0, 1, 0, 0);
		return this;
	
	}

	public flipY(): AffineTransform {

		this.transform(1, 0, 0, -1, 0, 0);
		return this;
	
	}

	public reset(): AffineTransform {

		this.a = this.d = 1;
        this.b = this.c = this.tx = this.ty = 0;
        
		return this;
	
	}

	public rotate(angle: number): AffineTransform {

		const cos = Math.cos(angle), sin = Math.sin(angle);
		this.transform(cos, sin, -sin, cos, 0, 0);
		return this;
	
	}

	public rotateDeg(angle: number): AffineTransform {

		this.rotate(angle * 0.017453292519943295);
		return this;
	
	}

	public scale(sx: number, sy: number): AffineTransform {

		this.transform(sx, 0, 0, sy, 0, 0);
		return this;
	
	}

	public scaleX(sx: number): AffineTransform {

		this.transform(sx, 0, 0, 1, 0, 0);
		return this;
	
	}

	public scaleY(sy: number): AffineTransform {

		this.transform(1, 0, 0, sy, 0, 0);
		return this;
	
	}

	public skew(sx: number, sy: number): AffineTransform {

		this.transform(1, sy, sx, 1, 0, 0);
		return this;
	
	}

	public skewX(sx: number): AffineTransform {

		this.transform(1, 0, sx, 1, 0, 0);
		return this;
	
	}

	public skewY(sy: number): AffineTransform {

		this.transform(1, sy, 0, 1, 0, 0);
		return this;
	
	}

	public setTransform(a: number, b: number, c: number, d: number, tx: number, ty: number): AffineTransform {

		this.a = a;
		this.b = b;
		this.c = c;
		this.d = d;
		this.tx = tx;
		this.ty = ty;

		return this;
	
	}

	public translate(tx: number, ty: number): AffineTransform {

		this.transform(1, 0, 0, 1, tx, ty);
		return this;
	
	}

	public translateX(tx: number): AffineTransform {

		this.transform(1, 0, 0, 1, tx, 0);
		return this;
	
	}

	public translateY(ty: number): AffineTransform {

		this.transform(1, 0, 0, 1, 0, ty);
		return this;
	}

    public transform(a2: number, b2: number, c2: number, d2: number, tx2: number, ty2: number): AffineTransform {

        const a1 = this.a,
        b1 = this.b,
        c1 = this.c,
        d1 = this.d,
        tx1 = this.tx,
        ty1 = this.ty;

		this.a = a1 * a2 + c1 * b2;
		this.b = b1 * a2 + d1 * b2;
		this.c = a1 * c2 + c1 * d2;
		this.d = b1 * c2 + d1 * d2;
		this.tx = a1 * tx2 + c1 * ty2 + tx1;
		this.ty = b1 * tx2 + d1 * ty2 + ty1;

        return this;
        
    }
    
    public inverse(): AffineTransform {

		const a = this.a,
        b = this.b,
        c = this.c,
        d = this.d,
        tx = this.tx,
        ty = this.ty,
        m = new AffineTransform(),
        dt = (a * d - b * c);

		m.a = d / dt;
		m.b = -b / dt;
		m.c = -c / dt;
		m.d = a / dt;
		m.tx = (c * ty - d * tx) / dt;
		m.ty = -(a * ty - b * tx) / dt;

        return m;
        
    }
    
    public interpolate(m2: AffineTransform, t: number): AffineTransform {

		const m = new AffineTransform();

		m.a = this.a + (m2.a - this.a) * t;
		m.b = this.b + (m2.b - this.b) * t;
		m.c = this.c + (m2.c - this.c) * t;
		m.d = this.d + (m2.d - this.d) * t;
		m.tx = this.tx + (m2.tx - this.tx) * t;
		m.ty = this.ty + (m2.ty - this.ty) * t;

        return m;
        
    }
    
    public applyToPoint(p: Point): Point {

		return new Point(
            p.x * this.a + p.y * this.c + this.tx,
			p.x * this.b + p.y * this.d + this.ty
        );
        
    }

    public isIdentity(): boolean {
		return (this._isEqual(this.a, 1) &&
				this._isEqual(this.b, 0) &&
				this._isEqual(this.c, 0) &&
				this._isEqual(this.d, 1) &&
				this._isEqual(this.tx, 0) &&
				this._isEqual(this.ty, 0));
	}

    public isEqual(m: AffineTransform): boolean {

		return (this._isEqual(this.a, m.a) &&
				this._isEqual(this.b, m.b) &&
				this._isEqual(this.c, m.c) &&
				this._isEqual(this.d, m.d) &&
				this._isEqual(this.tx, m.tx) &&
                this._isEqual(this.ty, m.ty));
                
	}

    private _isEqual(f1: number, f2: number): boolean {

        return Math.abs(f1 - f2) < Number.EPSILON;
        
    }

}