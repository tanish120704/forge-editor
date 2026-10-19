const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  chooseFolder:()=>ipcRenderer.invoke('choose-folder'),
  onCommand:callback=>{const listener=(_event,action)=>callback(action);ipcRenderer.on('command',listener);return()=>ipcRenderer.removeListener('command',listener);}
});
