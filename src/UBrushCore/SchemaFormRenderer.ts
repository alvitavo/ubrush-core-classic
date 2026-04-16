// Renders HTML form controls from a JSON schema definition.
// Supports: string, number, integer, boolean, object (nested), array (add/remove items).
// Handles uiSchema hints: "ui:widget": "range" | "radio" | "color".

const S = {
    label: `display:block; font-size:11px; color:#9a9a9a; margin-bottom:3px; font-weight:600; text-transform:uppercase; letter-spacing:.5px;`,
    row: `margin-bottom:14px;`,
    input: `width:100%; background:#3a3a3a; border:1px solid #555; border-radius:4px; color:#e0e0e0; padding:5px 8px; font-size:13px; outline:none;`,
    range: `width:100%; accent-color:#4a90d9; cursor:pointer;`,
    rangeVal: `font-size:11px; color:#7a9fc0; margin-left:6px;`,
    checkbox: `margin-right:6px; accent-color:#4a90d9; cursor:pointer;`,
    radioWrap: `display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;`,
    radioLabel: `display:flex; align-items:center; font-size:12px; color:#ccc; cursor:pointer; background:#333; border:1px solid #555; border-radius:3px; padding:3px 7px; gap:4px;`,
    fieldset: `border:1px solid #444; border-radius:5px; padding:10px; margin-top:4px;`,
    legend: `font-size:11px; color:#7a9fc0; padding:0 6px;`,
    arrayItem: `background:#2e2e2e; border:1px solid #444; border-radius:4px; padding:8px; margin-bottom:8px; position:relative;`,
    removeBtn: `position:absolute; top:6px; right:6px; background:#7a2020; color:#fff; border:none; border-radius:3px; padding:2px 7px; font-size:11px; cursor:pointer;`,
    addBtn: `background:#2a4a2a; color:#8fbc8f; border:1px solid #4a8a4a; border-radius:3px; padding:4px 10px; font-size:12px; cursor:pointer; margin-top:4px;`,
};

export class SchemaFormRenderer {

    render(
        container: HTMLElement,
        schema: any,
        uiSchema: any,
        data: any,
        onChange: () => void
    ): void {
        container.innerHTML = '';
        const props: Record<string, any> = schema.properties || {};
        for (const key of Object.keys(props)) {
            const propSchema = props[key];
            const propUiSchema = (uiSchema && uiSchema[key]) ? uiSchema[key] : {};
            this.renderField(
                container,
                propSchema.title || key,
                propSchema,
                propUiSchema,
                () => data[key],
                (v: any) => { data[key] = v; onChange(); },
                onChange
            );
        }
    }

    private renderField(
        container: HTMLElement,
        title: string,
        schema: any,
        uiSchema: any,
        getValue: () => any,
        setValue: (v: any) => void,
        onChange: () => void
    ): void {
        const type = schema.type;
        switch (type) {
            case 'string':
                this.renderString(container, title, schema, uiSchema, getValue, setValue);
                break;
            case 'number':
            case 'integer':
                this.renderNumber(container, title, schema, uiSchema, getValue, setValue);
                break;
            case 'boolean':
                this.renderBoolean(container, title, getValue, setValue);
                break;
            case 'object':
                this.renderObject(container, title, schema, uiSchema, getValue, setValue, onChange);
                break;
            case 'array':
                this.renderArray(container, title, schema, uiSchema, getValue, setValue, onChange);
                break;
        }
    }

