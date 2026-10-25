const {app,BrowserWindow,ipcMain}=require('electron');
const os=require('os'),path=require('path'),fs=require('fs');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'liturgia-slide-editor-smoke-')));
app.on('window-all-closed',()=>{});
(async()=>{
 await app.whenReady();
 const w=new BrowserWindow({show:false,width:1150,height:760,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}});
 const errors=[],saved=[];
 ipcMain.on('presentation-editor:save',(_e,p)=>saved.push(p));
 w.webContents.on('console-message',(_e,level,msg)=>{if(level>=2&&!msg.includes('Electron Security Warning'))errors.push(msg)});
 try {
  await w.loadFile(path.join(__dirname,'..','presentation-editor.html'));
  await w.webContents.executeJavaScript('window.close=()=>{};true');
  w.webContents.send('presentation-editor:init',{media:null,editingIndex:null,displays:[{id:'window:123',name:'Monitor 1'},{id:'network:0',name:'Liturgia Stream'}]});
  await new Promise(r=>setTimeout(r,190));
  const commands=[
    "document.getElementById('deck-title').value='Sunday Program'",
    "document.getElementById('deck-title').dispatchEvent(new Event('input',{bubbles:true}))",
    "document.querySelector('[data-add=\"text\"]').click()",
    "document.getElementById('el-text').value='Welcome Everyone'",
    "document.getElementById('el-text').dispatchEvent(new Event('input',{bubbles:true}))",
    "document.getElementById('el-step').value='1'",
    "document.getElementById('el-step').dispatchEvent(new Event('input',{bubbles:true}))",
    "document.getElementById('add-slide').click()",
    "document.querySelector('[data-add=\"rectangle\"]').click()",
    "document.querySelector('#display-exclusions input[value=\"network:0\"]').checked=true",
    "document.getElementById('save').click()",
    "({slides:document.getElementById('slide-list').children.length,selection:!!document.querySelector('.slide-element.active'),excludeOptions:document.querySelectorAll('#display-exclusions input').length})"
  ];
  const result=await w.webContents.executeJavaScript(commands.join(';'));
  await new Promise(r=>setTimeout(r,70));
  const screenshot=path.join(os.tmpdir(),'liturgia-slide-editor.png');
  fs.writeFileSync(screenshot,(await w.capturePage()).toPNG());
  console.log('PRESENTATION_EDITOR_SMOKE='+JSON.stringify({result,saveCount:saved.length,
   saved:saved.map(x=>({name:x.media?.name,slides:x.media?.slides?.length,excluded:x.media?.excludedDisplays,steps:x.media?.slides?.[0]?.elements?.map(e=>e.appearStep)})),errors,screenshot}));
  if(errors.length||result.slides!==2||saved.length!==1||saved[0].media.name!=='Sunday Program'||
    !saved[0].media.excludedDisplays.includes('network:0')||
    !saved[0].media.slides[0].elements.some(e=>e.text==='Welcome Everyone'&&e.appearStep===1))process.exitCode=2;
 }catch(e){console.error('EDITOR_SMOKE_FAIL='+e.stack);process.exitCode=1;}
 finally{w.destroy();app.quit()}
})().catch(e=>{console.error(e.stack);app.quit()});