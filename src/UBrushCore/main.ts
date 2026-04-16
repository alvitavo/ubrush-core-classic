import { App } from './App';

window.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('app')!;
    const app = new App();
    app.init(root);
});
