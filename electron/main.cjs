// Electron shell. Reuses server.cjs on port 0 (the OS picks a free port), so the desktop build
// and the browser build run the same module graph over the same origin — there is no second
// implementation of "serve these files" to drift out of sync with the first.
//
// electron is not a dependency of this repo (`dependencies` and `devDependencies` are both
// empty) and is not needed to play: `npm start` serves the identical game on
// http://127.0.0.1:5196/. This file exists so the packaging step has something to point at, and
// `npm run check` syntax-checks it.
const { app, BrowserWindow } = require('electron');
const { startServer } = require('../server.cjs');

async function createWindow() {
  const server = await startServer({ port: 0 });
  const { port } = server.address();
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#08121a',
    title: '跳蛙渡 · LEAP',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(createWindow).catch((err) => {
  console.error('failed to open the river:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