    private renderString(
        container: HTMLElement,
        title: string,
        schema: any,
        uiSchema: any,
        getValue: () => any,
        setValue: (v: any) => void
    ): void {
        const row = div(S.row);

        if (schema.format === 'data-url') {
            row.appendChild(label(title));
            const fileInput = el<HTMLInputElement>('input', `width:100%; font-size:12px; color:#ccc; background:#3a3a3a; border:1px solid #555; border-radius:4px; padding:4px;`);
            fileInput.type = 'file';
            fileInput.accept = (uiSchema['ui:options']?.accept || ['.jpg', '.png']).join(',');
            fileInput.addEventListener('change', () => {
                const file = fileInput.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (e) => setValue(e.target?.result as string);
                reader.readAsDataURL(file);
            });
            row.appendChild(fileInput);

        } else if (schema.enum) {
            row.appendChild(label(title));
            if (uiSchema['ui:widget'] === 'radio') {
                const wrap = div(S.radioWrap);
                for (const opt of schema.enum as string[]) {
                    const lbl = el<HTMLLabelElement>('label', S.radioLabel);
                    const radio = el<HTMLInputElement>('input', '');
                    radio.type = 'radio';
                    radio.name = `radio_${title.replace(/\s/g, '_')}`;
                    radio.value = opt;
                    radio.style.cssText = `margin:0; accent-color:#4a90d9; cursor:pointer;`;
                    radio.checked = getValue() === opt;
                    radio.addEventListener('change', () => { if (radio.checked) setValue(opt); });
                    lbl.appendChild(radio);
                    lbl.appendChild(document.createTextNode(opt));
                    wrap.appendChild(lbl);
                }
                row.appendChild(wrap);
            } else {
                const sel = el<HTMLSelectElement>('select', S.input);
                for (const opt of schema.enum as string[]) {
                    const o = document.createElement('option');
                    o.value = opt;
                    o.textContent = opt;
                    sel.appendChild(o);
                }
                sel.value = getValue() ?? schema.enum[0];
                sel.addEventListener('change', () => setValue(sel.value));
                row.appendChild(sel);
            }

        } else {
            row.appendChild(label(title));
            const inp = el<HTMLInputElement>('input', S.input);
            inp.type = 'text';
            inp.value = getValue() ?? '';
            inp.addEventListener('input', () => setValue(inp.value));
            row.appendChild(inp);
        }

        container.appendChild(row);
    }

    private renderNumber(
        container: HTMLElement,
        title: string,
        schema: any,
        uiSchema: any,
        getValue: () => any,
        setValue: (v: any) => void
    ): void {
        const row = div(S.row);
        const isRange = uiSchema['ui:widget'] === 'range';
        const step = schema.multipleOf ?? (schema.type === 'integer' ? 1 : 0.01);
        const min = schema.minimum ?? 0;
        const max = schema.maximum ?? 1;
        const current = getValue() ?? schema.default ?? min;

        if (isRange) {
            const headerRow = div('display:flex; align-items:center; justify-content:space-between;');
            headerRow.appendChild(label(title));
            const valSpan = el<HTMLSpanElement>('span', S.rangeVal);
            valSpan.textContent = String(current);
            headerRow.appendChild(valSpan);
            row.appendChild(headerRow);

            const range = el<HTMLInputElement>('input', S.range);
            range.type = 'range';
            range.min = String(min);
            range.max = String(max);
            range.step = String(step);
            range.value = String(current);
            range.addEventListener('input', () => {
                const v = parseFloat(range.value);
                valSpan.textContent = v.toFixed(step < 1 ? 2 : 0);
                setValue(v);
            });
            row.appendChild(range);
        } else {
            row.appendChild(label(title));
            const inp = el<HTMLInputElement>('input', S.input);
            inp.type = 'number';
            inp.min = String(min);
            inp.max = String(max);
            inp.step = String(step);
            inp.value = String(current);
            inp.addEventListener('input', () => {
                const v = schema.type === 'integer' ? parseInt(inp.value) : parseFloat(inp.value);
                setValue(isNaN(v) ? 0 : v);
            });
            row.appendChild(inp);
        }

        container.appendChild(row);
    }

    private renderBoolean(
        container: HTMLElement,
        title: string,
        getValue: () => any,
        setValue: (v: any) => void
    ): void {
        const row = div(S.row);
        const lbl = el<HTMLLabelElement>('label', `display:flex; align-items:center; font-size:13px; color:#ccc; cursor:pointer;`);
        const chk = el<HTMLInputElement>('input', '');
        chk.type = 'checkbox';
        chk.style.cssText = S.checkbox;
        chk.checked = !!getValue();
        chk.addEventListener('change', () => setValue(chk.checked));
        lbl.appendChild(chk);
        lbl.appendChild(document.createTextNode(title));
        row.appendChild(lbl);
        container.appendChild(row);
    }

