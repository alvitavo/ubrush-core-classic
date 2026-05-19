import { IBrush } from '../../common/IBrush';
import { CanvasStage, CanvasStageDelegate } from './CanvasStage';
import { CrashRecoveryController } from './controllers/CrashRecoveryController';
import { DocumentController } from './controllers/DocumentController';
import { IpadAppShell, IpadAppShellDelegate } from './IpadAppShell';
import { BrushCategory } from './types';

export class IpadAppRoot implements CanvasStageDelegate, IpadAppShellDelegate {
    private categories: BrushCategory[] = [];
    private shell?: IpadAppShell;
    private document?: DocumentController;
    private recovery = new CrashRecoveryController();

    public async init(container: HTMLElement): Promise<void> {
        this.categories = await this.loadCategories();
        this.shell = new IpadAppShell(this.categories, this);
        container.appendChild(this.shell.element);

        const stage = new CanvasStage(this);
        this.shell.attachStage(stage.element);
        await stage.init();
    }

    public stageDidCreateDocument(document: DocumentController): void {
        this.document = document;
        this.shell?.bindDocument(document);
        void this.restoreOrApplyInitialBrush(document);
    }

    public stageDidFail(error: string): void {
        const failure = document.createElement('div');
        failure.style.cssText = 'position:absolute; inset:0; display:grid; place-items:center; color:#f4f0e8; background:#20211f; font:600 16px -apple-system, BlinkMacSystemFont, sans-serif;';
        failure.textContent = `WebGPU unavailable: ${error}`;
        this.shell?.element.appendChild(failure);
    }

    public async loadBrushes(category: BrushCategory): Promise<IBrush[]> {
        if (category.brushes) return category.brushes;
        category.brushes = await this.loadCategoryBrushes(category.file);
        return category.brushes;
    }

    public selectBrush(brush: IBrush, _category: BrushCategory): void {
        void this.document?.setBrush(brush);
    }

    private async applyInitialBrush(): Promise<void> {
        const category = this.categories[0];
        if (!category || !this.document) return;
        const brushes = await this.loadBrushes(category);
        if (brushes[0]) await this.document.setBrush(brushes[0]);
    }

    private async restoreOrApplyInitialBrush(documentController: DocumentController): Promise<void> {
        if (this.recoveryDisabledByUrl()) {
            await this.applyInitialBrush();
            return;
        }

        const snapshot = await this.recovery.loadLatest();
        const restored = snapshot ? documentController.restoreSnapshot(snapshot) : false;

        if (restored) {
            await this.applyInitialBrush();
            this.shell?.showToast('이전 작업을 복구했습니다');
        } else {
            await this.applyInitialBrush();
        }

        this.recovery.attach(documentController);
    }

    private recoveryDisabledByUrl(): boolean {
        const params = new URLSearchParams(window.location.search);
        const value = params.get('recovery') ?? params.get('crashRecovery') ?? params.get('layerRecovery');
        if (value === null) return false;
        return ['0', 'false', 'off', 'no', 'disabled'].includes(value.toLowerCase());
    }

    private async loadCategories(): Promise<BrushCategory[]> {
        try {
            const response = await fetch('brushCategories.json');
            const categories = await response.json() as BrushCategory[];
            if (categories[0]) categories[0].brushes = await this.loadCategoryBrushes(categories[0].file);
            return categories;
        } catch (error) {
            console.warn('Could not load brushCategories.json', error);
            return [];
        }
    }

    private async loadCategoryBrushes(file: string): Promise<IBrush[]> {
        try {
            const response = await fetch(file);
            const data = await response.json();
            return Array.isArray(data) ? data as IBrush[] : [];
        } catch (error) {
            console.warn(`Could not load ${file}`, error);
            return [];
        }
    }
}
