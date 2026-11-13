import { startSidebar } from './sidebar-context.js';

startSidebar({ chrome, document,
    loadNormal: () => import('./sidebar.js'),
    loadPrivate: () => import('./private-sidebar.js')
});
