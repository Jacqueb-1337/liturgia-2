'use strict';
const {ipcRenderer}=require('electron');
const {makePresentation,makeSlide,makeElement,renderSlideSvg,validateSlide}=require('./lib/presentationSlides');
let media=makePresentation(),editingIndex=null,slideIndex=0,elementId=null;
const $=id=>document.getElementById(id),current=()=>media.slides[slideIndex],element=()=>current()?.elements.find(e=>e.id===elementId);
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
function render(){
 $('slide-list').replaceChildren();
 media.slides.forEach((s,i)=>{
   const tile=document.createElement('button');tile.className='slide-tile'+(slideIndex===i?' active':'');
   const thumb=document.createElement('div');thumb.className='slide-thumb';thumb.innerHTML=renderSlideSvg(s);
   tile.append(thumb);
   const title=document.createElement('div');title.className='slide-tile-label';title.textContent=(i+1)+'. '+(s.name||'Slide');
   tile.append(title);tile.onclick=()=>{slideIndex=i;elementId=null;render();};
   $('slide-list').append(tile);
 });
 const slide=current();if(!slide)return;
 $('slide-name').value=slide.name;$('slide-bg').value=slide.background;
 $('slide-transition').value=['fade','wipe','push','none'].includes(slide.transition?.type)?slide.transition.type:'fade';
 $('slide-duration').value=slide.transition?.duration??400;
 const stage=$('stage');stage.replaceChildren();stage.style.background=slide.background;
 slide.elements.forEach(e=>{
   const div=document.createElement('div');div.className='slide-element'+(e.id===elementId?' active':'');
   div.style.left=e.x+'%';div.style.top=e.y+'%';div.style.width=e.w+'%';div.style.height=e.h+'%';
   if(e.type==='rectangle'||e.type==='ellipse'){div.style.background=e.fill;if(e.type==='ellipse')div.style.borderRadius='50%';}
   else if(e.type==='image'){if(e.image){const img=document.createElement('img');img.src=e.image;img.style.cssText='width:100%;height:100%;object-fit:contain;pointer-events:none';div.append(img);}}
   else {div.append(document.createTextNode(e.text));div.style.color=e.color;div.style.fontSize=(e.fontSize*stage.getBoundingClientRect().width/1920)+'px';div.style.lineHeight='1.15';}
   const corner=document.createElement('span');corner.className='resize-handle';div.append(corner);
   div.addEventListener('pointerdown',evt=>{
     evt.preventDefault();elementId=e.id;
     [...stage.children].forEach(n=>n.classList.toggle('active',n===div));renderInspector();
     div.setPointerCapture(evt.pointerId);
     const rect=stage.getBoundingClientRect(),sx=evt.clientX,sy=evt.clientY;
     const ox=e.x,oy=e.y,ow=e.w,oh=e.h,resizing=evt.target===corner;
     function move(m){
       if(m.pointerId!==evt.pointerId)return;
       const dx=(m.clientX-sx)/rect.width*100,dy=(m.clientY-sy)/rect.height*100;
       if(resizing){e.w=clamp(ow+dx,2,100-e.x);e.h=clamp(oh+dy,2,100-e.y);}
       else {e.x=clamp(ox+dx,0,100-e.w);e.y=clamp(oy+dy,0,100-e.h);}
       div.style.left=e.x+'%';div.style.top=e.y+'%';div.style.width=e.w+'%';div.style.height=e.h+'%';
     }
     const done=()=>{div.removeEventListener('pointermove',move);div.removeEventListener('pointerup',done);render();};
     div.addEventListener('pointermove',move);div.addEventListener('pointerup',done,{once:true});
   });
   stage.append(div);
 });
 renderInspector();
}
function renderInspector(){
 const e=element();$('element-fields').hidden=!e;$('inspector-empty').hidden=!!e;
 if(!e)return;
 $('el-text').parentElement.hidden=e.type!=='text';
 $('el-color').parentElement.hidden=e.type!=='text';
 $('el-fill').parentElement.hidden=e.type==='text'||e.type==='image';
 $('el-font').parentElement.hidden=e.type!=='text';
 $('el-text').value=e.text;$('el-color').value=e.color;$('el-fill').value=e.fill;
 $('el-font').value=e.fontSize;$('el-step').value=e.appearStep||0;
}
function addElement(type,extra={}){
 const e=makeElement(type,extra);current().elements.push(e);elementId=e.id;render();
}
for(const btn of document.querySelectorAll('[data-add]'))btn.onclick=()=>addElement(btn.dataset.add);
$('add-image').onclick=()=>$('image-file').click();
$('image-file').onchange=event=>{
 const file=event.target.files[0];if(!file)return;
 if(file.size>4*1024*1024){$('status').textContent='Image must be smaller than 4 MB';return;}
 const reader=new FileReader();reader.onload=()=>addElement('image',{image:reader.result,text:'',w:40,h:40});reader.readAsDataURL(file);
 event.target.value='';
};
$('add-slide').onclick=()=>{media.slides.push(makeSlide());slideIndex=media.slides.length-1;elementId=null;render();};
$('duplicate-slide').onclick=()=>{const slide=JSON.parse(JSON.stringify(current()));slide.id=require('crypto').randomUUID();slide.name+=' Copy';slide.elements.forEach(e=>e.id=require('crypto').randomUUID());media.slides.splice(slideIndex+1,0,slide);slideIndex++;elementId=null;render();};
$('delete-slide').onclick=()=>{if(media.slides.length<=1)return;media.slides.splice(slideIndex,1);slideIndex=Math.max(0,slideIndex-1);elementId=null;render();};
$('delete-element').onclick=()=>{if(!elementId)return;current().elements=current().elements.filter(e=>e.id!==elementId);elementId=null;render();};
$('deck-title').oninput=e=>{media.name=e.target.value;};
$('slide-name').oninput=e=>{current().name=e.target.value;const label=$('slide-list').children[slideIndex]?.querySelector('.slide-tile-label');if(label)label.textContent=(slideIndex+1)+'. '+e.target.value;};
$('slide-bg').oninput=e=>{current().background=e.target.value;$('stage').style.background=e.target.value;};
$('slide-transition').onchange=e=>{current().transition.type=e.target.value;};
$('slide-duration').oninput=e=>{current().transition.duration=clamp(Number(e.target.value)||0,0,5000);};
for(const [key,field,parse] of [['el-text','text',v=>v],['el-color','color',v=>v],['el-fill','fill',v=>v],['el-font','fontSize',Number],['el-step','appearStep',Number]]){
 $(key).oninput=ev=>{const e=element();if(!e)return;e[field]=parse(ev.target.value);renderSlideOnly();};
}
function renderSlideOnly(){
 const e=element();if(!e)return;
 const div=[...$('stage').children].find(node=>node.classList.contains('active'));
 if(!div)return;
 if(e.type==='text'){[...div.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).forEach(n=>n.remove());div.insertBefore(document.createTextNode(e.text),div.firstChild);div.style.color=e.color;div.style.fontSize=(e.fontSize*$('stage').clientWidth/1920)+'px';}
 if(e.type==='rectangle'||e.type==='ellipse')div.style.background=e.fill;
}
$('cancel').onclick=()=>window.close();
$('save').onclick=()=>{
 const title=$('deck-title').value.trim();if(!title){$('status').textContent='Enter a name first';return;}
 media.name=title;media.slides=media.slides.map(s=>validateSlide(s));
 media.excludedDisplays=[...document.querySelectorAll('#display-exclusions input:checked')].map(x=>x.value);
 ipcRenderer.send('presentation-editor:save',{media,editingIndex});$('status').textContent='Saving…';
};
ipcRenderer.on('presentation-editor:init',(_e,data)=>{
 editingIndex=Number.isInteger(data?.editingIndex)?data.editingIndex:null;
 media=data?.media?JSON.parse(JSON.stringify(data.media)):makePresentation();
 if(!media.slides?.length)media.slides=[makeSlide()];
 const host=$('display-exclusions');host.replaceChildren();
 for(const d of data?.displays||[]){
  const label=document.createElement('label'),input=document.createElement('input');
  input.type='checkbox';input.value=d.id;
  input.checked=Array.isArray(media.excludedDisplays)&&media.excludedDisplays.includes(d.id);
  label.append(input,document.createTextNode(d.name));host.append(label);
 }
 slideIndex=0;$('deck-title').value=media.name;render();
});
