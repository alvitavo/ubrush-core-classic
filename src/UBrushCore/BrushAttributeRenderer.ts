import { IBrushExpression, IBrushExpressionSource, ExpressionSourceType, ExpressionOperation, ExpressionExclusiveStylusSource } from './common/IBrush';

export interface UIInfo {
    key: string;
    name: string;
    type: string;
    valueRange?: Array<string | number>;
}

export interface AttributeGroup {
    key: string;
    name: string;
    value: UIInfo[];
}

// Maps virtual range keys to [minKey, maxKey] pairs in the brush object
const RANGE_KEY_MAP: Record<string, [string, string]> = {
    sizeRange:          ['minSize',        'maxSize'],
    opacityRange:       ['minOpacity',     'maxOpacity'],
    layerOpacityRange:  ['minLayerOpacity','maxLayerOpacity'],
    mixingOpacityRange: ['minMixingOpacity','maxMixingOpacity'],
    dualTipOpacityRange:['dualTipMinOpacity','dualTipMaxOpacity'],
    layerCutRange:      ['layerLowCut',    'layerHighCut'],
};

const EXPRESSION_SOURCE_TYPES: ExpressionSourceType[] = [
    ExpressionSourceType.FIXED_VALUE,
    ExpressionSourceType.VELOCITY,
    ExpressionSourceType.INVERSE_VELOCITY,
    ExpressionSourceType.JITTER,
];

const EXPRESSION_STYLUS_SOURCES: ExpressionExclusiveStylusSource[] = [
    ExpressionExclusiveStylusSource.DEFAULT,
    ExpressionExclusiveStylusSource.PRESSURE,
    ExpressionExclusiveStylusSource.ALTITUDE_ANGLE,
    ExpressionExclusiveStylusSource.ALTITUDE_ANGLE_HEAVY,
    ExpressionExclusiveStylusSource.AZIMUTH_ANGLE,
];

const EXPRESSION_OPERATIONS: ExpressionOperation[] = [
    ExpressionOperation.PLUS,
    ExpressionOperation.MINUS,
    ExpressionOperation.MULTIPLY,
];

export class BrushAttributeRenderer {

    render(
        container: HTMLElement,
        group: AttributeGroup,
        brush: Record<string, unknown>,
        onChange: () => void
    ): void {
        container.innerHTML = '';
        for (const ui of group.value) {
            if (!this._keyExists(ui.key, brush)) continue;
            container.appendChild(this._buildControl(ui, brush, onChange));
        }
    }

    private _keyExists(key: string, brush: Record<string, unknown>): boolean {
        if (key in RANGE_KEY_MAP) {
            const [minKey, maxKey] = RANGE_KEY_MAP[key];
            return minKey in brush || maxKey in brush;
        }
        return key in brush;
    }

    private _buildControl(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void): HTMLElement {
        switch (ui.type) {
            case 'text':       return this._buildText(ui, brush, onChange);
            case 'boolean':    return this._buildBoolean(ui, brush, onChange);
            case 'float':      return this._buildSlider(ui, brush, onChange, false);
            case 'int':        return this._buildSlider(ui, brush, onChange, true);
            case 'floatRange': return this._buildRangeSlider(ui, brush, onChange, false);
            case 'intRange':   return this._buildRangeSlider(ui, brush, onChange, true);
            case 'segmented':  return this._buildSegmented(ui, brush, onChange);
            case 'picker':     return this._buildPicker(ui, brush, onChange);
            case 'expression': return this._buildExpression(ui, brush, onChange);
            case 'image':      return this._buildImage(ui, brush, onChange);
            default: {
                const el = document.createElement('div');
                el.style.cssText = ROW_CSS;
                el.innerHTML = `<span style="${LABEL_CSS}">${ui.name}</span>`;
                return el;
            }
        }
    }

    // ── text ───────────────────────────────────────────────────────────────────

