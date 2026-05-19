import { IBrush } from '../../common/IBrush';

export interface BrushCategory {
    key: string;
    displayName: string;
    file: string;
    brushes?: IBrush[];
}

export type AppTool = 'brush' | 'eraser' | 'smudge';
