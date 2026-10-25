'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {ipcRenderer}=require('electron');
const {makePresentation,renderSlideSvg,maxStep,nextPosition}=require('./presentationSlides');

function createPresentationRuntime({
  getMedia,saveMedia,renderMediaGrid,showMediaLive,getUserData,reportError,selectMedia=()=>{}
}) {
  let preview=null,live=null,importing=false;
  const $=id=>document.getElementById(id);
  const isDeck=item=>item?.type==='PRESENTATION'&&Array.isArray(item.slides)&&item.slides.length>0;
  const asFileURL=p=>'file:///'+String(p).replace(/\\/g,'/');
  async function materialize(media) {
    const result=await ipcRenderer.invoke('presentation:materialize',media);
    Object.assign(media,result);
    return media;
  }
  function showPreview(media,index=0) {
    if(!isDeck(media))return false;
    const i=Math.min(media.slides.length-1,Math.max(0,index|0));
    const previousMedia=preview?.media;
    preview={media,index:i,step:0};
    const host=$('presentation-mini'),list=$('presentation-slide-list');
    if(!host||!list)return false;
    host.hidden=false;
    // Reuse thumbnail DOM when navigating within one deck. Rebuilding on
    // click would detach the clicked button and swallow its dblclick event.
    const sameDeck=previousMedia===media && list.dataset.deckId===String(media.id||'') &&
      list.children.length===media.slides.length;
    if(!sameDeck){
      list.replaceChildren();
      list.dataset.deckId=String(media.id||'');
      media.slides.forEach((slide,n)=>{
        const button=document.createElement('button');button.type='button';
        button.className='presentation-slide-tile';
        button.setAttribute('role','option');
        const img=document.createElement('img');img.src=asFileURL(slide.path||slide.stepPaths?.[0]||'');
        img.alt='Slide '+(n+1);
        const caption=document.createElement('span');caption.textContent=(n+1)+'. '+(slide.name||'Slide');
        button.append(img,caption);
        button.onclick=()=>showPreview(media,n);
        button.ondblclick=()=>{showPreview(media,n);void goLive(media,n,0).catch(reportError);};
        list.append(button);
      });
    }
    [...list.children].forEach((button,n)=>{
      button.classList.toggle('active',n===i);
      button.setAttribute('aria-selected',String(n===i));
    });
    const selected=media.slides[i];$('presentation-selected-preview').src=asFileURL(selected.stepPaths?.[0]||selected.path);
    $('presentation-selected-preview').alt=selected.name||'Selected slide';
    $('presentation-mini-label').textContent=(i+1)+' / '+media.slides.length+' · '+(selected.name||'Slide');
    list.querySelector('.presentation-slide-tile.active')?.scrollIntoView({block:'nearest'});
    return true;
  }
  function hidePreview(){const panel=$('presentation-mini');if(panel)panel.hidden=true;preview=null;}
  function hideLive(){live=null;const nav=$('presentation-live-nav');if(nav)nav.hidden=true;}
  function updateLiveNav(){
    const nav=$('presentation-live-nav');if(!nav)return;
    nav.hidden=!live;
    if(!live)return;
    $('presentation-live-count').textContent=(live.index+1)+' / '+live.media.slides.length+(live.step?(' · Step '+(live.step+1)):'');
    const previous=nextPosition(live.media,live.index,live.step,false);
    const next=nextPosition(live.media,live.index,live.step,true);
    $('presentation-prev').disabled=previous.index===live.index&&previous.step===live.step;
    $('presentation-next').disabled=next.index===live.index&&next.step===live.step;
  }
  async function goLive(media,index=0,step=0){
    if(!isDeck(media))throw Error('No slides in presentation');
    const i=Math.max(0,Math.min(index|0,media.slides.length-1));
    const slide=media.slides[i],max=(slide.stepPaths||[]).length-1;
    const s=Math.max(0,Math.min(step|0,Math.max(max,0)));
    const file=slide.stepPaths?.[s]||slide.path;
    if(!file||!fs.existsSync(file))throw Error('Missing slide image. Reimport or resave the presentation.');
    live={media,index:i,step:s};
    updateLiveNav();
    // The existing media pipeline handles local Live preview and sends the
    // same raster to window and network outputs. Route exclusions there.
    const synthetic={
      type:'PNG',path:file,name:media.name,
      _presentationDeckId:media.id,
      _presentationExcludedDisplays:media.excludedDisplays||[],
      _presentationTransition:slide.transition||{type:'fade',duration:400}
    };
    await showMediaLive(synthetic);
  }
  function advance(forward){
    if(!live)return;
    const next=nextPosition(live.media,live.index,live.step,forward);
    if(next&& (next.index!==live.index||next.step!==live.step)){
      void goLive(live.media,next.index,next.step).catch(reportError);
    }
  }
  async function importPptx(){
    if(importing)return;
    const picker=document.createElement('input');picker.type='file';
    picker.accept='.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';
    picker.onchange=async()=>{
      const file=picker.files?.[0];if(!file)return;
      importing=true;
      try{
        const sourcePath=require('electron').webUtils?.getPathForFile?.(file)||file.path;
        if(!sourcePath)throw Error('This Electron build cannot read the selected PowerPoint file');
        if(file.size>100*1024*1024)throw Error('Presentations larger than 100 MB are not supported');
        const parsed=await ipcRenderer.invoke('presentation:parse-pptx',sourcePath);
        const media=makePresentation(path.basename(file.name,'.pptx'));
        media.source='pptx';media.slides=parsed.slides;
        const userData=await getUserData(),folder=path.join(userData,'presentations',media.id);
        await fs.promises.mkdir(folder,{recursive:true});
        const dest=path.join(folder,path.basename(file.name));
        await fs.promises.copyFile(sourcePath,dest);
        media.originalPath=dest;
        await materialize(media);
        getMedia().push(media);
        selectMedia(getMedia().length-1);
        await saveMedia();renderMediaGrid();showPreview(media,0);
      }catch(err){reportError(err);}finally{importing=false;}
    };
    picker.click();
  }
  function openEditor(media=null,editingIndex=null){
    if(media?.source==='pptx'){
      reportError(Error('Imported PowerPoint slides are read-only. Use the display exclusion settings to configure their outputs.'));
      return;
    }
    ipcRenderer.send('presentation-editor:open',{media,editingIndex});
  }
  async function onEditorSaved(data){
    try{
      const media=data?.media;
      if(!media)throw Error('Invalid presentation');
      media.source='native';
      await materialize(media);
      const index=data.editingIndex;
      if(Number.isInteger(index)&&getMedia()[index]?.type==='PRESENTATION')getMedia()[index]=media;
      else getMedia().push(media);
      selectMedia(Number.isInteger(index)?index:getMedia().length-1);
      await saveMedia();renderMediaGrid();
      showPreview(media,0);
    }catch(err){reportError(err);}
  }
  async function editExclusions(media){
    if(!isDeck(media))return;
    const [displays,settings,programs]=await Promise.all([
      ipcRenderer.invoke('get-displays'),ipcRenderer.invoke('load-settings'),
      ipcRenderer.invoke('program-displays:list').catch(()=>[])
    ]);
    const options=displays.map((d,i)=>({id:'window:'+d.id,label:'Monitor '+(i+1)}));
    options.push({id:'network:0',label:'Liturgia Stream / Program display'});
    for(const [id,entry] of Object.entries(settings?.displaySettings||{})){
      if(id!=='0'&&entry?.networkDisplay?.enabled)options.push({id:'network:'+id,label:'Network display '+id});
    }
    for(const profile of programs)options.push({id:'network:'+profile.id,label:profile.name+' (network)'});
    const overlay=document.createElement('div');overlay.className='presentation-exclusion-overlay';
    const card=document.createElement('div');card.className='presentation-exclusion-card';
    const title=document.createElement('h3');title.textContent='Display exclusions · '+media.name;
    const info=document.createElement('p');info.textContent='Checked outputs will not show this presentation. Other media and songs are unaffected.';
    card.append(title,info);
    for(const d of options){
      const label=document.createElement('label'),input=document.createElement('input');
      input.type='checkbox';input.value=d.id;input.checked=media.excludedDisplays?.includes(d.id);
      label.append(input,document.createTextNode(d.label));card.append(label);
    }
    const bar=document.createElement('div');bar.className='presentation-exclusion-actions';
    const cancel=document.createElement('button');cancel.textContent='Cancel';
    const save=document.createElement('button');save.textContent='Save';save.className='btn primary';
    cancel.onclick=()=>overlay.remove();
    save.onclick=async()=>{
      media.excludedDisplays=[...card.querySelectorAll('input:checked')].map(el=>el.value);
      await saveMedia();overlay.remove();
    };
    bar.append(cancel,save);card.append(bar);overlay.append(card);
    overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
    document.body.append(overlay);
  }
  function init(){
    $('presentation-preview-live')?.addEventListener('click',()=>{if(preview)void goLive(preview.media,preview.index,0).catch(reportError);});
    $('presentation-prev')?.addEventListener('click',()=>advance(false));
    $('presentation-next')?.addEventListener('click',()=>advance(true));
    ipcRenderer.on('presentation-editor:saved',(_e,data)=>{void onEditorSaved(data);});
  }
  return {init,isDeck,showPreview,hidePreview,goLive,hideLive,advance,importPptx,openEditor,editExclusions,
    materialize,get preview(){return preview;},get live(){return live;}};
}
module.exports={createPresentationRuntime};
