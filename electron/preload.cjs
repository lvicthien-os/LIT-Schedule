const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("litDesktop", {
  readLocalFile: () => ipcRenderer.invoke("lit:readLocalFile"),
  writeLocalFile: (payload) => ipcRenderer.invoke("lit:writeLocalFile", payload),
});