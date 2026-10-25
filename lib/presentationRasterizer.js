'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {BrowserWindow}=require('electron');
const {renderSlideSvg,maxStep}=require('./presentationSlides');
function safeDeckId(v){return String(v||crypto.randomUUID()).replace(/[^a-z0-9-]/gi,'').slice(0,70);}
async function materializePresentation(media,userData){
 if(!Array.isArray(media?.slides)||!media.slides.length||media.slides.length>300)throw Error('Presentation must contain 1-300 slides');
 const id=safeDeckId(media.id);if(!id)throw Error('Invalid presentation');
 const dir=path.join(userData,'presentations',id);
 await fs.promises.mkdir(dir,{recursive:true});
 const output={...media,id,type:'PRESENTATION',slides:[]};
 const window=new BrowserWindow({
  width:1920,height:1080,show:false,frame:false,backgroundColor:'#141923',
  webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,webSecurity:true}
 });
 try{
  for(let i=0;i<media.slides.length;i++){
   const slide=media.slides[i],count=media.source==='pptx'?Math.min(81,slide.stepSvgs?.length||1):Math.min(51,maxStep(slide)+1);
   const paths=[];
   for(let step=0;step<count;step++){
    const svg=media.source==='pptx'?(slide.stepSvgs?.[step]||slide.svg):renderSlideSvg(slide,step);
    if(typeof svg!=='string'||svg.length>18_000_000)throw Error('Slide '+(i+1)+' has invalid graphics');
    const safe=svg.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi,'');
    const document='<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src data: blob: file:; script-src none; connect-src none; style-src unsafe-inline data:; img-src data: blob: file:;"><style>html,body{padding:0;margin:0;width:100%;height:100%;overflow:hidden!important;background:#000}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}svg{display:block;overflow:hidden!important;position:absolute;inset:0;width:100vw!important;height:100vh!important}</style></head><body>'+safe+'</body></html>';
    await window.loadURL('data:text/html;base64,'+Buffer.from(document).toString('base64'));
    await window.webContents.executeJavaScript('document.fonts.ready.then(()=>true)',true).catch(()=>{});
    // A render frame must complete before capture on offscreen Chromium.
    await new Promise(resolve=>setTimeout(resolve,65));
    const bitmap=await window.webContents.capturePage({x:0,y:0,width:1920,height:1080});
    if(bitmap.isEmpty())throw Error('Could not capture slide '+(i+1));
    const target=path.join(dir,String(i).padStart(3,'0')+'-'+step+'.png');
    await fs.promises.writeFile(target,bitmap.toPNG());
    paths.push(target);
   }
   const {svg,stepSvgs,...saved}=slide;
   output.slides.push({...saved,path:paths[0],stepPaths:paths});
  }
  output.thumbnail=output.slides[0].path;
  output.size=output.slides.length+' slides';
  return output;
 }finally{window.destroy();}
}
module.exports={materializePresentation};
