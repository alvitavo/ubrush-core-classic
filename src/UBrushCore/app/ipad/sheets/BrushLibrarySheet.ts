import { IBrush } from '../../../common/IBrush';
import { BrushCategory } from '../types';

export interface BrushLibrarySheetDelegate {
    loadBrushes(category: BrushCategory): Promise<IBrush[]>;
    selectBrush(brush: IBrush, category: BrushCategory): void;
}

export class BrushLibrarySheet {
    public readonly element = document.createElement('div');
    private categoryList = document.createElement('div');
    private brushList = document.createElement('div');

    constructor(
        private categories: BrushCategory[],
        private delegate: BrushLibrarySheetDelegate
    ) {
        this.element.className = 'ub-sheet ub-brush-sheet';
        this.element.hidden = true;
        this.build();
    }

    public show(): void {
        this.element.hidden = false;
    }

    public hide(): void {
        this.element.hidden = true;
    }

    public toggle(): void {
        this.element.hidden ? this.show() : this.hide();
    }

    private build(): void {
        const header = document.createElement('div');
        header.className = 'ub-sheet-header';
        header.textContent = 'Brushes';
        this.element.appendChild(header);

        const body = document.createElement('div');
        body.className = 'ub-brush-body';
        this.categoryList.className = 'ub-brush-categories';
        this.brushList.className = 'ub-brush-list';
        body.append(this.categoryList, this.brushList);
        this.element.appendChild(body);

        this.categories.forEach((category, index) => {
            const button = document.createElement('button');
            button.className = 'ub-list-button';
            button.textContent = category.displayName;
            button.addEventListener('click', () => this.selectCategory(category));
            this.categoryList.appendChild(button);
            if (index === 0) void this.selectCategory(category);
        });
    }

    private async selectCategory(category: BrushCategory): Promise<void> {
        const brushes = await this.delegate.loadBrushes(category);
        this.brushList.replaceChildren();

        for (const brush of brushes) {
            const button = document.createElement('button');
            button.className = 'ub-brush-button';
            button.textContent = brush.name ?? 'Brush';
            button.addEventListener('click', () => {
                this.delegate.selectBrush(brush, category);
                this.hide();
            });
            this.brushList.appendChild(button);
        }
    }
}
