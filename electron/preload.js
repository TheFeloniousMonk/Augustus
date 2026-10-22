const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('augustus', {
    platform: process.platform,
    isElectron: true,
    getDataDir: () => ipcRenderer.invoke('get-data-dir'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    claudeExtension: {
        check: () => ipcRenderer.invoke('check-claude-extension'),
        install: (dataDir) => ipcRenderer.invoke('install-claude-extension', dataDir),
        uninstall: () => ipcRenderer.invoke('uninstall-claude-extension'),
    },
    updates: {
        checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
        downloadUpdate: () => ipcRenderer.invoke('download-update'),
        installUpdate: () => ipcRenderer.invoke('install-update'),
        onUpdateAvailable: (cb) => {
            ipcRenderer.on('update-available', (_, info) => cb(info));
        },
        onUpdateNotAvailable: (cb) => {
            ipcRenderer.on('update-not-available', () => cb());
        },
        onDownloadProgress: (cb) => {
            ipcRenderer.on('download-progress', (_, progress) => cb(progress));
        },
        onUpdateDownloaded: (cb) => {
            ipcRenderer.on('update-downloaded', () => cb());
        },
        onUpdateError: (cb) => {
            ipcRenderer.on('update-error', (_, err) => cb(err));
        },
        removeAllListeners: () => {
            ['update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'update-error']
                .forEach(ch => ipcRenderer.removeAllListeners(ch));
        }
    }
});
