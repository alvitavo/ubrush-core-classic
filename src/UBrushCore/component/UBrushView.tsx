import React, { ReactNode } from "react";

interface Props {
    onContextCreate: (gl: WebGLRenderingContext) => void;
    style: {width: number, height: number};
}

interface State {

}

export default class UBrushView extends React.Component<Props, State> {

    private canvasRef: React.RefObject<HTMLCanvasElement>;

    constructor(prop: Props) {

        super(prop);
        
        this.state = {

        };
        
        this.canvasRef = React.createRef();

    }

    componentDidMount() {

        let gl: WebGLRenderingContext;

        try {

            const contextAttributes = {
                alpha: false,
                depth: false,
                stencil: false,
                antialias: true,
                premultipliedAlpha: true,
                preserveDrawingBuffer: true,
                powerPreference: "default",
                failIfMajorPerformanceCaveat: false
            };

            // canvasElement.addEventListener("webglcontextlost", this.onContextLost.bind(this), false);
            // canvasElement.addEventListener("webglcontextrestored", this.onContextRestore.bind(this), false);

            gl = (this.canvasRef.current?.getContext("webgl", contextAttributes) || this.canvasRef.current?.getContext("experimental-webgl", contextAttributes)) as WebGLRenderingContext;

            if (gl === null) {

                throw new Error("Error creating WebGL context.");

            }

            // Some experimental-webgl implementations do not have getShaderPrecisionFormat

            if (gl.getShaderPrecisionFormat === undefined) {

                gl.getShaderPrecisionFormat = () => {

                    return { "rangeMin": 1, "rangeMax": 1, "precision": 1 };

                };

            }

        } catch (error) {

            console.error("THREE.WebGLRenderer: " + error.message);
            throw error;

        }

        if (gl) this.props.onContextCreate(gl);

    }

    public render(): ReactNode {
        
        return (
            <canvas ref={this.canvasRef} 
            width={this.props.style.width} height={this.props.style.height}/>
        );

    }
    
}