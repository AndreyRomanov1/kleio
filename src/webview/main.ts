import { mount } from 'svelte';
import App from './App.svelte';
import CommitApp from './commit/CommitApp.svelte';
import PushApp from './push/PushApp.svelte';
import RebaseApp from './rebase/RebaseApp.svelte';
import ConflictsApp from './conflicts/ConflictsApp.svelte';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

const target = document.getElementById('app')!;
const view = document.body.dataset.view;
if (view === 'commit') mount(CommitApp, { target });
else if (view === 'push') mount(PushApp, { target });
else if (view === 'rebase') mount(RebaseApp, { target });
else if (view === 'conflicts') mount(ConflictsApp, { target });
else mount(App, { target });
