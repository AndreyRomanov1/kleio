import { mount } from 'svelte';
import App from './App.svelte';
import CommitApp from './commit/CommitApp.svelte';
import PushApp from './push/PushApp.svelte';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

const target = document.getElementById('app')!;
const view = document.body.dataset.view;
if (view === 'commit') mount(CommitApp, { target });
else if (view === 'push') mount(PushApp, { target });
else mount(App, { target });
