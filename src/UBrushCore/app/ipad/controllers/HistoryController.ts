import { Canvas } from '../../../canvas/Canvas';
import { CanvasLayer } from '../../../canvas/CanvasStack';
import { Fixer } from '../../../common/Fixer';
import { FixerGroup } from '../../../common/FixerGroup';

interface DrawingHistoryEntry {
    kind: 'drawing';
    layerId: string;
    fixerGroup: FixerGroup;
}

type LayerHistoryProperty = 'name' | 'visible' | 'opacity' | 'blendMode' | 'locked' | 'alphaLock';

interface LayerPropertyHistoryEntry {
    kind: 'layer-property';
    layerId: string;
    property: LayerHistoryProperty;
    before: string | number | boolean;
    after: string | number | boolean;
}

interface LayerAddDeleteHistoryEntry {
    kind: 'layer-add' | 'layer-delete';
    layer: CanvasLayer;
    index: number;
    selectedLayerIdBefore?: string;
    selectedLayerIdAfter?: string;
}

type HistoryEntry = DrawingHistoryEntry | LayerPropertyHistoryEntry | LayerAddDeleteHistoryEntry;

export interface HistoryLayerProvider {
    layerCanvas(layerId: string): Canvas | undefined;
    layerExists(layerId: string): boolean;
    detachLayer(layerId: string): void;
    restoreLayer(layer: CanvasLayer, index: number, select: boolean): void;
    applyLayerProperty(layerId: string, property: LayerHistoryProperty, value: string | number | boolean): void;
    selectLayerIfExists(layerId?: string): void;
    onHistoryChanged(): void;
    onLayerChanged(layerId: string): void;
}

export class HistoryController {
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];
    private activeLiquidLayerIds = new Set<string>();

    constructor(private provider: HistoryLayerProvider) {}

    public get canUndo(): boolean {
        return this.canApply(this.undoStack[this.undoStack.length - 1], true);
    }

    public get canRedo(): boolean {
        return this.canApply(this.redoStack[this.redoStack.length - 1], false);
    }

    public pushDrawing(layerId: string, fixerGroup: FixerGroup): void {
        if (!this.hasAnyFixer(fixerGroup) && !this.hasAnyRedoFixer(fixerGroup)) return;
        this.undoStack.push({ kind: 'drawing', layerId, fixerGroup });
        this.redoStack = [];
        this.markLayerLiquidActiveIfNeeded(layerId, fixerGroup);
        this.provider.onHistoryChanged();
    }

    public pushLayerProperty(
        layerId: string,
        property: LayerHistoryProperty,
        before: string | number | boolean,
        after: string | number | boolean
    ): void {
        if (before === after) return;
        this.undoStack.push({ kind: 'layer-property', layerId, property, before, after });
        this.redoStack = [];
        this.provider.onHistoryChanged();
    }

    public pushLayerAddDelete(entry: LayerAddDeleteHistoryEntry): void {
        this.undoStack.push(entry);
        this.redoStack = [];
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
        if (entry.kind === 'layer-property') {
            this.provider.applyLayerProperty(entry.layerId, entry.property, undoing ? entry.before : entry.after);
            this.provider.onLayerChanged(entry.layerId);
            return;
        }

        if (entry.kind === 'layer-add' || entry.kind === 'layer-delete') {
            const shouldExist = entry.kind === 'layer-delete' ? undoing : !undoing;
            if (shouldExist) {
                this.provider.restoreLayer(entry.layer, entry.index, true);
            } else {
                this.provider.detachLayer(entry.layer.id);
            }

            this.provider.selectLayerIfExists(undoing ? entry.selectedLayerIdBefore : entry.selectedLayerIdAfter);
            this.provider.onLayerChanged(entry.layer.id);
            return;
        }

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

    private canApply(entry: HistoryEntry | undefined, undoing: boolean): boolean {
        if (!entry) return false;

        switch (entry.kind) {
            case 'drawing':
                return undoing
                    ? this.hasAnyFixer(entry.fixerGroup)
                    : this.hasAnyRedoFixer(entry.fixerGroup);
            case 'layer-property':
                return this.provider.layerExists(entry.layerId);
            case 'layer-add':
                return undoing
                    ? this.provider.layerExists(entry.layer.id)
                    : !this.provider.layerExists(entry.layer.id);
            case 'layer-delete':
                return undoing
                    ? !this.provider.layerExists(entry.layer.id)
                    : this.provider.layerExists(entry.layer.id);
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
