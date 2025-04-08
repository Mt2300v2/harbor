import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import checkDiskSpace from 'check-disk-space';
import WebTorrent from 'webtorrent';
import fs from 'fs';
import { execFile, exec, spawn } from 'child_process'; // Import spawn
import { promisify } from 'util';

// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new WebTorrent();

// Get the directory where the executable is located
const appExePath = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
// Define the path for games.json next to the executable
const profileFilePath = path.join(appExePath, 'games.json');
const userDataFilePath = path.join(appExePath, 'user_data.json');

const extractionPaths = new Map(); // Map to track extraction paths for games

// const execPromise = promisify(exec); // No longer needed for extraction

// Function to save the user's profile and library state
function saveProfile(profileData) {
    try {
        // Convert extractionPaths map to a plain JavaScript object
        const extractionPathsData = Object.fromEntries(extractionPaths);
        profileData.extractionPaths = extractionPathsData; // Add to profile data

        fs.writeFileSync(userDataFilePath, JSON.stringify(profileData, null, 2));
        console.log('[Main Process] Profile saved successfully. Data:', profileData);
    } catch (error) {
        console.error('[Main Process] Error saving profile:', error);
    }
}

// Function to load the user's profile and library state
function loadProfile() {
    const defaultProfile = { library: [], user: { name: 'User', level: 0, picture: null, expositors: [] }, extractionPaths: {} }; // Ensure expositors is in default
    try {
        if (!fs.existsSync(userDataFilePath)) {
            console.log('[Main Process] No existing profile found (user_data.json). Returning default profile.');
            return defaultProfile;
        }

        const data = fs.readFileSync(userDataFilePath, 'utf-8');
        // Check if data is empty before parsing
        if (!data || data.trim() === '') {
             console.log('[Main Process] Profile file (user_data.json) is empty. Returning default profile.');
             return defaultProfile;
        }
        const parsedData = JSON.parse(data);
        // Validate the structure
        if (parsedData && typeof parsedData === 'object' && Array.isArray(parsedData.library) && typeof parsedData.user === 'object') {
            console.log('[Main Process] Profile loaded and validated successfully.');

            // Ensure each game in the library has a playtime property
            parsedData.library.forEach(game => {
                game.playtime = game.playtime || 0;
            });

            // Ensure user object has expected properties, provide defaults if missing
            parsedData.user = {
                name: parsedData.user.name || 'User',
                level: parsedData.user.level || 0,
                picture: parsedData.user.picture || null, // Keep null as default if not present
                expositors: Array.isArray(parsedData.user.expositors) ? parsedData.user.expositors : []
            };

            // Load extractionPaths from profile data
            if (parsedData.extractionPaths && typeof parsedData.extractionPaths === 'object') {
                // Convert the plain JavaScript object back to a Map
                for (const gameId in parsedData.extractionPaths) {
                    if (parsedData.extractionPaths.hasOwnProperty(gameId)) {
                        extractionPaths.set(gameId, parsedData.extractionPaths[gameId]);
                    }
                }
                console.log('[Main Process] Extraction paths loaded from profile.');
            }

            // Send playtime data to the renderer process
            BrowserWindow.getAllWindows().forEach(win => {
                win.webContents.send('profile-loaded', parsedData.library);
            });

            return parsedData;
        } else {
            console.warn('[Main Process] Loaded profile data (user_data.json) has invalid structure. Returning default profile.');
            return defaultProfile;
        }
    } catch (error) {
        console.error('[Main Process] Error loading or parsing profile (user_data.json):', error);
        return defaultProfile;
    }
}

// Function to determine the root drive based on the platform
function getDriveRoot() {
    const platform = process.platform;
    console.log(`Detected platform: ${platform}`);
    if (platform === 'win32') {
        console.log('Returning "C:" for Windows drive root.');
        return 'C:'; // Common default for Windows
    } else {
        console.log('Returning "/" for POSIX drive root.');
        return '/'; // Root for macOS/Linux
    }
}

// --- IPC Handler for Disk Space ---
async function handleGetDiskSpace() {
    const drive = getDriveRoot();
    console.log(`[Main Process] Received request for disk space on drive: ${drive}`);
    try {
        const diskSpace = await checkDiskSpace(drive);
        if (!diskSpace || typeof diskSpace.free !== 'number' || typeof diskSpace.size !== 'number') {
             console.error(`[Main Process] Invalid data received from checkDiskSpace for ${drive}:`, diskSpace);
             return null;
        }
        console.log(`[Main Process] Disk space check successful for ${drive}: Free = ${diskSpace.free}, Total = ${diskSpace.size}`);
        return { free: diskSpace.free, total: diskSpace.size };
    } catch (error) {
        console.error(`[Main Process] Error checking disk space for drive ${drive}:`, error);
        return null;
    }
}

