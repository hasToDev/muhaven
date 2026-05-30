import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './muhaven.css'
import ExpectedResult from './components/ExpectedResult.vue'
import TaskMeta from './components/TaskMeta.vue'

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Globally available in every markdown page (no per-page import needed).
    app.component('ExpectedResult', ExpectedResult)
    app.component('TaskMeta', TaskMeta)
  },
}

export default theme
