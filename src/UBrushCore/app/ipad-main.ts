import { IpadAppRoot } from './ipad/IpadAppRoot';

document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

let lastTap = 0;
document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
        e.preventDefault();
    }
    lastTap = now;
}, { passive: false });

if ('serviceWorker' in navigator && process.env.NODE_ENV !== 'production') {
    navigator.serviceWorker.getRegistrations()
        .then(regs => Promise.all(regs.map(r => r.unregister())))
        .catch(() => {});
    if ('caches' in window) {
        caches.keys()
            .then(keys => Promise.all(keys.map(k => caches.delete(k))))
            .catch(() => {});
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('app');
    if (!root) return;
    new IpadAppRoot().init(root).catch(console.error);
});
