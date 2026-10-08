import '@fontsource/chakra-petch/latin-400.css';
import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles.css';
import { App } from './app.js';

declare global {
  interface Window {
    __RP?: App['testApi'];
  }
}

const mount = document.getElementById('stage-inner');
if (!mount) throw new Error('RETRO//PADEL: mount point missing.');

const app = new App(mount);
app.start();
window.__RP = app.testApi;

const note = document.getElementById('stage-note');
if (note) {
  const isTouch = matchMedia('(pointer: coarse)').matches;
  note.textContent = isTouch
    ? 'DRAG THE SCREEN TO STEER · SELECT / START ON THE SHELL'
    : 'W/S MOVE · ENTER SERVE · ESC PAUSE · SELECT MODE · START CONFIRM';
}
