import type { IntentCandidate, IntentResolverHook } from './agent.js';

export interface DialogResolverOptions {
  /**
   * Shows "Remember my choice", and answers with `remember: true` when it is ticked. Off by
   * default: the agent keeps nothing, so offer it only when the hook is wrapped by something that
   * does — the console workspace's `intentResolver`.
   */
  remember?: boolean;
}

/**
 * The built-in intent resolver: a modal `<dialog>` listing the candidates. Keyboard-usable as a
 * dialog is — Tab between choices, Enter to pick, Escape to cancel — and announced by its heading.
 * It lives in a shadow root of its own, so the page's styles do not reach it.
 */
export function dialogResolver(document: Document, options: DialogResolverOptions = {}): IntentResolverHook {
  return ({ candidates, context }) =>
    new Promise((resolve) => {
      const host = document.createElement('braid-intent-resolver');
      const root = host.attachShadow({ mode: 'open' });
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-labelledby', 'title');
      const intents = [...new Set(candidates.map((candidate) => candidate.intent))];

      const style = document.createElement('style');
      style.textContent = `
        dialog { font: 14px/1.4 system-ui, sans-serif; border: 1px solid #8886; border-radius: 8px; padding: 16px; min-width: 280px; max-width: 420px; color: CanvasText; background: Canvas; }
        dialog::backdrop { background: #0004; }
        h2 { font-size: 15px; margin: 0 0 4px; }
        p { margin: 0 0 12px; color: GrayText; }
        ul { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 4px; }
        button { font: inherit; width: 100%; text-align: start; padding: 8px 10px; border: 1px solid #8886; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; display: flex; gap: 8px; align-items: center; }
        button:hover { background: #8882; }
        button:focus-visible { outline: 2px solid Highlight; outline-offset: 1px; }
        img { width: 20px; height: 20px; }
        .note { margin-inline-start: auto; color: GrayText; font-size: 12px; }
        footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
        footer button { width: auto; margin-inline-start: auto; }
      `;

      const title = document.createElement('h2');
      title.id = 'title';
      title.textContent = intents.length === 1 ? `Open with…` : 'Choose an action';
      const detail = document.createElement('p');
      detail.textContent = intents.length === 1 ? `${intents[0]} · ${context?.type ?? ''}` : String(context?.type ?? '');

      const list = document.createElement('ul');
      candidates.forEach((candidate, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.index = String(index);
        if (candidate.icon && /^https:/i.test(candidate.icon)) {
          const icon = document.createElement('img');
          icon.src = candidate.icon;
          icon.alt = '';
          button.append(icon);
        }
        const name = document.createElement('span');
        name.textContent = intents.length === 1 ? candidate.title : `${candidate.title} — ${candidate.intent}`;
        const note = document.createElement('span');
        note.className = 'note';
        const state = candidate.instanceId ? 'open' : candidate.starting ? 'starting' : 'new';
        note.textContent = state;
        button.append(name, note);
        const spoken = { open: 'already open', starting: 'starting', new: 'opens a new one' }[state];
        button.setAttribute('aria-label', `${name.textContent}, ${spoken}`);
        if (index === 0) button.autofocus = true;
        item.append(button);
        list.append(item);
      });

      const footer = document.createElement('footer');
      const label = document.createElement('label');
      const remember = document.createElement('input');
      remember.type = 'checkbox';
      remember.name = 'remember';
      label.append(remember, ' Remember my choice');
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.dataset.cancel = '';
      footer.append(...(options.remember ? [label] : []), cancel);

      dialog.append(title, detail, list, footer);
      root.append(style, dialog);

      let answer: { candidate: IntentCandidate; remember?: boolean } | undefined;
      dialog.addEventListener('click', (event) => {
        const button = (event.target as Element).closest?.('button');
        if (!button) return;
        if (button.dataset.index !== undefined) {
          answer = { candidate: candidates[Number(button.dataset.index)], ...(options.remember ? { remember: remember.checked } : {}) };
        }
        dialog.close();
      });
      // Escape, or the dialog closed any other way, is a cancel unless a choice was made
      dialog.addEventListener('close', () => {
        host.remove();
        resolve(answer);
      });

      document.body.append(host);
      dialog.showModal();
    });
}
