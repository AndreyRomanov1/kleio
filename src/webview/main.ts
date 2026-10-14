import { mount } from 'svelte';
import App from './App.svelte';
import CommitApp from './commit/CommitApp.svelte';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

const target = document.getElementById('app')!;
if (document.body.dataset.view === 'commit') mount(CommitApp, { target });
else mount(App, { target });
