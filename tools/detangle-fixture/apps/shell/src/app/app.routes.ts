import { loadRemoteModule } from '@nx/module-federation';

export const routes = [
  { path: 'billing', loadChildren: () => loadRemoteModule({ remoteName: 'billing', exposedModule: './Routes' }).then((m) => m.routes) },
  { path: 'reviews', loadChildren: () => loadRemoteModule({ remoteName: 'reviews', exposedModule: './Routes' }).then((m) => m.routes) },
];
