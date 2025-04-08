// preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload Script] Loading...');

contextBridge.exposeInMainWorld('electronAPI', {
    // Disk Space (keep using invoke for async nature)
    getDiskSpace: () => {
        console.log('[Preload Script] Invoking "get-disk-space" in main process...');
        return ipcRenderer.invoke('get-disk-space');
    },

    // Window Controls (use send for fire-and-forget actions)
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeRestoreWindow: () => ipcRenderer.send('maximize-restore-window'),
    closeWindow: () => ipcRenderer.send('close-window'),

    // Torrent Download
    startTorrentDownload: (magnetURI, gameId) => ipcRenderer.invoke('start-torrent-download', magnetURI, gameId),
    onTorrentProgress: (callback) => ipcRenderer.on('torrent-progress', callback),

    // Profile Management
    saveProfile: (profileData) => ipcRenderer.invoke('save-profile', profileData),
    loadProfile: () => ipcRenderer.invoke('load-profile'),

    // Game Launch
    launchGame: (gameId) => ipcRenderer.invoke('launch-game', gameId),
// Add games data loading
loadGamesData: () => {
    return fetch('./games.json').then(r => r.json());
},

// Decompression Events
onDecompressionStart: (callback) => ipcRenderer.on('decompression-start', callback),
onDecompressionProgress: (callback) => ipcRenderer.on('decompression-progress', callback),
onDecompressionComplete: (callback) => ipcRenderer.on('decompression-complete', callback),
    onDecompressionError: (callback) => ipcRenderer.on('decompression-error', callback),
    getGamePlaytime: (gameId) => ipcRenderer.invoke('get-game-playtime', gameId),
    onUpdatePlaytime: (callback) => {
       ipcRenderer.on('update-playtime', (event, data) => {
           console.log('[Preload Script] Received update-playtime message for game:', data.gameId);
           callback(event, data);
       });
    }
});

ipcRenderer.on('update-download-bar', (event, { progress }) => {
    const bottomDownloadSummary = document.getElementById('bottomDownloadSummary');
    const idleStatus = document.getElementById('idleStatus');
    const bottomDownloadPercentage = document.getElementById('bottomDownloadPercentage');
    const bottomDownloadProgressFill = document.getElementById('bottomDownloadProgressFill');

    bottomDownloadSummary.classList.remove('hidden');
    idleStatus.classList.add('hidden');
    bottomDownloadPercentage.textContent = `${progress.toFixed(2)}%`;
    bottomDownloadProgressFill.style.width = `${progress}%`;
});

// Note: The 'torrent-decompressing' listener is removed as 'decompression-start' replaces its function.

ipcRenderer.on('hide-download-bar', () => {
    const bottomDownloadSummary = document.getElementById('bottomDownloadSummary');
    const idleStatus = document.getElementById('idleStatus');
    if (bottomDownloadSummary) {
        bottomDownloadSummary.classList.add('hidden');
        console.log('[Preload] bottomDownloadSummary set to hidden');
    } else {
        console.warn('[Preload] bottomDownloadSummary not found');
    }
    if (idleStatus) {
        // Don't hide idle status here, let the completion logic handle it
        // idleStatus.classList.add('hidden');
        // console.log('[Preload] idleStatus set to hidden');
    } else {
        console.warn('[Preload] idleStatus not found');
    }
});

console.log('[Preload Script] electronAPI exposed on window object.');