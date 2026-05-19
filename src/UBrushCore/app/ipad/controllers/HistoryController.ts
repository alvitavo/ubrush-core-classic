import { Canvas } from '../../../canvas/Canvas';
import { Fixer } from '../../../common/Fixer';
import { FixerGroup } from '../../../common/FixerGroup';

interface DrawingHistoryEntry {
    kind: 'drawing';
    layerId: string;
    fixerGroup: FixerGroup;
}

type HistoryEntry = DrawingHistoryEntry;

export interface HistoryLayerProvider {
    layerCanvas(layerId: string): Canvas | undefined;
    onHistoryChanged(): void;
    onLayerChanged(layerId: string): void;
}

export class HistoryController {
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];
    private activeLiquidLayerIds = new Set<string>();

    constructor(private provider: HistoryLayerProvider) {}

    public get canUndo(): boolean {
        return this.hasAnyFixer(this.undoStack[this.undoStack.length - 1]?.fixerGroup);
    }

    public get canRedo(): boolean {
        return this.hasAnyRedoFixer(this.redoStack[this.redoStack.length - 1]?.fixerGroup);
    }

    public pushDrawing(layerId: string, fixerGroup: FixerGroup): void {
        if (!this.hasAnyFixer(fixerGroup) && !this.hasAnyRedoFixer(fixerGroup)) return;
        this.undoStack.push({ kind: 'drawing', layerId, fixerGroup });
        this.redoStack = [];
        this.markLayerLiquidActiveIfNeeded(layerId, fixerGroup);
        this.provider.onHistoryChanged();
    }

    public clearLayerLiquidState(layerId: string): void {
        this.activeLiquidLayerIds.delete(layerId);
    }

    public async undo(): Promise<void> {
        const entry = this.undoStack.pop();
        if (!entry) return;

        await this.apply(entry, true);
        this.redoStack.push(entry);
        this.provider.onHistoryChanged();
    }

    public async redo(): Promise<void> {
        const entry = this.redoStack.pop();
        if (!entry) return;

        await this.apply(entry, false);
        this.undoStack.push(entry);
        this.provider.onHistoryChanged();
    }

    private async apply(entry: HistoryEntry, undoing: boolean): Promise<void> {
        if (entry.kind !== 'drawing') return;

        const targetCanvas = this.provider.layerCanvas(entry.layerId);
        if (!targetCanvas) return;

        const liquidFixer = undoing ? entry.fixerGroup.undoFixerLiquid : entry.fixerGroup.redoFixerLiquid;
        const dryFixer = undoing ? entry.fixerGroup.undoFixer : entry.fixerGroup.redoFixer;

        if (this.activeLiquidLayerIds.has(entry.layerId) && liquidFixer) {
            await targetCanvas.fix(liquidFixer, true);
            this.updateLayerLiquidStateFromFixer(entry.layerId, liquidFixer);
            this.provider.onLayerChanged(entry.layerId);
            return;
        }

        if (dryFixer) {
            await targetCanvas.fixStable(dryFixer);
            this.activeLiquidLayerIds.delete(entry.layerId);
            this.provider.onLayerChanged(entry.layerId);
            return;
        }

        if (liquidFixer) {
            await targetCanvas.fix(liquidFixer, true);
            this.updateLayerLiquidStateFromFixer(entry.layerId, liquidFixer);
            this.provider.onLayerChanged(entry.layerId);
        }
    }

    private markLayerLiquidActiveIfNeeded(layerId: string, fixerGroup: FixerGroup): void {
        if (fixerGroup.undoFixerLiquid || fixerGroup.redoFixerLiquid) {
            this.activeLiquidLayerIds.add(layerId);
        }
    }

    private updateLayerLiquidStateFromFixer(layerId: string, fixer: Fixer): void {
        if (this.fixerHasVisiblePixels(fixer)) {
            this.activeLiquidLayerIds.add(layerId);
        } else {
            this.activeLiquidLayerIds.delete(layerId);
        }
    }

    private fixerHasVisiblePixels(fixer: Fixer): boolean {
        const pixels = fixer.patchPixels;
        if (!pixels) return false;
        for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] !== 0) return true;
        }
        return false;
    }

    private hasAnyFixer(group?: FixerGroup): boolean {
        return !!(group?.undoFixer || group?.undoFixerLiquid);
    }

    private hasAnyRedoFixer(group?: FixerGroup): boolean {
        return !!(group?.redoFixer || group?.redoFixerLiquid);
    }
}
