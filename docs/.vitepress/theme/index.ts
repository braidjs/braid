import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Mermaid from './Mermaid.vue';
import BrowserMock from './BrowserMock.vue';
import Mfe from './Mfe.vue';
import MechanismChooser from './MechanismChooser.vue';
import './guide.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Mermaid', Mermaid);
    // the scenario guides' mock browser windows, fragments, and the "which mechanism" chooser
    app.component('BrowserMock', BrowserMock);
    app.component('Mfe', Mfe);
    app.component('MechanismChooser', MechanismChooser);
  },
} satisfies Theme;
