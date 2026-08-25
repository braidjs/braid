import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { defineFragment, type FragmentEnv, type FragmentContract } from '@braidlabs/core';

/**
 * The React guest binding: a contract-mode fragment, in about as much code as it should take.
 *
 * ```tsx
 * // main.tsx — the fragment's entry module
 * import { defineReactFragment } from '@braidlabs/react';
 * import { App } from './app';
 *
 * defineReactFragment({
 *   contract: { version: '1.0.0' },
 *   render: (env) => <App basePath={env.location.basePath} />,
 * });
 * ```
 *
 * Note there is no `document`, no `window` patching and no router adapter here. That is the point of
 * contract mode: the fragment renders into `env.root`, learns its base path from `env.location`, and
 * unmounts on `env.signal`. Everything compat mode has to manufacture, this simply does not need.
 *
 * Router integration is deliberately left to the application. React has no single router, and a
 * binding that picked one would be wrong for most fragments — `env.location` and `env.history` are
 * the two things any of them can be configured from, and they are on the env the render function
 * receives.
 */

export interface ReactFragmentOptions {
  contract?: FragmentContract;
  /** Renders the fragment's tree. Re-invoked when the host changes props. */
  render(env: FragmentEnv): ReactNode;
}

export function defineReactFragment(options: ReactFragmentOptions): void {
  defineFragment({
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    mount(env: FragmentEnv) {
      const root: Root = createRoot(env.root);
      root.render(createElement(Wrapper, { env, render: options.render }));

      /**
       * Unmounted on `signal`, which fires only after every `onClosing` handler has settled. A
       * React tree torn down before its effects have flushed is how an in-flight save becomes a
       * "setState on an unmounted component" warning and a lost write.
       */
      env.signal.addEventListener('abort', () => root.unmount(), { once: true });

      // Props changes re-render rather than remount: a remount would discard component state the
      // user is looking at, which is the wrong response to a prop the host adjusted.
      env.onPropsChanged(() => root.render(createElement(Wrapper, { env, render: options.render })));
    },
  });
}

function Wrapper({ env, render }: { env: FragmentEnv; render: (env: FragmentEnv) => ReactNode }): ReactNode {
  return render(env);
}
