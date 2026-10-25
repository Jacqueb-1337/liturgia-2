'use strict';

const crypto=require('crypto');
const VALID_TYPES=new Set(['text','rectangle','ellipse','image']);
const enc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(v,defaultValue,min,max)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):defaultValue;
const allowedColor=v=>/^#[0-9a-f]{3,8}$/i.test(String(v))?v:'#ffffff';
const makeElement=(type,extra={})=>({
 id:crypto.randomUUID(),type,x:10,y:15,w:45,h:18,
 text:type==='text'?'New text':'',fill:type==='rectangle'?'#265c99':'#ffffff',
 color:'#ffffff',fontSize:48,appearStep:0,...extra
});
function makeSlide(){
 return {id:crypto.randomUUID(),name:'New Slide',background:'#14243b',
  transition:{type:'fade',duration:400},elements:[makeElement('text',{text:'Your title',x:8,y:34,w:84,fontSize:74})]};
}
function makePresentation(name='New Presentation'){
 return {id:crypto.randomUUID(),type:'PRESENTATION',name,source:'native',
   slides:[makeSlide()],excludedDisplays:[],addedDate:new Date().toISOString()};
}
function validateSlide(slide){
 const safe={id:String(slide?.id||crypto.randomUUID()),name:String(slide?.name||'Slide').slice(0,140),
  background:allowedColor(slide?.background),transition:{
   type:['fade','wipe','push','none'].includes(slide?.transition?.type)?slide.transition.type:'fade',
   duration:number(slide?.transition?.duration,400,0,5000)},elements:[]};
 for(const item of (Array.isArray(slide?.elements)?slide.elements:[]).slice(0,100)){
  if(!VALID_TYPES.has(item?.type))continue;
  safe.elements.push({id:String(item.id||crypto.randomUUID()),type:item.type,
   x:number(item.x,0,0,100),y:number(item.y,0,0,100),w:number(item.w,25,1,100),
   h:number(item.h,15,1,100),text:String(item.text||'').slice(0,5000),
   fill:allowedColor(item.fill),color:allowedColor(item.color),
   fontSize:number(item.fontSize,48,10,180),appearStep:number(item.appearStep,0,0,50),
   image:typeof item.image==='string'&&/^data:image\/(png|jpeg|webp|gif);base64,/.test(item.image)?item.image:null});
 }
 return safe;
}
function maxStep(slide){return Math.max(0,...(slide.elements||[]).map(e=>Number(e.appearStep)||0));}
function renderSlideSvg(slide,step=maxStep(slide)){
 const s=validateSlide(slide);
 const defs='<defs><style>text{font-family:Arial,sans-serif}</style></defs>';
 const elems=s.elements.filter(e=>e.appearStep<=step).map(e=>{
  const x=e.x*19.2,y=e.y*10.8,w=e.w*19.2,h=e.h*10.8;
  if(e.type==='rectangle')return '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+enc(e.fill)+'"/>';
  if(e.type==='ellipse')return '<ellipse cx="'+(x+w/2)+'" cy="'+(y+h/2)+'" rx="'+w/2+'" ry="'+h/2+'" fill="'+enc(e.fill)+'"/>';
  if(e.type==='image')return e.image?'<image href="'+enc(e.image)+'" x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" preserveAspectRatio="xMidYMid meet"/>':'';
  const lines=e.text.split('\n');
  return '<text x="'+x+'" y="'+(y+e.fontSize)+'" fill="'+enc(e.color)+'" font-size="'+e.fontSize+'" font-family="Arial" xml:space="preserve">'+
   lines.map((line,i)=>'<tspan x="'+x+'" dy="'+(i===0?0:e.fontSize*1.24)+'">'+enc(line)+'</tspan>').join('')+'</text>';
 }).join('');
 return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080" width="1920" height="1080">'+defs+'<rect width="1920" height="1080" fill="'+enc(s.background)+'"/>'+elems+'</svg>';
}
function nextPosition(media,index,step,forward=true){
 const slides=media?.slides||[];if(!slides.length)return null;
 let i=Math.min(slides.length-1,Math.max(0,index||0)),n=Math.max(0,step||0);
 const max=s=>s?.steps?.length?Math.max(0,s.steps.length-1):s?.elements?maxStep(s):0;
 if(forward){if(n<max(slides[i]))n++;else if(i<slides.length-1){i++;n=0;}}
 else if(n>0)n--;else if(i>0){i--;n=max(slides[i]);}
 return {index:i,step:n};
}
module.exports={makePresentation,makeSlide,makeElement,validateSlide,renderSlideSvg,maxStep,nextPosition};