// --- Main Window Creation ---
function createWindow() {
    console.log('[Main Process] Creating browser window...');
    const win = new BrowserWindow({
        width: 1280, // Slightly wider for better fit with sidebar
        height: 800,
        // --- Make window frameless ---
        frame: false,             // Remove standard frame (title bar, borders)
        titleBarStyle: 'hidden', // Hide title bar on macOS (works well with frame:false)
        // transparent: true,     // Optional: if background styling needs it, can cause perf issues
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        show: false, // Don't show until ready
         backgroundColor: '#0d1117' // Match body background to avoid white flash
    });

    // Load HTML file
    win.loadFile('index.html')
      .then(() => console.log('[Main Process] index.html loaded successfully.'))
      .catch(err => console.error('[Main Process] Error loading index.html:', err));

    // Show window when ready
    win.once('ready-to-show', () => {
      console.log('[Main Process] Window ready to show.');
      win.show();
      // Optional: Open DevTools
      // win.webContents.openDevTools();
    });

    win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error(`[Main Process] Failed to load page: ${errorDescription} (Code: ${errorCode})`);
    });

     win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        const levelStr = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] || 'UNKNOWN';
        console.log(`[Renderer Console - ${levelStr}] ${message} (Source: ${path.basename(sourceId)}:${line})`);
    });


    // --- IPC Handlers for Window Controls ---
    ipcMain.on('minimize-window', (event) => {
        const win = BrowserWindow.getFocusedWindow();
        win?.minimize();
    });

    ipcMain.on('maximize-restore-window', (event) => {
        const win = BrowserWindow.getFocusedWindow();
        if (win?.isMaximized()) {
            win.unmaximize();
        } else {
            win?.maximize();
        }
    });

    ipcMain.on('close-window', (event) => {
        const win = BrowserWindow.getFocusedWindow();
        win?.close();
    });

} // End createWindow

