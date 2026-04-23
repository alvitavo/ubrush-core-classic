let deferredPrompt: any = null;

export function createInstallButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = '⬇ 앱 설치';
    applyStyle(btn, false);

    window.addEventListener('beforeinstallprompt', (e: Event) => {
        e.preventDefault();
        deferredPrompt = e;
        applyStyle(btn, true);
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        btn.textContent = '✓ 설치됨';
        btn.disabled = true;
        applyStyle(btn, false);
    });

    btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            btn.textContent = '✓ 설치됨';
            btn.disabled = true;
            applyStyle(btn, false);
        }
        deferredPrompt = null;
    });

    return btn;
}

function applyStyle(btn: HTMLButtonElement, active: boolean): void {
    btn.style.cssText = `
        width: 100%; padding: 9px 12px;
        background: ${active ? '#2a6a3a' : '#2a2a2a'};
        color: ${active ? '#7be07b' : '#666'};
        border: 1px solid ${active ? '#3a7a4a' : '#3a3a3a'};
        border-radius: 5px; font-size: 13px; font-weight: 600;
        cursor: ${active ? 'pointer' : 'default'};
        transition: background .2s, color .2s;
    `;
}
