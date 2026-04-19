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
    private container!: HTMLElement;

    async init(container: HTMLElement): Promise<void> {
        this.container = container;

        const categories = await this.loadCategories();

        this.drawingScreen = new DrawingScreen(categories, () => this.showEditor());
        this.editorScreen = new BrushEditorScreen(
            () => this.showDrawing(),
            (brush) => this.applyBrushFromEditor(brush)
        );

        container.appendChild(this.drawingScreen.element);
        container.appendChild(this.editorScreen.element);

        // Load the brush editor schema (async, non-blocking)
        this.editorScreen.loadSchema().catch(console.error);

        // Start on drawing screen
        this.showDrawing();
    }

    private showDrawing(): void {
        this.editorScreen?.hide();
        this.drawingScreen?.show();
    }

    private showEditor(): void {
        const brush = this.drawingScreen?.getCurrentBrush();
        if (brush) this.editorScreen?.loadBrush(brush);
        this.drawingScreen?.hide();
        this.editorScreen?.show();
    }

    private applyBrushFromEditor(brush: IBrush): void {
        this.drawingScreen?.applyBrush(brush);
        this.showDrawing();
    }

    private async loadCategories(): Promise<BrushCategory[]> {
        try {
            const resp = await fetch('brushCategories.json');
            const manifest: BrushCategory[] = await resp.json();

            // Load brushes for the first category eagerly; others are lazy-loaded
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