    private renderObject(
        container: HTMLElement,
        title: string,
        schema: any,
        uiSchema: any,
        getValue: () => any,
        setValue: (v: any) => void,
        onChange: () => void
    ): void {
        const row = div(S.row);
        const fs = el<HTMLFieldSetElement>('fieldset', S.fieldset);
        const lg = el<HTMLLegendElement>('legend', S.legend);
        lg.textContent = title;
        fs.appendChild(lg);

        const ensureValue = () => {
            if (getValue() == null) setValue({});
            return getValue();
        };

        const props: Record<string, any> = schema.properties || {};
        for (const key of Object.keys(props)) {
            const propSchema = props[key];
            const propUiSchema = (uiSchema && uiSchema[key]) ? uiSchema[key] : {};
            const objValue = ensureValue();

            if (propSchema.type === 'array') {
                this.renderArray(
                    fs,
                    propSchema.title || key,
                    propSchema,
                    propUiSchema,
                    () => objValue[key],
                    (v: any) => { objValue[key] = v; onChange(); },
                    onChange
                );
            } else {
                this.renderField(
                    fs,
                    propSchema.title || key,
                    propSchema,
                    propUiSchema,
                    () => ensureValue()[key],
                    (v: any) => { ensureValue()[key] = v; onChange(); },
                    onChange
                );
            }
        }

        row.appendChild(fs);
        container.appendChild(row);
    }

    private renderArray(
        container: HTMLElement,
        title: string,
        schema: any,
        uiSchema: any,
        getValue: () => any,
        setValue: (v: any) => void,
        onChange: () => void
    ): void {
        const itemSchema = schema.items;
        if (!itemSchema) return;

        const wrapper = div(`${S.row} padding:8px; background:#262626; border-radius:4px;`);
        const lbl = label(title);
        wrapper.appendChild(lbl);

        const listContainer = div('margin-top:6px;');
        wrapper.appendChild(listContainer);

        const addBtn = el<HTMLButtonElement>('button', S.addBtn);
        addBtn.textContent = '+ Add Item';
        wrapper.appendChild(addBtn);

        const rerender = () => {
            listContainer.innerHTML = '';
            const arr: any[] = getValue() || [];

            arr.forEach((item: any, idx: number) => {
                const itemDiv = div(S.arrayItem);

                const removeBtn = el<HTMLButtonElement>('button', S.removeBtn);
                removeBtn.textContent = '✕';
                removeBtn.addEventListener('click', () => {
                    arr.splice(idx, 1);
                    setValue(arr);
                    onChange();
                    rerender();
                });
                itemDiv.appendChild(removeBtn);

                const indexLabel = el<HTMLSpanElement>('span', `font-size:10px; color:#666; display:block; margin-bottom:6px;`);
                indexLabel.textContent = `Item ${idx + 1}`;
                itemDiv.appendChild(indexLabel);

                if (itemSchema.type === 'object' && itemSchema.properties) {
                    const props: Record<string, any> = itemSchema.properties;
                    const itemUiSchema: any = uiSchema?.items || {};
                    for (const key of Object.keys(props)) {
                        const propSchema = props[key];
                        const propUiSchema = itemUiSchema[key] || {};
                        this.renderField(
                            itemDiv,
                            propSchema.title || key,
                            propSchema,
                            propUiSchema,
                            () => item[key],
                            (v: any) => { item[key] = v; onChange(); },
                            onChange
                        );
                    }
                }

                listContainer.appendChild(itemDiv);
            });
        };

        addBtn.addEventListener('click', () => {
            const arr: any[] = getValue() || [];
            const newItem = buildDefault(itemSchema);
            arr.push(newItem);
            setValue(arr);
            onChange();
            rerender();
        });

        rerender();
        container.appendChild(wrapper);
    }
}

// --- Helpers ---

function el<T extends HTMLElement>(tag: string, css: string): T {
    const e = document.createElement(tag) as T;
    if (css) e.style.cssText = css;
    return e;
}

function div(css: string): HTMLDivElement {
    return el<HTMLDivElement>('div', css);
}

function label(text: string): HTMLLabelElement {
    const l = el<HTMLLabelElement>('label', S.label);
    l.textContent = text;
    return l;
}

function buildDefault(schema: any): any {
    if (schema.type === 'object') {
        const obj: any = {};
        const props: Record<string, any> = schema.properties || {};
        for (const [key, propSchema] of Object.entries<any>(props)) {
            obj[key] = buildDefault(propSchema);
        }
        return obj;
    }
    if (schema.type === 'array') return [];
    if (schema.default !== undefined) return schema.default;
    if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
    if (schema.type === 'string') return schema.enum?.[0] ?? '';
    if (schema.type === 'boolean') return false;
    return null;
}