    private _buildText(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void): HTMLElement {
        const val = String(brush[ui.key] ?? '');
        const el = row();
        el.innerHTML = `
            <span style="${LABEL_CSS}">${ui.name}</span>
            <input type="text" value="${esc(val)}" style="${INPUT_CSS}">`;
        el.querySelector('input')!.addEventListener('change', e => {
            brush[ui.key] = (e.target as HTMLInputElement).value;
            onChange();
        });
        return el;
    }

    // ── boolean ───────────────────────────────────────────────────────────────

    private _buildBoolean(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void): HTMLElement {
        const val = Boolean(brush[ui.key] ?? false);
        const el = row('be-row-bool');
        el.innerHTML = `
            <span style="${LABEL_CSS}">${ui.name}</span>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" ${val ? 'checked' : ''} style="width:16px;height:16px;accent-color:#4a90d9;cursor:pointer;">
                <span style="font-size:12px;color:#888;">${val ? 'ON' : 'OFF'}</span>
            </label>`;
        const chk = el.querySelector<HTMLInputElement>('input')!;
        const lbl = el.querySelector<HTMLSpanElement>('span:last-child')!;
        chk.addEventListener('change', () => {
            brush[ui.key] = chk.checked;
            lbl.textContent = chk.checked ? 'ON' : 'OFF';
            onChange();
        });
        return el;
    }

    // ── slider ────────────────────────────────────────────────────────────────

