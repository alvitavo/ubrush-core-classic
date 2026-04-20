export enum LayerBlendmode {
    NORMAL = "Normal",
    DARKEN = "Darken",
    MULTIPLY = "Multiply",
    COLOR_BURN = "Color Burn",
    LINEAR_BURN = "Linear Burn",
    DARKER_COLOR = "Darker Color",
    LIGHTEN = "Lighten",
    SCREEN = "Screen",
    COLOR_DODGE = "Color Dodge",
    LINEAR_DODGE = "Linear Dodge",
    LIGHTER_COLOR = "Lighter Color",
    OVERLAY = "Overlay",
    SOFT_LIGHT = "Soft Light",
    HARD_LIGHT = "Hard Light",
    VIVID_LIGHT = "Vivid Light",
    LINEAR_LIGHT = "Linear Light",
    PIN_LIGHT = "Pin Light",
    HARD_MIX = "Hard Mix",
    DIFFERENCE = "Difference",
    EXCLUSION = "Exclusion",
    SUBTRACT = "Subtract",
    DIVIDE = "Divide",
    HUE = "Hue",
    SATURATION = "Saturation",
    COLOR = "Color",
    LUMINOSITY = "Luminosity",
    ERASE = "Erase"
}

export enum DotBlendmode {
    NORMAL = "Normal",
    ADD = "Add",
    SCREEN = "Screen",
    MAX = "Max"
}

export enum EdgeStyle {
    NONE = "NONE",
    WET = "WET",
    BURN = "BURN",
    HARD = "HARD",
    SOFT = "SOFT"
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


export enum ExpressionSourceType {
    FIXED_VALUE = "FIXED_VALUE",
    VELOCITY = "VELOCITY",
    INVERSE_VELOCITY = "INVERSE_VELOCITY",
    JITTER = "JITTER",
    SLIDER_VALUE = "SLIDER_VALUE", // DEPRECATED
    FADE = "FADE", // DEPRECATED
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
    useSmudging: boolean;
    useDualTip: boolean;
    alphaSmudgingMode: boolean;
    useSecondaryMask: boolean;

    icon?: string;
    preview?: string;
    tipSource: string;
    textureSource?: string;
    dualTipSource?: string;

    name?: string;
    
    layerBlendmode: LayerBlendmode | string;
    dotBlendmode: DotBlendmode | string;
    maskDotBlendmode: DotBlendmode | string;
    edgeStyle: EdgeStyle | string;
    dualTipEdgeStyle: EdgeStyle | string;
    dryType: DryType | string;
    dualTipRotationType: RotationType | string;
    rotationType: RotationType | string;
    colorVariationType: ColorVariationType | string;
    strokeType: StrokeType | string;
}
