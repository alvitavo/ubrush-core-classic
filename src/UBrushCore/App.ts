import { IBrush } from '../UBrushCore/common/IBrush';
import { DrawingScreen } from './DrawingScreen';
import { BrushEditorScreen } from './BrushEditorScreen';

export interface BrushCategory {
    key: string;
    displayName: string;
    file: string;
    brushes?: IBrush[];
}

export class App {
    private drawingScreen?: DrawingScreen;
    private editorScreen?: BrushEditorScreen;

    async init(container: HTMLElement): Promise<void> {
        const categories = await this.loadCategories();

        this.drawingScreen = new DrawingScreen(categories, () => this.showEditor());
        this.editorScreen = new BrushEditorScreen(
            () => this.showDrawing(),
            (brush) => this.applyBrushFromEditor(brush)
        );

        container.appendChild(this.drawingScreen.element);
        container.appendChild(this.editorScreen.element);

        this.editorScreen.loadSchema().catch(console.error);
        this.showDrawing();
    }

    private showDrawing(): void {
        this.editorScreen?.hide();   // restore main PM
        this.drawingScreen?.show();  // resume main loop
    }

    private showEditor(): void {
        const info = this.drawingScreen?.getCurrentBrushInfo();
        this.drawingScreen?.hide();  // pause main loop first
        this.editorScreen?.show();   // activate preview PM
        if (info) this.editorScreen?.loadBrush(info.brush, info.categoryFile); // setBrush with preview PM active
    }

    private applyBrushFromEditor(brush: IBrush): void {
        this.drawingScreen?.applyBrush(brush);
        this.showDrawing();
    }

    private async loadCategories(): Promise<BrushCategory[]> {
        try {
            const resp = await fetch('brushCategories.json');
            const manifest: BrushCategory[] = await resp.json();
            if (manifest.length > 0) {
                manifest[0].brushes = await App.loadCategoryBrushes(manifest[0].file);
            }
            return manifest;
        } catch (e) {
            console.warn('Could not load brushCategories.json', e);
            return [];
        }
    }

    static async loadCategoryBrushes(file: string): Promise<IBrush[]> {
        try {
            const resp = await fetch(file);
            const data = await resp.json();
            return Array.isArray(data) ? data as IBrush[] : [];
        } catch (e) {
            console.warn(`Could not load ${file}`, e);
            return [];
        }
    }
}
