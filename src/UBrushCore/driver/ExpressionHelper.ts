import { IBrushExpression, IBrushExpressionSource, ExpressionOperation, ExpressionExclusiveStylusSource, ExpressionSourceType } from "../common/IBrush";
import { Common } from "../common/Common";

export interface ICalcExpressionParam {

    progressLength: number;
    level: number;
    fade: number;
    pressure: number;
    altitudeAngle: number;
    azimuthAngle: number;

}

export class ExpressionHelper {

    public static calcExpression(expression: IBrushExpression, param: ICalcExpressionParam): number {
        
        let sum: number = 0;

        for (let i = 0; i < expression.sources.length; i++) {

            const expressionSource: IBrushExpressionSource = expression.sources[i];
            const value: number = this.calcExpressionSourceValue(expressionSource, param);

            switch (expressionSource.operation) {

                case ExpressionOperation.PLUS:
                    sum += value;
                    break;
                case ExpressionOperation.MINUS:
                    sum -= value;
                    break;
                case ExpressionOperation.MULTIPLY:
                    sum *= value;
                    break;
                default:
                    sum += value;

            }

        }

        return expression.min + (expression.max - expression.min) * sum;

    }

    private static calcExpressionSourceValue(expressionSource: IBrushExpressionSource, param: ICalcExpressionParam): number {

        let result: number = 0;

        if (expressionSource.exclusiveStylusSource === ExpressionExclusiveStylusSource.PRESSURE && !isNaN(param.pressure)) {

            result = param.pressure;

        } else if (expressionSource.exclusiveStylusSource === ExpressionExclusiveStylusSource.ALTITUDE_ANGLE && !isNaN(param.altitudeAngle)) {

            result = param.altitudeAngle;

        } else if (expressionSource.exclusiveStylusSource === ExpressionExclusiveStylusSource.ALTITUDE_ANGLE_HEAVY && !isNaN(param.altitudeAngle)) {

            result = Math.max(0.0, param.altitudeAngle - 0.7) / 0.3;

        } else if (expressionSource.exclusiveStylusSource === ExpressionExclusiveStylusSource.AZIMUTH_ANGLE && !isNaN(param.azimuthAngle)) {

            result = param.azimuthAngle;

        } else {

            switch (expressionSource.type) {

                case ExpressionSourceType.FIXED_VALUE:
                    result = expressionSource.value;
                    break;
                case ExpressionSourceType.VELOCITY:
                    result = param.level * expressionSource.value;
                    break;
                case ExpressionSourceType.INVERSE_VELOCITY:
                    result = 1 - Common.clamp0_1(param.level * expressionSource.value);
                    break;
                case ExpressionSourceType.FADE_IN:
                    result = Common.clamp0_1(param.progressLength * expressionSource.value * 0.1);
                    result = Math.sin(result * (Math.PI * 0.5));
                    break;
                case ExpressionSourceType.FADE_OUT:
                    result = 1 - Common.clamp0_1(param.progressLength * expressionSource.value * 0.1);
                    result = Math.sin(result * (Math.PI * 0.5));
                    break;
                case ExpressionSourceType.FADE_IN_OUT:
                    result = param.progressLength * expressionSource.value * 0.1;
                    
                    if (result > 1) {

                        result = 2 - result;

                    }

                    result = Math.sin(Common.clamp0_1(result) * (Math.PI * 0.5));
                    break;
                case ExpressionSourceType.FADE_OUT_FOR_TAIL:
                    result = Math.sin(Common.clamp0_1(param.fade / expressionSource.value) * (Math.PI * 0.5));
                    break;
                case ExpressionSourceType.FADE_IN_OUT_FOR_TAIL:
                    result = Math.sin(Math.min(Common.clamp0_1(param.progressLength * expressionSource.value * 0.1), Common.clamp0_1(param.fade)) * (Math.PI * 0.5));
                    break;
                case ExpressionSourceType.JITTER:
                    result = Common.random() * expressionSource.value;

            }

        }

        return Common.clamp0_1(result) * expressionSource.weight;

    }
    
}