    private _buildSlider(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void, intMode: boolean): HTMLElement {
        const [min, max] = numRange(ui);
        const step = intMode ? 1 : 0.01;
        const raw = Number(brush[ui.key] ?? min);
        const val = clamp(raw, min, max);

        const el = row();
        el.innerHTML = `
            <div style="${ROW_HDR_CSS}">
                <span style="${LABEL_CSS}">${ui.name}</span>
                <span style="${VAL_CSS}">${fmt(val, intMode)}</span>
            </div>
            <input type="range" min="${min}" max="${max}" step="${step}" value="${val}" style="${RANGE_CSS}">`;
        const input = el.querySelector<HTMLInputElement>('input')!;
        const valEl = el.querySelector<HTMLElement>('span:last-child')!;
        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            valEl.textContent = fmt(v, intMode);
            brush[ui.key] = intMode ? Math.round(v) : r2(v);
            onChange();
        });
        return el;
    }

    // ── range slider ──────────────────────────────────────────────────────────

    private _buildRangeSlider(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void, intMode: boolean): HTMLElement {
        const [min, max] = numRange(ui);
        let lo: number, hi: number;

        const mapping = RANGE_KEY_MAP[ui.key];
        if (mapping) {
            lo = clamp(Number(brush[mapping[0]] ?? min), min, max);
            hi = clamp(Number(brush[mapping[1]] ?? max), min, max);
        } else {
            const raw = brush[ui.key];
            const arr = Array.isArray(raw) ? raw : [];
            lo = clamp(Number(arr[0] ?? min), min, max);
            hi = clamp(Number(arr[1] ?? max), min, max);
        }

        const el = row();
        el.innerHTML = `
            <div style="${ROW_HDR_CSS}">
                <span style="${LABEL_CSS}">${ui.name}</span>
                <span style="${VAL_CSS}">${fmt(lo, intMode)} – ${fmt(hi, intMode)}</span>
            </div>
            ${dualSliderHTML(min, max, intMode ? 1 : 0.01, lo, hi)}`;

        const valEl = el.querySelector<HTMLElement>('div > span:last-child')!;
        wireDualSlider(el, min, max, intMode, (a, b) => {
            valEl.textContent = `${fmt(a, intMode)} – ${fmt(b, intMode)}`;
            if (mapping) {
                brush[mapping[0]] = intMode ? Math.round(a) : r2(a);
                brush[mapping[1]] = intMode ? Math.round(b) : r2(b);
            } else {
                brush[ui.key] = intMode ? [Math.round(a), Math.round(b)] : [r2(a), r2(b)];
            }
            onChange();
        });
        return el;
    }

    // ── segmented ────────────────────────────────────────────────────────────

    private _buildSegmented(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void): HTMLElement {
        const opts = strRange(ui);
        const val = String(brush[ui.key] ?? opts[0] ?? '');
        const el = row();
        el.innerHTML = `
            <span style="${LABEL_CSS}">${ui.name}</span>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
                ${opts.map(o => `<button data-v="${o}" style="${segBtnCSS(o === val)}">${o}</button>`).join('')}
            </div>`;
        el.querySelectorAll<HTMLButtonElement>('button').forEach(btn => {
            btn.addEventListener('click', () => {
                el.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.style.cssText = segBtnCSS(false));
                btn.style.cssText = segBtnCSS(true);
                brush[ui.key] = btn.dataset.v!;
                onChange();
            });
        });
        return el;
    }

    // ── picker ────────────────────────────────────────────────────────────────

    private _buildPicker(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void): HTMLElement {
        const opts = strRange(ui);
        const val = String(brush[ui.key] ?? opts[0] ?? '');
        const el = row('be-row-picker');
        el.style.cssText = ROW_CSS + 'display:flex;align-items:center;justify-content:space-between;';
        el.innerHTML = `
            <span style="${LABEL_CSS}">${ui.name}</span>
            <select style="${SELECT_CSS}">
                ${opts.map(o => `<option value="${o}"${o === val ? ' selected' : ''}>${o}</option>`).join('')}
            </select>`;
        el.querySelector('select')!.addEventListener('change', e => {
            brush[ui.key] = (e.target as HTMLSelectElement).value;
            onChange();
        });
        return el;
    }

    // ── expression (accordion) ────────────────────────────────────────────────

    private _buildExpression(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void): HTMLElement {
        const [min, max] = numRange(ui);

        const el = document.createElement('div');
        el.style.cssText = `border-bottom:1px solid #2a2a2a;`;

        const hdr = document.createElement('div');
        hdr.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:10px 0;cursor:pointer;user-select:none;`;
        el.appendChild(hdr);

        const body = document.createElement('div');
        body.style.cssText = `display:none;padding-bottom:8px;`;
        el.appendChild(body);

        const getExpr = (): IBrushExpression => {
            const raw = brush[ui.key] as Partial<IBrushExpression> | undefined;
            return {
                min: Number(raw?.min ?? min),
                max: Number(raw?.max ?? max),
                sources: raw?.sources ?? [],
            };
        };

        const setExpr = (expr: IBrushExpression) => {
            brush[ui.key] = expr;
            onChange();
        };

        const render = () => {
            const expr = getExpr();
            const lo = clamp(expr.min, min, max);
            const hi = clamp(expr.max, min, max);

            const isOpen = body.style.display !== 'none';

            // header
            const srcTags = expr.sources.length > 0
                ? expr.sources.map(s => `<span style="${TAG_CSS}">${s.exclusiveStylusSource ?? s.type}</span>`).join('')
                : `<span style="${TAG_CSS}color:#555;">fixed</span>`;

            hdr.innerHTML = `
                <span style="${LABEL_CSS}margin-bottom:0;">${ui.name}</span>
                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    <span style="font-size:11px;color:#7a9fc0;">${fmt(lo, false)} – ${fmt(hi, false)}</span>
                    <div style="display:flex;gap:3px;">${srcTags}</div>
                    <span style="font-size:10px;color:#666;margin-left:2px;">${isOpen ? '▲' : '▼'}</span>
                </div>`;

            if (!isOpen) return;

            // body
            body.innerHTML = '';

            // RANGE section
            const rangeSection = document.createElement('div');
            rangeSection.style.cssText = EXPR_SECTION_CSS;
            rangeSection.innerHTML = `
                <div style="${EXPR_SECTION_HDR_CSS}">
                    <span style="font-size:10px;font-weight:700;color:#666;letter-spacing:.8px;">RANGE</span>
                    <span style="${VAL_CSS}">${fmt(lo, false)} – ${fmt(hi, false)}</span>
                </div>
                ${dualSliderHTML(min, max, 0.01, lo, hi)}`;

            wireDualSlider(rangeSection, min, max, false, (a, b) => {
                rangeSection.querySelector<HTMLElement>('div > span:last-child')!.textContent = `${fmt(a, false)} – ${fmt(b, false)}`;
                const cur = getExpr();
                setExpr({ min: r2(a), max: r2(b), sources: cur.sources });
                hdr.querySelector<HTMLElement>('div > span:first-child')!.textContent = `${fmt(a, false)} – ${fmt(b, false)}`;
            });
            body.appendChild(rangeSection);

            // SOURCE sections
            expr.sources.forEach((_src, idx) => {
                body.appendChild(this._buildSourceSection(ui, idx, min, max, brush, getExpr, setExpr, render));
            });

            // Add Source button
            if (expr.sources.length < 4) {
                const addWrap = document.createElement('div');
                addWrap.style.cssText = `padding:6px 0 2px;`;
                addWrap.innerHTML = `<button style="${ADD_BTN_CSS}">+ Add Source</button>`;
                addWrap.querySelector('button')!.addEventListener('click', () => {
                    const cur = getExpr();
                    const newSrc: IBrushExpressionSource = {
                        type: ExpressionSourceType.FIXED_VALUE,
                        operation: ExpressionOperation.PLUS,
                        value: 1,
                        weight: 1,
                        exclusiveStylusSource: ExpressionExclusiveStylusSource.DEFAULT,
                    };
                    setExpr({ min: cur.min, max: cur.max, sources: [...cur.sources, newSrc] });
                    render();
                });
                body.appendChild(addWrap);
            }
        };

        hdr.addEventListener('click', () => {
            const opening = body.style.display === 'none';
            body.style.display = opening ? 'block' : 'none';
            render();
        });

        render();
        return el;
    }

    private _buildSourceSection(
        ui: UIInfo,
        idx: number,
        _min: number,
        _max: number,
        brush: Record<string, unknown>,
        getExpr: () => IBrushExpression,
        setExpr: (e: IBrushExpression) => void,
        rerender: () => void,
    ): HTMLElement {
        const src = { ...getExpr().sources[idx] };

        const sec = document.createElement('div');
        sec.style.cssText = EXPR_SECTION_CSS;

        const upBtn = idx > 0 ? `<button class="src-up" style="${SRC_BTN_CSS}">↑</button>` : '';
        const delBtn = `<button class="src-del" style="${SRC_BTN_CSS}color:#e07070;">✕</button>`;

        const typeOpts = enumOpts(EXPRESSION_SOURCE_TYPES, src.type as ExpressionSourceType);
        const stylusOpts = enumOpts(EXPRESSION_STYLUS_SOURCES, src.exclusiveStylusSource as ExpressionExclusiveStylusSource);

        sec.innerHTML = `
            <div style="${EXPR_SECTION_HDR_CSS}">
                <span style="font-size:10px;font-weight:700;color:#666;letter-spacing:.8px;">SOURCE ${idx + 1}</span>
                <div style="display:flex;gap:4px;">${upBtn}${delBtn}</div>
            </div>
            <div style="${MINI_ROW_CSS}">
                <div style="${ROW_HDR_CSS}"><span style="${LABEL_CSS}margin-bottom:0;">Value</span><span style="${VAL_CSS}">${fmt(src.value, false)}</span></div>
                <input type="range" class="src-value" min="0" max="1" step="0.01" value="${src.value}" style="${RANGE_CSS}">
            </div>
            <div style="${MINI_ROW_CSS}">
                <div style="${ROW_HDR_CSS}"><span style="${LABEL_CSS}margin-bottom:0;">Weight</span><span style="${VAL_CSS}">${fmt(src.weight, false)}</span></div>
                <input type="range" class="src-weight" min="0" max="5" step="0.01" value="${src.weight}" style="${RANGE_CSS}">
            </div>
            <div style="${MINI_ROW_CSS}display:flex;align-items:center;justify-content:space-between;">
                <span style="${LABEL_CSS}margin-bottom:0;">Type</span>
                <select class="src-type" style="${SELECT_CSS}">${typeOpts}</select>
            </div>
            <div style="${MINI_ROW_CSS}display:flex;align-items:center;justify-content:space-between;">
                <span style="${LABEL_CSS}margin-bottom:0;">Stylus</span>
                <select class="src-stylus" style="${SELECT_CSS}">${stylusOpts}</select>
            </div>
            <div style="${MINI_ROW_CSS}">
                <span style="${LABEL_CSS}margin-bottom:0;">Operation</span>
                <div style="display:flex;gap:3px;margin-top:4px;">
                    ${EXPRESSION_OPERATIONS.map(o => `<button class="src-op" data-op="${o}" style="${segBtnCSS(o === src.operation)}">${o}</button>`).join('')}
                </div>
            </div>`;

        const save = () => {
            const cur = getExpr();
            const srcs = [...cur.sources];
            srcs[idx] = { ...src };
            setExpr({ min: cur.min, max: cur.max, sources: srcs });
        };

        (['src-value', 'src-weight'] as const).forEach(cls => {
            const field = cls === 'src-value' ? 'value' : 'weight';
            const input = sec.querySelector<HTMLInputElement>(`.${cls}`)!;
            const valEl = input.previousElementSibling!.querySelector<HTMLElement>('span:last-child')!;
            input.addEventListener('input', () => {
                const v = parseFloat(input.value);
                valEl.textContent = fmt(v, false);
                (src as Record<string, unknown>)[field] = r2(v);
                save();
            });
        });

        sec.querySelector<HTMLSelectElement>('.src-type')!.addEventListener('change', e => {
            src.type = (e.target as HTMLSelectElement).value as ExpressionSourceType;
            save();
        });

        sec.querySelector<HTMLSelectElement>('.src-stylus')!.addEventListener('change', e => {
            src.exclusiveStylusSource = (e.target as HTMLSelectElement).value as ExpressionExclusiveStylusSource;
            save();
        });

        sec.querySelectorAll<HTMLButtonElement>('.src-op').forEach(btn => {
            btn.addEventListener('click', () => {
                sec.querySelectorAll<HTMLButtonElement>('.src-op').forEach(b => { b.style.cssText = segBtnCSS(false); });
                btn.style.cssText = segBtnCSS(true);
                src.operation = btn.dataset.op as ExpressionOperation;
                save();
            });
        });

        sec.querySelector<HTMLButtonElement>('.src-del')!.addEventListener('click', () => {
            const cur = getExpr();
            const srcs = [...cur.sources];
            srcs.splice(idx, 1);
            setExpr({ min: cur.min, max: cur.max, sources: srcs });
            rerender();
        });

        sec.querySelector<HTMLButtonElement>('.src-up')?.addEventListener('click', () => {
            const cur = getExpr();
            const srcs = [...cur.sources];
            [srcs[idx - 1], srcs[idx]] = [srcs[idx], srcs[idx - 1]];
            setExpr({ min: cur.min, max: cur.max, sources: srcs });
            rerender();
        });

        return sec;
    }

    // ── image ─────────────────────────────────────────────────────────────────

    private _buildImage(ui: UIInfo, brush: Record<string, unknown>, onChange: () => void): HTMLElement {
        const raw = brush[ui.key];
        const hasImage = typeof raw === 'string' && raw.length > 0;

        const el = row();
        el.innerHTML = `
            <div style="${ROW_HDR_CSS}margin-bottom:8px;">
                <span style="${LABEL_CSS}margin-bottom:0;">${ui.name}</span>
                <div style="display:flex;gap:4px;">
                    <button class="img-select" style="${IMG_BTN_CSS}">파일 선택</button>
                    <button class="img-dl" style="${IMG_BTN_CSS}" ${hasImage ? '' : 'disabled'}>다운로드</button>
                    <button class="img-del" style="${IMG_BTN_CSS}color:#e07070;" ${hasImage ? '' : 'disabled'}>삭제</button>
                </div>
            </div>
            <div class="img-preview" style="min-height:48px;background:#1a1a1a;border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden;">
                ${hasImage
                    ? `<img src="data:image/png;base64,${raw}" style="max-width:100%;max-height:120px;display:block;">`
                    : `<span style="font-size:11px;color:#555;">none</span>`}
            </div>
            <input type="file" accept="image/*" style="display:none;">`;

        const fileInput = el.querySelector<HTMLInputElement>('input[type=file]')!;
        const selectBtn = el.querySelector<HTMLButtonElement>('.img-select')!;
        const dlBtn     = el.querySelector<HTMLButtonElement>('.img-dl')!;
        const delBtn    = el.querySelector<HTMLButtonElement>('.img-del')!;
        const preview   = el.querySelector<HTMLElement>('.img-preview')!;

        selectBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result as string;
                const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
                preview.innerHTML = `<img src="${dataUrl}" style="max-width:100%;max-height:120px;display:block;">`;
                dlBtn.disabled = false;
                delBtn.disabled = false;
                brush[ui.key] = base64;
                onChange();
            };
            reader.readAsDataURL(file);
            fileInput.value = '';
        });

        dlBtn.addEventListener('click', () => {
            const cur = brush[ui.key];
            if (typeof cur !== 'string' || cur.length === 0) return;
            const a = document.createElement('a');
            a.href = `data:image/png;base64,${cur}`;
            a.download = `${ui.key}.png`;
            a.click();
        });

        delBtn.addEventListener('click', () => {
            preview.innerHTML = `<span style="font-size:11px;color:#555;">none</span>`;
            dlBtn.disabled = true;
            delBtn.disabled = true;
            brush[ui.key] = '';
            onChange();
        });

        return el;
    }
}

// ── CSS constants ──────────────────────────────────────────────────────────────

const ROW_CSS = `padding:10px 0;border-bottom:1px solid #2a2a2a;`;
const ROW_HDR_CSS = `display:flex;align-items:center;justify-content:space-between;`;
const LABEL_CSS = `display:block;font-size:11px;color:#9a9a9a;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;`;
const VAL_CSS = `font-size:11px;color:#7a9fc0;white-space:nowrap;`;
const INPUT_CSS = `width:100%;background:#3a3a3a;border:1px solid #555;border-radius:4px;color:#e0e0e0;padding:5px 8px;font-size:13px;outline:none;box-sizing:border-box;`;
const RANGE_CSS = `width:100%;accent-color:#4a90d9;cursor:pointer;margin-top:6px;`;
const SELECT_CSS = `background:#3a3a3a;border:1px solid #555;border-radius:4px;color:#e0e0e0;padding:4px 6px;font-size:12px;outline:none;max-width:180px;`;
const TAG_CSS = `font-size:10px;background:#2a3a4a;color:#7a9fc0;border-radius:3px;padding:1px 5px;`;
const IMG_BTN_CSS = `background:#3a3a3a;border:1px solid #555;border-radius:3px;color:#ccc;padding:3px 8px;font-size:11px;cursor:pointer;`;
const ADD_BTN_CSS = `background:#2a4a2a;color:#8fbc8f;border:1px solid #4a8a4a;border-radius:3px;padding:4px 10px;font-size:12px;cursor:pointer;width:100%;`;
const SRC_BTN_CSS = `background:none;border:1px solid #444;border-radius:3px;color:#999;padding:2px 6px;font-size:11px;cursor:pointer;`;
const EXPR_SECTION_CSS = `background:#262626;border-radius:4px;padding:8px 10px;margin-bottom:6px;`;
const EXPR_SECTION_HDR_CSS = `display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;`;
const MINI_ROW_CSS = `margin-bottom:6px;`;

// ── helpers ────────────────────────────────────────────────────────────────────

function row(cls?: string): HTMLDivElement {
    const el = document.createElement('div');
    el.style.cssText = ROW_CSS;
    if (cls) el.className = cls;
    return el;
}

function numRange(ui: UIInfo): [number, number] {
    if (ui.valueRange && ui.valueRange.length >= 2)
        return [Number(ui.valueRange[0]), Number(ui.valueRange[1])];
    return [0, 1];
}

function strRange(ui: UIInfo): string[] {
    return (ui.valueRange ?? []).filter(v => typeof v === 'string') as string[];
}

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function fmt(v: number, intMode: boolean): string {
    return intMode ? String(Math.round(v)) : v.toFixed(2);
}

function r2(v: number): number {
    return Math.round(v * 100) / 100;
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function segBtnCSS(active: boolean): string {
    return `background:${active ? '#2a5aa0' : '#333'};border:1px solid ${active ? '#4a7ac0' : '#555'};border-radius:3px;color:${active ? '#fff' : '#bbb'};padding:4px 10px;font-size:11px;cursor:pointer;`;
}

function enumOpts<T extends string>(values: T[], selected: T | undefined): string {
    return values.map(v =>
        `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`
    ).join('');
}

function dualSliderHTML(min: number, max: number, step: number, lo: number, hi: number): string {
    return `
        <div class="be-ds" style="position:relative;height:20px;margin-top:8px;">
            <div style="position:absolute;top:8px;left:0;right:0;height:4px;background:#3a3a3a;border-radius:2px;">
                <div class="be-ds-fill" style="position:absolute;height:100%;background:#4a90d9;border-radius:2px;"></div>
            </div>
            <input type="range" class="be-ds-a" min="${min}" max="${max}" step="${step}" value="${lo}"
                style="position:absolute;width:100%;top:0;left:0;accent-color:#4a90d9;background:transparent;cursor:pointer;pointer-events:auto;appearance:none;-webkit-appearance:none;height:20px;outline:none;">
            <input type="range" class="be-ds-b" min="${min}" max="${max}" step="${step}" value="${hi}"
                style="position:absolute;width:100%;top:0;left:0;accent-color:#4a90d9;background:transparent;cursor:pointer;pointer-events:auto;appearance:none;-webkit-appearance:none;height:20px;outline:none;">
        </div>`;
}

function wireDualSlider(
    el: HTMLElement,
    min: number,
    max: number,
    intMode: boolean,
    onChange: (lo: number, hi: number) => void,
): void {
    const slA  = el.querySelector<HTMLInputElement>('.be-ds-a')!;
    const slB  = el.querySelector<HTMLInputElement>('.be-ds-b')!;
    const fill = el.querySelector<HTMLElement>('.be-ds-fill')!;
    const span = max - min;

    const update = () => {
        let a = parseFloat(slA.value);
        let b = parseFloat(slB.value);
        if (a > b) { slA.value = String(b); a = b; }
        if (b < a) { slB.value = String(a); b = a; }
        if (span > 0) {
            fill.style.left  = ((a - min) / span * 100).toFixed(1) + '%';
            fill.style.width = ((b - a)   / span * 100).toFixed(1) + '%';
        }
        onChange(intMode ? Math.round(a) : a, intMode ? Math.round(b) : b);
    };
    slA.addEventListener('input', update);
    slB.addEventListener('input', update);
    update();
}
