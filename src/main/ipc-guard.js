export function assertMainFrameSender(event, mainWindow) {
  const webContents = mainWindow?.webContents;
  if (!webContents || webContents.isDestroyed?.()) throw new Error('Cửa sổ chính không khả dụng');
  if (event?.sender !== webContents || event?.senderFrame !== webContents.mainFrame) {
    throw new Error('IPC request không đến từ renderer chính');
  }
}

export function mainFrameHandler(getMainWindow, listener) {
  return (event, ...args) => {
    assertMainFrameSender(event, getMainWindow());
    return listener(event, ...args);
  };
}
