import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createIcons, ArrowLeft, ArrowRight, Search, PanelLeft, PanelBottom, Columns2, Files, GitBranch, SquareTerminal, SunMoon, Settings2, Ellipsis, ChevronDown, ChevronRight, FilePlus2, RefreshCw, FolderOpen, ShieldCheck, Save, Terminal as TerminalIcon, Plus, Eraser, X, ChevronsLeftRight, CircleX, TriangleAlert, Bell, Folder, File, Check, Code2 } from 'lucide';
import '@xterm/xterm/css/xterm.css';
import './style.css';

self.MonacoEnvironment = { getWorker(_,label) { if (label === 'json') return new JsonWorker(); if (['css','scss','less'].includes(label)) return new CssWorker(); if (['html','handlebars','razor'].includes(label)) return new HtmlWorker(); if (['typescript','javascript'].includes(label)) return new TsWorker(); return new EditorWorker(); } };
const iconSet = { ArrowLeft,ArrowRight,Search,PanelLeft,PanelBottom,Columns2,Files,GitBranch,SquareTerminal,SunMoon,Settings2,Ellipsis,ChevronDown,ChevronRight,FilePlus2,RefreshCw,FolderOpen,ShieldCheck,Save,Terminal:TerminalIcon,Plus,Eraser,X,ChevronsLeftRight,CircleX,TriangleAlert,Bell,Folder,File,Check,Code2 };
const icons = () => createIcons({ icons:iconSet, attrs:{'stroke-width':1.6} });
const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const basename = path => path.split('/').at(-1);
const token = location.hash.slice(1) || sessionStorage.getItem('forge-token');
if (token) { sessionStorage.setItem('forge-token',token); history.replaceState(null,'',location.pathname); }
if (window.desktop) document.body.classList.add('desktop');
let preferences;
try { preferences=JSON.parse(localStorage.getItem('forge-preferences') || '{}'); } catch { preferences={}; }
preferences={fontSize:13,wordWrap:false,minimap:true,light:false,...preferences};
let workspace, activePath=null, files=[], openFiles=new Map(), expanded=new Set(['src']), treeCache=new Map(), editor, splitEditor, terminal, fit, socket;
let currentView='explorer', selectedPanel='terminal', terminalVisible=true, toastTimer, searchTimer, currentSearch=0, output=[], requestId=0;
const languageLibraries=new Map();
function updateLanguageLibrary(path,content) {
  if (!/\.[jt]sx?$/.test(path)) return;
  languageLibraries.get(path)?.forEach(item=>item.dispose());
  const uri=monaco.Uri.file(`${workspace.root}/${path}`).toString();
  languageLibraries.set(path,[monaco.typescript.typescriptDefaults.addExtraLib(content,uri),monaco.typescript.javascriptDefaults.addExtraLib(content,uri)]);
}
const notify = (message,error=false) => { $('#toast').textContent=message; $('#toast').classList.remove('hidden'); $('#toast').classList.toggle('error',error); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),4500); };
const log = message => { output.push(`${new Date().toLocaleTimeString()}  ${message}`); $('#output-log').textContent=output.slice(-80).join('\n'); };
async function api(route,method='GET',body) {
  const response=await fetch(`/api/${route}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
const guarded = fn => (...args)=>Promise.resolve().then(()=>fn(...args)).catch(error=>{notify(error.message,true);log(error.message);});
const languages={js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',json:'json',css:'css',scss:'scss',html:'html',md:'markdown',py:'python',sh:'shell',zsh:'shell',yaml:'yaml',yml:'yaml',rs:'rust',go:'go',c:'c',h:'c',cpp:'cpp',java:'java',sql:'sql',svg:'xml',xml:'xml',toml:'ini',txt:'plaintext'};
function language(path) { return languages[path.split('.').at(-1)] || 'plaintext'; }
function fileIcon(path) { const ext=path.split('.').at(-1); const labels={ts:'TS',tsx:'TS',js:'JS',jsx:'JS',json:'{}',md:'M↓',css:'#',html:'<>',py:'Py',rs:'Rs',go:'Go'}; return `<span class="file-icon ${escape(ext)}">${escape(labels[ext]||'◇')}</span>`; }
function dirty(file) { return file.model.getValue() !== file.saved; }
function persistTabs() { if (workspace) localStorage.setItem(`forge-tabs:${workspace.root}`,JSON.stringify({paths:[...openFiles.keys()],active:activePath})); }
function renderTabs() {
  $('#tabs').innerHTML=[...openFiles].map(([path,file])=>`<div class="tab ${path===activePath?'selected':''}" role="tab" tabindex="0" aria-selected="${path===activePath}" data-file="${escape(path)}" title="${escape(path)}">${fileIcon(path)}<span>${escape(basename(path))}</span><button class="tab-close ${dirty(file)?'dirty':''}" data-close="${escape(path)}" title="${dirty(file)?'Unsaved changes — close':'Close tab'}" aria-label="Close ${escape(basename(path))}">${dirty(file)?'<span>●</span>':'<i data-lucide="x"></i>'}</button></div>`).join('');
  $('#open-editors').innerHTML=[...openFiles].map(([path,file])=>`<button class="open-editor ${path===activePath?'selected':''}" data-file="${escape(path)}"><span class="open-dirty">${dirty(file)?'●':''}</span>${fileIcon(path)}<span>${escape(basename(path))}</span><small>${escape(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'')}</small></button>`).join('');
  const unsaved=[...openFiles.values()].filter(dirty).length;
  $('#unsaved-count').textContent=unsaved?`${unsaved} unsaved`:'';
  document.title=`${unsaved?'● ':''}${activePath?basename(activePath)+' — ':''}Forge`;
  document.querySelectorAll('.tree-file').forEach(item=>item.classList.toggle('selected',item.dataset.file===activePath));
  icons(); persistTabs();
}
async function renderTree() {
  const build=async (directory='',depth=0)=>{
    let entries=treeCache.get(directory); if (!entries) {entries=await api(`tree?path=${encodeURIComponent(directory)}`);treeCache.set(directory,entries);}
    let html='';
    for (const item of entries) {
      if (item.type==='directory') { const isOpen=expanded.has(item.path); html+=`<button role="treeitem" aria-expanded="${isOpen}" class="tree-folder" style="padding-left:${10+depth*14}px" data-directory="${escape(item.path)}"><i data-lucide="${isOpen?'chevron-down':'chevron-right'}"></i><i class="folder-icon" data-lucide="${isOpen?'folder-open':'folder'}"></i><span>${escape(item.name)}</span></button>`; if (isOpen) html+=await build(item.path,depth+1); }
      else html+=`<button role="treeitem" class="tree-file ${item.path===activePath?'selected':''}" style="padding-left:${28+depth*14}px" data-file="${escape(item.path)}">${fileIcon(item.name)}<span>${escape(item.name)}</span></button>`;
    }
    return html;
  };
  $('#file-tree').innerHTML=await build(); icons();
}
async function refresh() { treeCache.clear(); const inventory=await api('files');files=inventory.files; await renderTree(); if (inventory.truncated) notify('Showing the first 3,000 workspace files.'); }
async function openFile(path,line,column=1) {
  const id=++requestId;
  if (!openFiles.has(path)) {
    const data=await api(`file?path=${encodeURIComponent(path)}`);
    if (!openFiles.has(path)) {
      const model=monaco.editor.createModel(data.content,language(path),monaco.Uri.file(`${workspace.root}/${path}`));
      const file={model,saved:data.content,revision:data.revision,view:null};openFiles.set(path,file);
      model.updateOptions({tabSize:2,insertSpaces:true});
      model.onDidChangeContent(()=>{renderTabs(); $('#save-status').textContent=dirty(file)?'Unsaved changes':'Saved';});
    }
  }
  if (id !== requestId) {renderTabs();return;}
  if (activePath && openFiles.has(activePath)) openFiles.get(activePath).view=editor.saveViewState();
  activePath=path; const file=openFiles.get(path);editor.setModel(file.model);
  if (file.view) editor.restoreViewState(file.view);
  splitEditor?.setModel(file.model);
  $('#welcome').classList.add('hidden');$('#editor').classList.remove('hidden');
  $('#breadcrumbs').innerHTML=path.split('/').map((part,i)=>`${i?'<i data-lucide="chevron-right"></i>':''}${i===path.split('/').length-1?fileIcon(path):''}<span>${escape(part)}</span>`).join('');
  $('#language-status').textContent=file.model.getLanguageId();$('#eol-status').textContent=file.model.getEOL()==='\r\n'?'CRLF':'LF';
  $('#save-status').textContent=dirty(file)?'Unsaved changes':'Saved';
  renderTabs();updateProblems();editor.focus();
  if (line) {editor.setPosition({lineNumber:line,column});editor.revealLineInCenter(line);}
}
async function save(path=activePath) {
  if (!path) return;
  const file=openFiles.get(path), content=file.model.getValue();
  if (!dirty(file)) return;
  $('#save-status').textContent='Saving…';
  try { const result=await api('file','PUT',{path,content,revision:file.revision});file.saved=content;file.revision=result.revision;updateLanguageLibrary(path,content);renderTabs();$('#save-status').textContent=dirty(file)?'Unsaved changes':'Saved';log(`Saved ${path}`); }
  catch(error) {$('#save-status').textContent='Save failed';throw error;}
}
function modal({title,description='',value='',placeholder='',submit='Continue',input=true,destructive=false}) {
  return new Promise(resolve=>{
    const overlay=$('#overlay');overlay.classList.remove('hidden');
    overlay.innerHTML=`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-title"><i data-lucide="${destructive?'triangle-alert':'folder-open'}"></i><h2 id="dialog-title">${escape(title)}</h2></div>${description?`<p>${escape(description)}</p>`:''}${input?`<input id="dialog-input" value="${escape(value)}" placeholder="${escape(placeholder)}" aria-label="${escape(title)}">`:''}<div class="dialog-buttons"><button id="dialog-cancel">Cancel</button><button id="dialog-submit" class="primary-button">${escape(submit)}</button></div></div>`;icons();
    const finish=result=>{overlay.classList.add('hidden');overlay.innerHTML='';resolve(result);editor.focus();};
    $('#dialog-cancel').onclick=()=>finish(null);$('#dialog-submit').onclick=()=>finish(input?$('#dialog-input').value:true);
    overlay.onkeydown=event=>{event.stopPropagation();if(event.key==='Escape')finish(null);if(event.key==='Enter')finish(input?$('#dialog-input').value:true);};
    setTimeout(()=>{$(input?'#dialog-input':'#dialog-cancel').focus();if(input)$('#dialog-input').select();},0);
  });
}
async function closeFile(path) {
  const file=openFiles.get(path); if (!file) return;
  if (dirty(file) && !await modal({title:`Discard changes to ${basename(path)}?`,description:'Your unsaved edits will be lost. Cancel to return and save them.',submit:'Discard changes',input:false,destructive:true})) return;
  openFiles.delete(path); if (activePath===path) {
    activePath=null;editor.setModel(null);splitEditor?.setModel(null);
    const next=[...openFiles.keys()].at(-1);if(next)await openFile(next);else{$('#welcome').classList.remove('hidden');$('#editor').classList.add('hidden');$('#breadcrumbs').textContent='Welcome to Forge';$('#language-status').textContent='Plain Text';}
  }
  file.model.dispose();renderTabs();updateProblems();
}
async function newFile() {
  const path=await modal({title:'Create a new file',description:'Enter a path relative to the current workspace. The parent folder must exist.',placeholder:'src/new-file.ts',submit:'Create file'});
  if (!path?.trim())return;await api('file','POST',{path:path.trim(),content:''});await refresh();await openFile(path.trim());
}
async function openFolder() {
  if ([...openFiles.values()].some(dirty) && !await modal({title:'Open another folder?',description:'There are unsaved changes. Cancel and save them, or discard them to switch folders.',input:false,submit:'Discard and continue',destructive:true}))return;
  let result;
  if (window.desktop) result=await window.desktop.chooseFolder();
  else {const root=await modal({title:'Open a local folder',description:'Paste the absolute path of a folder on this computer.',value:workspace.root,submit:'Open folder'});if(!root)return;result=await api('workspace','POST',{root});}
  if (!result)return;
  editor.setModel(null);splitEditor?.setModel(null);for(const file of openFiles.values())file.model.dispose();openFiles.clear();activePath=null;
  $('#welcome').classList.remove('hidden');$('#editor').classList.add('hidden');$('#breadcrumbs').textContent='Welcome to Forge';
  await loadWorkspace();renderTabs();restartTerminal();notify(`Opened ${workspace.name}`);
}
function showView(view) {
  currentView=view;$('#sidebar').classList.remove('hidden');$('#sidebar-resize').classList.remove('hidden');
  document.querySelectorAll('.side-view').forEach(el=>el.classList.toggle('hidden',el.id!==`${view}-view`));
  document.querySelectorAll('.activity[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('#sidebar-title').textContent={explorer:'EXPLORER',search:'SEARCH',git:'SOURCE CONTROL',settings:'SETTINGS'}[view];
  if(view==='search')$('#search-input').focus();if(view==='git')guarded(refreshGit)();
}
async function search() {
  const sequence=++currentSearch, query=$('#search-input').value;
  if(!query){$('#search-results').innerHTML='';$('#search-summary').textContent='Search the current workspace.';return;}
  $('#search-summary').textContent='Searching…';
  const result=await api(`search?q=${encodeURIComponent(query)}&case=${$('#case-toggle').getAttribute('aria-pressed')}`);
  if(sequence!==currentSearch)return;
  $('#search-summary').textContent=`${result.matches.length}${result.truncated?'+':''} results${result.skipped?` · ${result.skipped} non-text or large files skipped`:''}`;
  let previous='';$('#search-results').innerHTML=result.matches.map(match=>{const head=previous!==match.path?`<div class="search-group">${fileIcon(match.path)}<span>${escape(match.path)}</span></div>`:'';previous=match.path;return `${head}<button class="search-match" data-file="${escape(match.path)}" data-line="${match.line}" data-column="${match.column}"><span>${match.line}</span><code>${escape(match.preview.trim())}</code></button>`;}).join('')||'<p class="empty-message">No matching text found.</p>';
}
async function refreshGit() {
  const result=await api('git');$('#branch-status span').textContent=result.branch||'local';
  $('#git-badge').textContent=result.changes.length;$('#git-badge').classList.toggle('hidden',!result.changes.length);
  $('#git-content').innerHTML=result.available?`<div class="git-heading"><i data-lucide="git-branch"></i>${escape(result.branch)}</div><div class="section-label">CHANGES <span class="count">${result.changes.length}</span></div>${result.changes.map(change=>`<button class="git-file" data-file="${escape(change.path)}">${fileIcon(change.path)}<span>${escape(change.path)}</span><b>${escape(change.status)}</b></button>`).join('')||'<p class="empty-message">Working tree is clean.</p>'}<p class="git-note">File status is read-only. Use the terminal to stage and commit.</p>`:'<div class="empty-state"><i data-lucide="git-branch"></i><h3>No repository here</h3><p>Open a Git project to see changed files and the current branch.</p></div>';icons();
}
function updateProblems() {
  const markers=monaco.editor.getModelMarkers({}).filter(m=>[...openFiles.values()].some(file=>file.model.uri.toString()===m.resource.toString()));
  const errors=markers.filter(m=>m.severity===8).length,warnings=markers.filter(m=>m.severity===4).length;
  $('#problem-count').textContent=markers.length;$('#error-count').textContent=errors;$('#warning-count').textContent=warnings;
  $('#problems-panel').innerHTML=markers.length?markers.slice(0,100).map(m=>{const path=m.resource.fsPath.slice(workspace.root.length+1);return `<button class="problem" data-file="${escape(path)}" data-line="${m.startLineNumber}" data-column="${m.startColumn}"><span class="${m.severity===8?'problem-error':'problem-warning'}">${m.severity===8?'⊗':'△'}</span><span>${escape(m.message)}</span><small>${escape(path)}:${m.startLineNumber}</small></button>`;}).join(''):'<p class="empty-message">No problems detected in open files.</p>';
}
function choosePanel(panel) {
  selectedPanel=panel;if(!terminalVisible)toggleTerminal();
  document.querySelectorAll('[data-panel]').forEach(el=>el.classList.toggle('selected',el.dataset.panel===panel));
  ['terminal','problems','output'].forEach(name=>$(`#${name}-panel`).classList.toggle('hidden',name!==panel));
  if(panel==='terminal')requestAnimationFrame(()=>{fit?.fit();terminal?.focus();});if(panel==='problems')updateProblems();
}
function toggleTerminal() {terminalVisible=!terminalVisible;$('#bottom-panel').classList.toggle('hidden',!terminalVisible);$('#terminal-resize').classList.toggle('hidden',!terminalVisible);if(terminalVisible)requestAnimationFrame(()=>{fit?.fit();if(selectedPanel==='terminal')terminal?.focus();});}
function restartTerminal() {
  socket?.close();terminal?.dispose();$('#terminal').innerHTML='';
  terminal=new Terminal({fontFamily:'"SFMono-Regular", Menlo, monospace',fontSize:12,lineHeight:1.35,cursorBlink:true,scrollback:3000,theme:{background:preferences.light?'#ffffff':'#1f1f1f',foreground:preferences.light?'#333333':'#cccccc',cursor:'#93b4ff',selectionBackground:'#264f78',black:'#1f1f1f',blue:'#5f9aff',green:'#86c79b',yellow:'#dfc17a'}});
  fit=new FitAddon();terminal.loadAddon(fit);terminal.open($('#terminal'));fit.fit();
  const term=terminal, ws=new WebSocket(`${location.origin.replace('http','ws')}/terminal?token=${token}`);socket=ws;
  ws.onopen=()=>{ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}));log('Connected to local shell.');};
  ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.type==='data')term.write(Uint8Array.from(atob(message.data),c=>c.charCodeAt(0)));else if(message.type==='error')term.writeln(`\r\n${message.message}`);};
  ws.onclose=()=>{if(terminal===term)term.writeln('\r\n\x1b[90mTerminal closed. Press + to start a new session.\x1b[0m');};
  ws.onerror=()=>log('Terminal connection failed.');
  term.onData(data=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'input',data}));});
  term.onResize(({cols,rows})=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'resize',cols,rows}));});
}
function applyPreferences() {
  document.body.classList.toggle('light',preferences.light);monaco.editor.setTheme(preferences.light?'vs':'forge-dark');
  const options={fontSize:preferences.fontSize,wordWrap:preferences.wordWrap?'on':'off',minimap:{enabled:preferences.minimap}};editor?.updateOptions(options);splitEditor?.updateOptions(options);
  $('#font-size').value=preferences.fontSize;$('#word-wrap').checked=preferences.wordWrap;$('#minimap').checked=preferences.minimap;
  if(terminal)terminal.options.theme={...terminal.options.theme,background:preferences.light?'#ffffff':'#1f1f1f',foreground:preferences.light?'#333333':'#cccccc'};
  localStorage.setItem('forge-preferences',JSON.stringify(preferences));
}
function toggleSplit() {
  if(splitEditor){splitEditor.dispose();splitEditor=null;$('#split-editor').classList.add('hidden');return;}
  $('#split-editor').classList.remove('hidden');splitEditor=monaco.editor.create($('#split-editor'),{...editorOptions,model:activePath?openFiles.get(activePath).model:null});applyPreferences();
}
function nextTab(delta) {const paths=[...openFiles.keys()];if(paths.length)return openFile(paths[(paths.indexOf(activePath)+delta+paths.length)%paths.length]);}
const actions={
  'new':newFile,'open-folder':openFolder,'save':()=>save(),'save-all':async()=>{for(const path of openFiles.keys())await save(path);notify('All files saved');},'close':()=>closeFile(activePath),'refresh':refresh,'refresh-git':refreshGit,
  'terminal':toggleTerminal,'terminal-restart':()=>{if(!terminalVisible)toggleTerminal();choosePanel('terminal');restartTerminal();},'terminal-clear':()=>terminal?.clear(),'sidebar':()=>{$('#sidebar').classList.toggle('hidden');$('#sidebar-resize').classList.toggle('hidden');},
  'split':toggleSplit,'theme':()=>{preferences.light=!preferences.light;applyPreferences();},'quick-open':()=>palette('files'),'commands':()=>palette('commands'),'back':()=>nextTab(-1),'next':()=>nextTab(1),'problems':()=>choosePanel('problems'),
  'format':async()=>{await editor.getAction('editor.action.formatDocument')?.run();},'wrap':()=>{preferences.wordWrap=!preferences.wordWrap;applyPreferences();},'language':()=>palette('languages'),'find':()=>editor.getAction('actions.find')?.run(),'settings':()=>showView('settings')
};
const commands=[['new','File: New File','⌘ N'],['open-folder','File: Open Folder…','⌘ O'],['save','File: Save','⌘ S'],['save-all','File: Save All','⌘ ⌥ S'],['quick-open','Go to File…','⌘ P'],['format','Format Document','⇧ ⌥ F'],['find','Find in Current File','⌘ F'],['terminal','View: Toggle Terminal','⌃ `'],['split','View: Split Editor','⌘ \\'],['sidebar','View: Toggle Sidebar','⌘ B'],['theme','Preferences: Toggle Color Theme',''],['wrap','View: Toggle Word Wrap','⌥ Z'],['settings','Preferences: Open Settings','⌘ ,'],['refresh','Explorer: Refresh Files','']];
function palette(mode) {
  const overlay=$('#overlay');overlay.classList.remove('hidden');overlay.innerHTML=`<div class="palette" role="dialog" aria-modal="true" aria-label="${mode==='commands'?'Command palette':'Quick open'}"><div class="palette-input"><i data-lucide="${mode==='commands'?'chevrons-left-right':'search'}"></i><input id="palette-input" autocomplete="off" placeholder="${mode==='commands'?'Type a command…':mode==='languages'?'Select language mode…':'Search files by name…'}" aria-label="${mode==='commands'?'Type a command':'Search files'}"><kbd>esc</kbd></div><div id="palette-list" role="listbox"></div><div class="palette-footer"><span>↑↓ navigate</span><span>↵ open</span><span>${mode==='commands'?'FORGE COMMANDS':'WORKSPACE FILES'}</span></div></div>`;icons();
  let selected=0, matches=[];
  const close=()=>{overlay.classList.add('hidden');overlay.innerHTML='';editor.focus();};
  const activate=()=>{const match=matches[selected];if(!match)return;close();guarded(match.run)();};
  const render=()=>{
    const query=$('#palette-input').value.toLowerCase();
    const list=mode==='commands'?commands.map(([id,label,key])=>({label,key,run:actions[id]})):mode==='languages'?monaco.languages.getLanguages().map(l=>({label:l.id,key:'',run:()=>{if(activePath){monaco.editor.setModelLanguage(openFiles.get(activePath).model,l.id);$('#language-status').textContent=l.id;}}})):files.map(path=>({label:basename(path),detail:path,key:'',run:()=>openFile(path)}));
    matches=list.filter(item=>`${item.label} ${item.detail||''}`.toLowerCase().includes(query)).slice(0,60);selected=Math.min(selected,Math.max(0,matches.length-1));
    $('#palette-list').innerHTML=matches.map((item,index)=>`<button class="palette-item ${index===selected?'selected':''}" role="option" aria-selected="${index===selected}" data-index="${index}">${mode==='files'?fileIcon(item.label):'<span class="command-icon">›</span>'}<span>${escape(item.label)}${item.detail?`<small>${escape(item.detail)}</small>`:''}</span><kbd>${escape(item.key)}</kbd></button>`).join('')||'<p class="empty-message">No matches found.</p>';
    $('#palette-list .selected')?.scrollIntoView({block:'nearest'});
  };
  $('#palette-input').oninput=()=>{selected=0;render();};$('#palette-list').onclick=event=>{const item=event.target.closest('[data-index]');if(item){selected=Number(item.dataset.index);activate();}};
  overlay.onkeydown=event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();close();}if(event.key==='ArrowDown'){event.preventDefault();selected=(selected+1)%Math.max(1,matches.length);render();}if(event.key==='ArrowUp'){event.preventDefault();selected=(selected-1+matches.length)%Math.max(1,matches.length);render();}if(event.key==='Enter'){event.preventDefault();activate();}};
  render();$('#palette-input').focus();
}
async function loadWorkspace() {
  workspace=await api('workspace');$('#workspace-title').textContent=workspace.name;$('#folder-name').textContent=workspace.name.toUpperCase();expanded=new Set(['src']);await refresh();await refreshGit();log(`Workspace: ${workspace.root}`);
  for (const libraries of languageLibraries.values()) libraries.forEach(item=>item.dispose());languageLibraries.clear();
  let bytes=0;
  for (const path of files.filter(p=>/\.[jt]sx?$/.test(p)).slice(0,100)) {
    try {const data=await api(`file?path=${encodeURIComponent(path)}`);bytes+=data.bytes;if(bytes>2*1024*1024)break;updateLanguageLibrary(path,data.content);}catch{}
  }
}
const editorOptions={model:null,theme:'forge-dark',fontFamily:'"SFMono-Regular", Menlo, Monaco, monospace',fontSize:13,lineHeight:22,padding:{top:18,bottom:18},automaticLayout:true,scrollBeyondLastLine:false,smoothScrolling:true,cursorSmoothCaretAnimation:'on',cursorBlinking:'smooth',renderLineHighlight:'line',lineNumbersMinChars:4,glyphMargin:true,folding:true,bracketPairColorization:{enabled:true},guides:{indentation:true,bracketPairs:true},tabSize:2,insertSpaces:true,minimap:{enabled:true,renderCharacters:false},overviewRulerBorder:false,renderWhitespace:'selection',stickyScroll:{enabled:true}};
monaco.editor.defineTheme('forge-dark',{base:'vs-dark',inherit:true,rules:[],colors:{'editor.background':'#1f1f1f','editor.lineHighlightBackground':'#25272b','editorLineNumber.foreground':'#626873','editorLineNumber.activeForeground':'#c4cbd6','editorIndentGuide.background1':'#33363e','editor.selectionBackground':'#29456b','editorCursor.foreground':'#a7c4ff','editorWidget.background':'#25272b','editorGutter.background':'#1f1f1f','minimap.background':'#1f1f1f'}});
editor=monaco.editor.create($('#editor'),editorOptions);applyPreferences();icons();
for (const defaults of [monaco.typescript.typescriptDefaults,monaco.typescript.javascriptDefaults]) {
  defaults.setEagerModelSync(true);
  defaults.setCompilerOptions({target:monaco.typescript.ScriptTarget.ES2022,module:monaco.typescript.ModuleKind.ESNext,moduleResolution:monaco.typescript.ModuleResolutionKind.NodeJs,allowNonTsExtensions:true,allowJs:true,jsx:monaco.typescript.JsxEmit.ReactJSX});
}
editor.onDidChangeCursorPosition(event=>{$('#cursor-status').textContent=`Ln ${event.position.lineNumber}, Col ${event.position.column}`;});monaco.editor.onDidChangeMarkers(updateProblems);
editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,guarded(()=>save()));
document.addEventListener('click',guarded(async event=>{
  const target=event.target.closest('[data-action],[data-file],[data-directory],[data-close],[data-view],[data-panel]');if(!target)return;
  if(target.dataset.close!==undefined){event.stopPropagation();return closeFile(target.dataset.close);}
  if(target.dataset.action)return actions[target.dataset.action]?.();
  if(target.dataset.view)return showView(target.dataset.view);
  if(target.dataset.panel)return choosePanel(target.dataset.panel);
  if(target.dataset.directory){const path=target.dataset.directory;expanded.has(path)?expanded.delete(path):expanded.add(path);return renderTree();}
  if(target.dataset.file)return openFile(target.dataset.file,Number(target.dataset.line)||undefined,Number(target.dataset.column)||1);
}));
document.addEventListener('keydown',event=>{
  if(!$('#overlay').classList.contains('hidden'))return;
  const mod=event.metaKey||event.ctrlKey,key=event.key.toLowerCase();let action;
  if(mod&&event.shiftKey&&key==='p')action='commands';else if(mod&&key==='p')action='quick-open';else if(mod&&key==='s')action=event.altKey?'save-all':'save';else if(mod&&key==='o')action='open-folder';else if(mod&&key==='n')action='new';else if(mod&&key==='w')action='close';else if(mod&&key==='b')action='sidebar';else if(mod&&key==='\\')action='split';else if(event.ctrlKey&&key==='`')action='terminal';else if(mod&&key===',')action='settings';else if(event.altKey&&key==='z')action='wrap';
  if(mod&&event.shiftKey&&['e','f'].includes(key)){event.preventDefault();event.stopPropagation();showView(key==='e'?'explorer':'search');return;}
  if(action){event.preventDefault();event.stopPropagation();guarded(actions[action])();}
},true);
window.desktop?.onCommand(action=>guarded(actions[action]||(()=>{}))());
window.addEventListener('beforeunload',event=>{if([...openFiles.values()].some(dirty)){event.preventDefault();event.returnValue='';}});
$('#search-input').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(guarded(search),220);};
$('#case-toggle').onclick=()=>{$('#case-toggle').setAttribute('aria-pressed',$('#case-toggle').getAttribute('aria-pressed')!=='true');guarded(search)();};
$('#font-size').onchange=()=>{preferences.fontSize=Math.min(28,Math.max(10,Number($('#font-size').value)||13));applyPreferences();};
$('#word-wrap').onchange=()=>{preferences.wordWrap=$('#word-wrap').checked;applyPreferences();};$('#minimap').onchange=()=>{preferences.minimap=$('#minimap').checked;applyPreferences();};
function resizable(handle,move) {handle.addEventListener('pointerdown',event=>{event.preventDefault();handle.setPointerCapture(event.pointerId);document.body.classList.add('resizing');const onMove=e=>{move(e);fit?.fit();};const done=()=>{document.body.classList.remove('resizing');handle.removeEventListener('pointermove',onMove);handle.removeEventListener('pointerup',done);};handle.addEventListener('pointermove',onMove);handle.addEventListener('pointerup',done);});}
resizable($('#sidebar-resize'),event=>document.documentElement.style.setProperty('--sidebar-width',`${Math.min(480,Math.max(180,event.clientX-48))}px`));
resizable($('#terminal-resize'),event=>document.documentElement.style.setProperty('--panel-height',`${Math.min(window.innerHeight-240,Math.max(100,window.innerHeight-event.clientY-24))}px`));
new ResizeObserver(()=>{try{fit?.fit();}catch{}}).observe($('#terminal'));
guarded(async()=>{
  await loadWorkspace();let saved;try{saved=JSON.parse(localStorage.getItem(`forge-tabs:${workspace.root}`));}catch{}
  const initial=saved?.paths?.filter(path=>files.includes(path))||(['README.md','src/app.ts'].filter(path=>files.includes(path)));
  for(const path of initial)await openFile(path);if(saved?.active&&openFiles.has(saved.active))await openFile(saved.active);
  restartTerminal();editor.focus();log('Forge is ready.');
})();
