import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api, DiskChange } from '../shared/api.js';

/**
 * The only bridge between the editor and the rest of the machine: a fixed set of named calls. The renderer cannot send
 * any other message, read a file by path, or reach Node.
 */
const invoke = <T>(name: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`mcprep:${name}`, ...args) as Promise<T>;

const api: Api = {
  chooseAndOpenPdf: () => invoke('chooseAndOpenPdf'),
  chooseAndOpenProject: () => invoke('chooseAndOpenProject'),
  openPath: (path) => invoke('openPath', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  recent: () => invoke('recent'),
  readPdf: () => invoke('readPdf'),
  pageText: (page) => invoke('pageText', page),
  propose: (request) => invoke('propose', request),
  deriveOutline: () => invoke('deriveOutline'),
  saveProject: (project, expectedRevision) => invoke('saveProject', project, expectedRevision),
  reloadProject: () => invoke('reloadProject'),
  exportBundle: (options) => invoke('exportBundle', options),
  copyToFolder: (path) => invoke('copyToFolder', path),
  reveal: (path) => invoke('reveal', path),
  onDiskChange: (listener) => {
    const handler = (_event: unknown, change: DiskChange): void => listener(change);
    ipcRenderer.on('mcprep:diskChange', handler);
    return () => ipcRenderer.removeListener('mcprep:diskChange', handler);
  },
  onMenu: (listener) => {
    const handler = (_event: unknown, command: string): void => listener(command);
    ipcRenderer.on('mcprep:menu', handler);
    return () => ipcRenderer.removeListener('mcprep:menu', handler);
  },
  setDirty: (dirty) => ipcRenderer.send('mcprep:setDirty', dirty),
};

contextBridge.exposeInMainWorld('mcprep', api);
