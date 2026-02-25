const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Auto-updater — only import if available (won't be in dev without npm install)
let autoUpdater, log;
try {
    autoUpdater = require('electron-updater').autoUpdater;
    log = require('electron-log');
} catch (e) {
    // Not installed in dev — that's fine
}

const DEFAULT_PORT = 8080;
const DEV_FRONTEND_PORT = 5173;
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow = null;
let pythonProcess = null;
let updateCheckTimer = null;
let pythonStderr = [];

function getPort() {
    return process.env.AUGUSTUS_PORT || DEFAULT_PORT;
}

function checkPortInUse(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
            resolve(true);
            req.destroy();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
            resolve(false);
            req.destroy();
        });
    });
}

async function startPythonBackend(port) {
    const alreadyRunning = await checkPortInUse(port);
    if (alreadyRunning) {
        console.log(`Backend already running on port ${port}`);
        return;
    }

    if (app.isPackaged) {
        // Production: look for PyInstaller frozen binary first
        const binaryName = 'augustus' + (process.platform === 'win32' ? '.exe' : '');
        const frozenPath = path.join(process.resourcesPath, 'backend', binaryName);

        if (fs.existsSync(frozenPath)) {
            console.log(`Starting frozen backend binary: ${frozenPath}`);
            pythonProcess = spawn(frozenPath, ['--port', String(port)], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } else {
            // Fallback: use Python interpreter even in production
            console.log(`Frozen binary not found at ${frozenPath}, falling back to Python`);
            const pythonPath = process.env.AUGUSTUS_PYTHON || 'python';
            pythonProcess = spawn(pythonPath, ['-m', 'augustus.main', '--port', String(port)], {
                cwd: path.join(__dirname, '..', 'backend'),
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
    } else {
        // Development: always use Python interpreter
        console.log('Starting Python backend in dev mode');
        const pythonPath = process.env.AUGUSTUS_PYTHON || 'python';
        pythonProcess = spawn(pythonPath, ['-m', 'augustus.main', '--port', String(port)], {
            cwd: path.join(__dirname, '..', 'backend'),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }

    pythonStderr = [];

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        const text = data.toString().trim();
        console.error(`[Python] ${text}`);
        pythonStderr.push(...text.split('\n'));
        // Keep last 50 lines to avoid unbounded growth
        if (pythonStderr.length > 50) pythonStderr.splice(0, pythonStderr.length - 50);
    });

    pythonProcess.on('exit', (code) => {
        console.log(`Python process exited with code ${code}`);
        pythonProcess = null;
    });
}

async function waitForBackend(port, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const ready = await checkPortInUse(port);
        if (ready) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1280,
        minHeight: 720,
        title: 'Augustus',
        icon: path.join(__dirname, '..', 'icons', 'augustus-icon-256.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    const url = isDev
        ? `http://localhost:${DEV_FRONTEND_PORT}`
        : `http://127.0.0.1:${port}`;

    mainWindow.loadURL(url);

    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function buildMenu() {
    const template = [
        {
            label: 'File',
            submenu: [{ role: 'quit' }],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About Augustus',
                    click: () => {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: 'About Augustus',
                            message: 'Augustus - Persistent AI Identity Research Platform',
                            detail: `Version ${app.getVersion()}`,
                        });
                    },
                },
            ],
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function stopPython() {
    if (!pythonProcess) return;

    console.log('Stopping Python backend...');

    // On Windows, use tree-kill pattern to ensure child processes are terminated
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', pythonProcess.pid, '/f', '/t']);
    } else {
        pythonProcess.kill('SIGTERM');

        setTimeout(() => {
            if (pythonProcess) {
                console.log('Force-killing Python backend...');
                pythonProcess.kill('SIGKILL');
            }
        }, 5000);
    }
}

// --- Auto-updater setup ---

function setupAutoUpdater() {
    if (!app.isPackaged || !autoUpdater) {
        console.log('Auto-updater disabled (dev mode or electron-updater not available)');
        return;
    }

    // Configure
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    if (log) {
        autoUpdater.logger = log;
        autoUpdater.logger.transports.file.level = 'info';
    }

    // Forward events to renderer
    autoUpdater.on('update-available', (info) => {
        mainWindow?.webContents.send('update-available', { version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
        mainWindow?.webContents.send('update-not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
        mainWindow?.webContents.send('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', () => {
        mainWindow?.webContents.send('update-downloaded');
    });

    autoUpdater.on('error', (err) => {
        mainWindow?.webContents.send('update-error', err?.message || String(err));
    });

    // Initial check
    autoUpdater.checkForUpdates().catch((err) => {
        console.error('Auto-update check failed:', err);
    });

    // Periodic checks
    updateCheckTimer = setInterval(() => {
        autoUpdater.checkForUpdates().catch((err) => {
            console.error('Auto-update check failed:', err);
        });
    }, UPDATE_CHECK_INTERVAL);
}

// --- First-launch flag ---

function writeFirstLaunchFlag() {
    const metaPath = path.join(app.getPath('userData'), 'install-meta.json');
    if (!fs.existsSync(metaPath)) {
        const meta = {
            firstLaunch: new Date().toISOString(),
            version: app.getVersion(),
        };
        try {
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
            console.log('First-launch flag written:', metaPath);
        } catch (err) {
            console.error('Failed to write first-launch flag:', err);
        }
    }
}

// --- IPC handlers ---

ipcMain.handle('get-data-dir', () => {
    return app.getPath('userData');
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('check-for-update', () => {
    if (autoUpdater && app.isPackaged) {
        return autoUpdater.checkForUpdates();
    }
    return null;
});

ipcMain.handle('download-update', () => {
    if (autoUpdater && app.isPackaged) {
        return autoUpdater.downloadUpdate();
    }
    return null;
});

ipcMain.handle('install-update', () => {
    if (autoUpdater && app.isPackaged) {
        autoUpdater.quitAndInstall();
    }
});

// --- App lifecycle ---

app.on('ready', async () => {
    const port = getPort();
    buildMenu();
    writeFirstLaunchFlag();

    if (!isDev) {
        await startPythonBackend(port);
        const ready = await waitForBackend(port);

        if (!ready) {
            const logDir = app.getPath('logs');
            const stderrTail = pythonStderr.slice(-10).join('\n').trim();
            const detail = stderrTail
                ? `Last error output:\n${stderrTail}\n\nLog directory:\n${logDir}`
                : `Log directory:\n${logDir}`;
            dialog.showMessageBoxSync({
                type: 'error',
                title: 'Backend Error',
                message: 'Could not start the Augustus backend.',
                detail,
                buttons: ['OK'],
            });
            app.quit();
            return;
        }
    }

    createWindow(port);
    setupAutoUpdater();
});

app.on('window-all-closed', () => {
    if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
    }
    stopPython();
    app.quit();
});

app.on('before-quit', () => {
    if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
    }
    stopPython();
});
