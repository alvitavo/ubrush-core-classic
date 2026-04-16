export class Stylus {

    public pressure: number;
    public altitudeAngle: number;
    public azimuthAngle: number;

    public constructor(pressure: number = NaN, altitudeAngle: number = NaN, azimuthAngle: number = NaN) {
        
        this.pressure = pressure;
        this.altitudeAngle = altitudeAngle;
        this.azimuthAngle = azimuthAngle;

    }

    public toString(): string {

        return "pressure = " + this.pressure + ", altitudeAngle = " + this.altitudeAngle + ", azimuthAngle = " + this.azimuthAngle;

    }

}