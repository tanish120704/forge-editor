import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../server/workspace.mjs';
import { startServer } from '../server/index.mjs';
import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/file.ts'),'const answer = 42;\n');return {root,workspace:await new Workspace(root).init()};}
test('reads and saves actual files, retaining file permissions',async t=>{
  const {root,workspace}=await fixture(t);await fs.chmod(path.join(root,'src/file.ts'),0o755);const file=await workspace.read('src/file.ts');await workspace.write(file.path,'const answer = 43;\n',file.revision);assert.equal(await fs.readFile(path.join(root,file.path),'utf8'),'const answer = 43;\n');assert.equal((await fs.stat(path.join(root,file.path))).mode&0o777,0o755);
});
test('external edits cannot be overwritten by a stale editor',async t=>{
  const {root,workspace}=await fixture(t);const file=await workspace.read('src/file.ts');await fs.writeFile(path.join(root,file.path),'external edit');await assert.rejects(workspace.write(file.path,'editor edit',file.revision),{status:409});assert.equal(await fs.readFile(path.join(root,file.path),'utf8'),'external edit');
});
test('concurrent writes using one revision produce a conflict',async t=>{
  const {workspace}=await fixture(t);const file=await workspace.read('src/file.ts');const result=await Promise.allSettled([workspace.write(file.path,'first',file.revision),workspace.write(file.path,'second',file.revision)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.status,409);
});
test('path traversal and symlinks outside workspace are rejected',async t=>{
  const {root,workspace}=await fixture(t);await fs.symlink('/etc',path.join(root,'outside'));await assert.rejects(workspace.read('../outside.txt'));await assert.rejects(workspace.read('/etc/hosts'));await assert.rejects(workspace.read('outside/hosts'));await assert.rejects(workspace.write('../escape.txt','oops',null,true));await assert.rejects(workspace.write('outside/new.txt','oops',null,true));
});
test('new files never overwrite existing files; binaries are refused',async t=>{
  const {root,workspace}=await fixture(t);await assert.rejects(workspace.write('src/file.ts','overwrite',null,true),{code:'EEXIST'});await workspace.write('src/new.ts','new content',null,true);assert.equal((await workspace.read('src/new.ts')).content,'new content');await fs.writeFile(path.join(root,'binary'),Buffer.from([0,2,3]));await assert.rejects(workspace.read('binary'),/Binary/);
});
test('workspace search gives real line/column positions and ignores dependencies',async t=>{
  const {root,workspace}=await fixture(t);await fs.mkdir(path.join(root,'node_modules'));await fs.writeFile(path.join(root,'node_modules/hidden.txt'),'answer');const result=await workspace.search('ANSWER');assert.equal(result.matches.length,1);assert.equal(result.matches[0].path,'src/file.ts');assert.equal(result.matches[0].line,1);assert.equal(result.matches[0].column,7);assert.equal((await workspace.search('ANSWER',true)).matches.length,0);
});
test('HTTP API requires token and rejects cross-origin mutations',async t=>{
  const {root}=await fixture(t);const server=await startServer({root});t.after(()=>server.close());assert.equal((await fetch(server.origin+'/api/workspace')).status,401);const headers={Authorization:`Bearer ${server.token}`};assert.equal((await fetch(server.origin+'/api/workspace',{headers})).status,200);assert.equal((await fetch(server.origin+'/api/workspace',{method:'POST',headers:{...headers,Origin:'https://untrusted.example','Content-Type':'application/json'},body:JSON.stringify({root})})).status,403);
  const read=await (await fetch(server.origin+'/api/file?path=src/file.ts',{headers})).json();assert.equal(read.content,'const answer = 42;\n');
});
test('Git paths remain relative to a workspace nested inside a repository',async t=>{
  const {root}=await fixture(t);await promisify(execFile)('/usr/bin/git',['init','--quiet',root]);await fs.writeFile(path.join(root,'outside.txt'),'not in selected folder');
  const server=await startServer({root:path.join(root,'src')});t.after(()=>server.close());
  const status=await(await fetch(server.origin+'/api/git',{headers:{Authorization:`Bearer ${server.token}`}})).json();assert.equal(status.available,true);assert.deepEqual(status.changes,[{status:'??',path:'file.ts'}]);
});
test('terminal runs a real shell in the chosen workspace',async t=>{
  const {root}=await fixture(t);const server=await startServer({root});t.after(()=>server.close());
  const ws=new WebSocket(`${server.origin.replace('http','ws')}/terminal?token=${server.token}`,{origin:server.origin});t.after(()=>ws.terminate());
  const output=await new Promise((resolve,reject)=>{
    let text='';const timeout=setTimeout(()=>reject(new Error('Terminal did not return expected output: '+text)),10000);
    ws.on('open',()=>ws.send(JSON.stringify({type:'input',data:"printf 'FORGE_%s_OK\\n' 'PTY'; pwd\n"})));
    ws.on('error',reject);ws.on('message',data=>{const m=JSON.parse(String(data));if(m.type==='data')text+=Buffer.from(m.data,'base64').toString();if(text.includes('FORGE_PTY_OK')&&text.includes(root)){clearTimeout(timeout);resolve(text);}if(m.type==='error'){clearTimeout(timeout);reject(new Error(m.message));}});
  });assert.ok(output.includes('FORGE_PTY_OK'));
});
