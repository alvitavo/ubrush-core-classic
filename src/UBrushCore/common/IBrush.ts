export enum LayerBlendmode {
    NORMAL = "NORMAL", 
    MULTIPLY = "MULTIPLY", 
    ERASE = "ERASE"
}

export enum DryType {
    AUTO = "AUTO", 
    MANUAL = "MANUAL"
}

export enum RotationType {
    FIXED = "FIXED", 
    DIRECTION = "DIRECTION", 
    DIRECTION_FIRST_DOT = "DIRECTION_FIRST_DOT", 
    FIXED_OR_AZIMUTH = "FIXED_OR_AZIMUTH", 
    DIRECTION_OR_AZIMUTH = "DIRECTION_OR_AZIMUTH", 
    DIRECTION_FIRST_DOT_OR_AZIMUTH = "DIRECTION_FIRST_DOT_OR_AZIMUTH"
}

export enum ColorVariationType {
    NONE = "NONE", 
    ALWAYS = "ALWAYS",
    FIRST_DOT = "FIRST_DOT"
}

export enum StrokeType {
    LINE = "LINE", 
    CURVE = "CURVE",
    FOLLOW = "FOLLOW"
}

export enum EngineType {
    BASIC_DOTS = "BASIC_DOTS", 
    SMUDGING_DOTS = "SMUDGING_DOTS", 
    WATER_DOTS = "WATER_DOTS"
}

export enum ExpressionSourceType {
    FIXED_VALUE = "FIXED_VALUE",
    VELOCITY = "VELOCITY",
    INVERSE_VELOCITY = "INVERSE_VELOCITY",
    JITTER = "JITTER"
}

export enum ExpressionOperation {
    PLUS = "PLUS", 
    MINUS = "MINUS", 
    MULTIPLY = "MULTIPLY"
}

export enum ExpressionExclusiveStylusSource {
    DEFAULT = "DEFAULT", 
    PRESSURE = "PRESSURE", 
    ALTITUDE_ANGLE = "ALTITUDE_ANGLE", 
    ALTITUDE_ANGLE_HEAVY = "ALTITUDE_ANGLE_HEAVY", 
    AZIMUTH_ANGLE = "AZIMUTH_ANGLE"
}

export interface IBrushExpressionSource {
    type: ExpressionSourceType | string;
    operation: ExpressionOperation | string;
    value: number;
    weight: number;
    exclusiveStylusSource?: ExpressionExclusiveStylusSource | string;
}

export interface IBrushExpression {
    min: number;
    max: number;
    sources: IBrushExpressionSource[];
}

export interface IBrush {
    defaultSize: number;
    tipMinSize: number;

    spacing: number;
    minSpacing: number;

    defaultOpacity: number;
    minLayerOpacity: number;
    maxLayerOpacity: number;
    minMixingOpacity: number;
    maxMixingOpacity: number;

    offsetForAltitude: number;
    initialAngle: number;
    textureOffset: number;
    
    layerLowCut: number;
    layerHighCut: number;

    tipDivideX: number;
    tipDivideY: number;
    
    minSize: number;
    maxSize: number;

    oval: number;
    deltaAngle: number;
    minOpacity: number;
    maxOpacity: number;

    angleJitter: number;
    followAcceleration: number;
    
    dualTipOval: number;
    dualTipDeltaAngle: number;
    dualTipMinOpacity: number;
    dualTipMaxOpacity: number;
    dualTipInterval: number;
    dualTipAngleJitter: number;
    dualTipInitialAngle: number;
    
    textureScale: number;

    tint: IBrushExpression;
    mixingOpacity: IBrushExpression;
    
    tipIndex: IBrushExpression;

    hue: IBrushExpression;
    brightness: IBrushExpression;
    saturation: IBrushExpression;

    textureOpacity: IBrushExpression;
    opacity: IBrushExpression;
    scale: IBrushExpression;
    spray: IBrushExpression;
    
    dualTipOpacity: IBrushExpression;
    dualTipScale: IBrushExpression;
    dualTipSpray: IBrushExpression;
    
    useTextureFitting: boolean;
    useColor: boolean;
    useLayerTinting: boolean;
    useLayerWetEdge: boolean;
    useSmudging: boolean;
    useDualTip: boolean;

    icon?: string;
    preview?: string;
    tipSource: string;
    textureSource?: string;
    dualTipSource?: string;

    name?: string;
    
    layerBlendmode: LayerBlendmode | string;
    dryType: DryType | string;
    dualTipRotationType: RotationType | string;
    rotationType: RotationType | string;
    colorVariationType: ColorVariationType | string;
    strokeType: StrokeType | string;
    engineType: EngineType | string;
}
