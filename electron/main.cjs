const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
// Keep this portable build's preferences beside the project.
const data = process.env.FORGE_DATA_DIR || (app.isPackaged ? path.resolve(path.dirname(app.getPath('exe')), '../../..', 'Forge-data') : path.join(app.getAppPath(), '.local-data'));
fs.mkdirSync(data, { recursive:true });
app.setPath('userData', data);
let instance, win;
app.whenReady().then(async () => {
  const { startServer } = await import(pathToFileURL(path.join(__dirname,'../server/index.mjs')).href);
  let root;
  if (app.isPackaged) {
    root=path.join(data,'sample-workspace');
    if(!fs.existsSync(root))fs.cpSync(path.join(app.getAppPath(),'sample-workspace'),root,{recursive:true});
  }
  instance = await startServer({root});
  win = new BrowserWindow({ width:1440, height:920, minWidth:1000, minHeight:560, title:'Forge', backgroundColor:'#1f1f1f', titleBarStyle:'hiddenInset', trafficLightPosition:{x:16,y:14}, webPreferences:{ preload:path.join(__dirname,'preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true } });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate', (event,url) => { if (new URL(url).origin !== instance.origin) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(win,{type:'question',buttons:['Keep editing','Discard changes'],defaultId:0,cancelId:0,title:'Unsaved changes',message:'Some files have unsaved changes.',detail:'Discard these changes and close Forge?'});
    if (choice === 1) event.preventDefault();
  });
  ipcMain.handle('choose-folder', async event => {
    if (event.sender !== win.webContents || new URL(event.senderFrame.url).origin !== instance.origin) throw new Error('Invalid sender.');
    const selection = await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Open workspace'});
    if (selection.canceled) return null;
    return instance.changeRoot(selection.filePaths[0]);
  });
  const command = action => win.webContents.send('command',action);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Forge',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{type:'separator'},{role:'quit'}]},
    {label:'File',submenu:[{label:'New File',accelerator:'CmdOrCtrl+N',click:()=>command('new')},{label:'Open Folder…',accelerator:'CmdOrCtrl+O',click:()=>command('open-folder')},{type:'separator'},{label:'Save',accelerator:'CmdOrCtrl+S',click:()=>command('save')},{label:'Save All',accelerator:'CmdOrCtrl+Alt+S',click:()=>command('save-all')},{label:'Close Tab',accelerator:'CmdOrCtrl+W',click:()=>command('close')}]},
    {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'View',submenu:[{label:'Command Palette',accelerator:'CmdOrCtrl+Shift+P',click:()=>command('commands')},{label:'Quick Open',accelerator:'CmdOrCtrl+P',click:()=>command('quick-open')},{label:'Toggle Terminal',accelerator:'Ctrl+`',click:()=>command('terminal')},{role:'togglefullscreen'},{role:'toggleDevTools'}]}
  ]));
  await win.loadURL(instance.url);
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>instance?.close());
