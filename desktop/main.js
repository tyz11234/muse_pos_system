// CNKH POS 2.0 desktop shell: a window on the server-hosted web app.
const { app, BrowserWindow } = require('electron');

const POS_URL = process.env.CNKH_POS_URL || 'http://43.156.169.203/pos2/';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(POS_URL);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
