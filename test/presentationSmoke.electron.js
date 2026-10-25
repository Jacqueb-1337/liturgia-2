const {app,BrowserWindow,ipcMain}=require('electron'),path=require('path'),os=require('os'),fs=require('fs');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'liturgia-presentation-smoke-')));
app.on('window-all-closed',()=>{});
(async()=>{
 await app.whenReady();
 ipcMain.handle('presentation:parse-pptx',(_e,file)=>require('../lib/presentationImport').parsePptx(file));
 ipcMain.handle('presentation:materialize',(_e,media)=>
   require('../lib/presentationRasterizer').materializePresentation(media,path.join(os.tmpdir(),'liturgia-slide-player-test')));

 const w=new BrowserWindow({show:false,width:760,height:790,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true}});
 const errors=[];
 w.webContents.on('console-message',(_e,level,msg)=>{if(msg.includes('IMPORT_SMOKE_'))console.log(msg);if(level>=2&&!msg.includes('Electron Security Warning'))errors.push(msg)});
 try{
  console.log('SMOKE_BEGIN_LOAD');await w.loadFile(path.join(__dirname,'presentationSmoke.html'));console.log('SMOKE_LOADED');
  console.log('SMOKE_START_IMPORT');const imported=await w.webContents.executeJavaScript('window.testImport()');console.log('SMOKE_IMPORTED');
  await new Promise(r=>setTimeout(r,180));
  const screenshot=path.join(os.tmpdir(),'liturgia-presentation-player.png');fs.writeFileSync(screenshot,(await w.capturePage()).toPNG());
  const live=await w.webContents.executeJavaScript('window.testLive()');
  const doubleClick=await w.webContents.executeJavaScript('(async()=>{const deck=window.stored[0];window.runtime.showPreview(deck,0);const tile=document.getElementById("presentation-slide-list").children[1];tile.click();const connected=tile.isConnected;tile.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}));await new Promise(r=>setTimeout(r,100));return {connected,slide:window.runtime.live?.index,calls:window.liveCalls.length};})()');
  const native=await w.webContents.executeJavaScript('window.testNative()');
  console.log('PRESENTATION_SMOKE='+JSON.stringify({imported,live,doubleClick,native,errors,screenshot}));
  if(errors.length||imported.leftCount!==2||imported.initialLabel.indexOf('1 / 2')<0||
     !live.navVisible||!live.excluded.includes('network:0')||!doubleClick.connected||doubleClick.slide!==1||native.stepPaths.length!==2||
     native.first===native.next)process.exitCode=2;
 }catch(e){console.error('PRESENTATION_SMOKE_FAILURE='+e.stack);process.exitCode=1;}
 finally{w.destroy();app.quit()}
})().catch(e=>{console.error(e.stack);app.quit()});