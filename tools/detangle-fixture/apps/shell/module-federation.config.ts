import { ModuleFederationConfig } from '@nx/module-federation';

const config: ModuleFederationConfig = {
  name: 'shell',
  remotes: ['billing', 'reviews'],
  shared: { '@angular/core': { singleton: true }, '@ngrx/store': { singleton: true } },
};

export default config;
