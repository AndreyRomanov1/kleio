import { mount } from 'svelte';
import App from './App.svelte';
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

mount(App, { target: document.getElementById('app')! });