// --- App Lifecycle ---
app.whenReady().then(() => {
    console.log('[Main Process] App ready.');

    // Set up Disk Space handler *before* window creation
    ipcMain.handle('get-disk-space', handleGetDiskSpace);
    console.log('[Main Process] IPC handler "get-disk-space" registered.');

    ipcMain.handle('start-torrent-download', async (event, magnetURI, gameId) => {
        console.log(`[Main Process] Starting torrent download for: ${magnetURI}`);

        if (!gameId || typeof gameId !== 'string') {
            console.error('[Main Process] Invalid gameId provided:', gameId);
            return { success: false, message: 'Invalid gameId' };
        }

        return new Promise((resolve) => {
            const downloadPath = path.join(app.getPath('downloads'), gameId);
            const torrent = client.add(magnetURI, { path: downloadPath });

            torrent.on('download', () => {
                if (event.sender.isDestroyed()) {
                    console.warn('[Main Process] Renderer process is destroyed, stopping updates.');
                    return;
                }

                const progress = isNaN(torrent.progress) ? 0 : torrent.progress * 100;
                const downloadSpeed = torrent.downloadSpeed / 1024; // Convert to KB/s
                const uploaded = torrent.uploaded / (1024 * 1024); // Convert to MB
                const peers = torrent.numPeers;
                const totalSize = torrent.length / (1024 * 1024); // Convert to MB

                event.sender.send('torrent-progress', {
                    progress: progress.toFixed(2),
                    downloadSpeed: downloadSpeed.toFixed(2),
                    uploaded: uploaded.toFixed(2),
                    peers,
                    totalSize: totalSize.toFixed(2),
                });
            });

            torrent.on('done', async () => {
                console.log(`[Main Process] Torrent download completed for game: ${gameId}`);
                client.remove(torrent, async (err) => {
                    if (err) {
                        console.error(`[Main Process] Error destroying torrent for game: ${gameId}`, err);
                        reject({ success: false, message: 'Failed to stop torrent' });
                        return;
                    }
                    console.log(`[Main Process] Torrent destroyed for game: ${gameId}`);
                    
                    // Trigger the extraction process (now returns a promise)
                    handleExtraction(downloadPath, gameId, event)
                        .then(() => {
                            console.log(`[Main Process] Extraction promise resolved for game: ${gameId}`);
                            resolve({ success: true, message: 'Download and extraction completed' });
                        })
                        .catch((err) => {
                            console.error(`[Main Process] Error during extraction for game: ${gameId}`, err);
                            event.sender.send('decompression-error', { gameId, message: err.message || 'Extraction failed' });
                            reject({ success: false, message: 'Extraction failed' });
                        });
                });
            });

            torrent.on('error', (err) => {
                console.error(`[Main Process] Torrent error: ${err.message}`);
                reject({ success: false, message: err.message });
            });
        });
    });

    function handleExtraction(downloadPath, gameId, event) {
        return new Promise(async (resolve, reject) => {
            try {
                const files = await fs.promises.readdir(downloadPath);
                const rarFile = files.find(file => file.endsWith('.rar'));

                if (!rarFile) {
                    return reject(new Error('No .rar file found in the download directory'));
                }

                const archivePath = path.join(downloadPath, rarFile);
                const extractionDir = path.join(downloadPath, 'extracted');
                const sevenZipPath = path.join(__dirname, '7-Zip', '7z.exe');

                if (!fs.existsSync(extractionDir)) {
                    await fs.promises.mkdir(extractionDir, { recursive: true });
                }

                console.log(`[Main Process] Starting extraction: ${archivePath} to ${extractionDir}`);
                event.sender.send('decompression-start', { gameId }); // Send start event

                const args = ['x', archivePath, `-o${extractionDir}`, '-y', '-bsp1']; // x=extract, -o=output dir, -y=yes to all, -bsp1=send progress to stdout
                const sevenZipProcess = spawn(sevenZipPath, args); // Removed shell: true and quotes around sevenZipPath

                let lastPercentage = 0;

                sevenZipProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    // Regex to find percentage, potentially preceded by backspaces
                    const match = output.match(/(\d{1,3})%/);
                    if (match && match[1]) {
                        const percentage = parseInt(match[1], 10);
                        if (percentage >= lastPercentage) { // Avoid duplicate or decreasing percentages
                             console.log(`[7z Output] Progress: ${percentage}%`);
                             if (!event.sender.isDestroyed()) {
                                event.sender.send('decompression-progress', { gameId, progress: percentage });
                             }
                             lastPercentage = percentage;
                        }
                    }
                });

                sevenZipProcess.stderr.on('data', (data) => {
                    console.error(`[7z Stderr] ${data}`);
                    // Don't necessarily reject on stderr, 7z might print warnings
                });

                sevenZipProcess.on('close', async (code) => {
                    console.log(`[Main Process] 7z process exited with code ${code} for game ${gameId}`);
                    if (code !== 0) {
                        return reject(new Error(`7-Zip extraction failed with code ${code}`));
                    }

                    try {
                        // Verify extraction and find executable
                        const extractedFiles = await fs.promises.readdir(extractionDir);
                        if (extractedFiles.length === 0) {
                            throw new Error('No files found after extraction');
                        }
                        const execFile = findExecutable(extractionDir, 'Terraria.exe'); // Adjust target executable if needed
                        if (!execFile) {
                            throw new Error('Target executable not found in extracted files');
                        }

                        // Save path and notify completion
                        extractionPaths.set(gameId, { path: extractionDir, execTarget: execFile });
                        if (!event.sender.isDestroyed()) {
                            event.sender.send('decompression-complete', { gameId });
                            // Removed the 'hide-download-bar' event
                        }
                        console.log(`[Main Process] Extraction successful and verified for game: ${gameId}`);
                        resolve(); // Resolve the promise on success
                    } catch (verificationError) {
                        console.error(`[Main Process] Extraction verification failed for game ${gameId}:`, verificationError);
                        reject(verificationError); // Reject if verification fails
                    }
                });

                sevenZipProcess.on('error', (err) => {
                    console.error(`[Main Process] Failed to start 7z process for game ${gameId}:`, err);
                    reject(new Error(`Failed to start 7-Zip process: ${err.message}`));
                });

            } catch (err) {
                console.error(`[Main Process] Error preparing extraction for game ${gameId}:`, err);
                reject(new Error(`Extraction preparation failed: ${err.message}`));
            }
        });
    }

    // Helper function to find the executable file recursively
    function findExecutable(directory, targetExe) {
        try {
            const files = fs.readdirSync(directory, { withFileTypes: true });
            
            // First look for targetExe directly
            for (const file of files) {
                const filePath = path.join(directory, file.name);
                if (file.isFile() && file.name.toLowerCase() === targetExe.toLowerCase()) {
                    console.log(`[Main Process] Found target executable: ${filePath}`);
                    return filePath;
                }
            }

            // Then search recursively in subdirectories
            for (const file of files) {
                const filePath = path.join(directory, file.name);
                if (file.isDirectory()) {
                    const execFile = findExecutable(filePath, targetExe);
                    if (execFile) return execFile;
                }
            }
            return null;
        } catch (err) {
            console.error(`[Main Process] Error searching for executable in ${directory}:`, err);
            return null;
        }
    }

    ipcMain.handle('launch-game', async (event, gameId) => {
        try {
            const gameData = extractionPaths.get(gameId);
            if (!gameData || !gameData.execTarget) {
                console.error(`[Main Process] No executable path found for game: ${gameId}`);
                return { success: false, message: 'Game executable not found' };
            }

            console.log(`[Main Process] Attempting to launch game: ${gameId}`);
            console.log(`[Main Process] Executable path: ${gameData.execTarget}`);
            
            // Change working directory to executable's directory to avoid DLL issues
            const execDir = path.dirname(gameData.execTarget);
            const execName = path.basename(gameData.execTarget);
            
            return new Promise((resolve) => {
                const startTime = Date.now();
                console.log(`[Main Process] Game ${gameId} launched at: ${new Date(startTime).toLocaleString()}`);
                execFile(execName, [], { cwd: execDir }, (error) => {
                    const endTime = Date.now();
                    const playtimeMs = endTime - startTime;
                    const playtimeSec = Math.round(playtimeMs / 1000); // Convert to seconds
                    console.log(`[Main Process] Game ${gameId} exited at: ${new Date(endTime).toLocaleString()}`);
                    console.log(`[Main Process] Game ${gameId} playtime: ${playtimeSec} seconds`);

                    // Load the user profile
                    const profileData = loadProfile();

                    // Find the game in the library and update the playtime
                    const gameIndex = profileData.library.findIndex(game => game.id === gameId);
                    if (gameIndex !== -1) {
                        profileData.library[gameIndex].playtime = (profileData.library[gameIndex].playtime || 0) + playtimeSec;
                    } else {
                        console.warn(`[Main Process] Game ${gameId} not found in library.`);
                    }

                    // Save the updated profile
                    saveProfile(profileData);

                    if (error) {
                        console.error(`[Main Process] Error launching game: ${gameId}`, error);
                        resolve({ success: false, message: `Launch failed: ${error.message}` });
                        return;
                    }
                    console.log(`[Main Process] Game launched successfully: ${gameId}`);
                    resolve({ success: true, message: 'Game launched successfully' });
                
                    // Send playtime update to renderer
                    console.log('[Main Process] Sending update-playtime message for game:', gameId);
                    BrowserWindow.getAllWindows().forEach(win => {
                        win.webContents.send('update-playtime', { gameId: gameId });
                    });
                });
            });
        } catch (err) {
            console.error(`[Main Process] Launch error for game ${gameId}:`, err);
            return { success: false, message: `Launch error: ${err.message}` };
        }
    });

    ipcMain.handle('save-profile', (event, profileData) => {
        console.log('[Main Process] Saving profile data:', profileData);
        saveProfile(profileData);
    });

    ipcMain.handle('load-profile', () => {
        return loadProfile();
    });

    ipcMain.handle('get-game-playtime', async (event, gameId) => {
        const profileData = loadProfile();
        const game = profileData.library.find(game => game.id === gameId);
        console.log('[Main Process] get-game-playtime: gameId =', gameId, 'playtime =', game?.playtime);
        if (game) {
            return game.playtime || 0;
        } else {
            console.warn(`[Main Process] Game ${gameId} not found in library.`);
            return 0;
        }
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            console.log('[Main Process] App activated, creating new window.');
            createWindow();
        } else {
            console.log('[Main Process] App activated, window already exists.');
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            console.log('[Main Process] All windows closed, quitting app.');
            app.quit();
        } else {
            console.log('[Main Process] All windows closed, staying active on macOS.');
        }
    });

    process.on('uncaughtException', (error) => {
      console.error('[Main Process] Uncaught Exception:', error);
    });
});