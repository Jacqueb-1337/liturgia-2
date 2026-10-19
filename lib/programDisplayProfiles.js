'use strict';
const crypto=require('crypto');
const {PROGRAM_STYLE_KEYS,decodeProgramStyles,applyProgramStylePatch}=require('./programStyles');
const LIMIT=32;
const LAYOUT_DEFAULTS=Object.freeze({
  x:0,y:0,width:1920,height:1080,opacity:1,transparent:true,
  cropLeft:0,cropTop:0,cropRight:0,cropBottom:0,panX:0,panY:0,zoom:1
});
const BOUNDS={
  x:[-1920,3840],y:[-1080,2160],width:[20,3840],height:[20,2160],
  opacity:[0,1],cropLeft:[0,.95],cropTop:[0,.95],
  cropRight:[0,.95],cropBottom:[0,.95],panX:[-100,100],panY:[-100,100],zoom:[1,5]
};
function normalizeLayout(layout,previous=LAYOUT_DEFAULTS){
  const next={...LAYOUT_DEFAULTS,...previous};
  if(!layout || typeof layout!=='object'||Array.isArray(layout))return next;
  for(const [key,value] of Object.entries(layout)){
    if(key==='transparent'){if(typeof value!=='boolean')throw Error('Transparency must be on or off.');next.transparent=value;continue}
    if(!BOUNDS[key])throw Error('Unknown display layout property.');
    if(typeof value!=='number'||!Number.isFinite(value))throw Error('Invalid layout value.');
    next[key]=Math.min(BOUNDS[key][1],Math.max(BOUNDS[key][0],value));
  }
  return next;
}

function listProgramDisplays(settings) {
  const profiles=Array.isArray(settings?.programDisplayProfiles)?settings.programDisplayProfiles:[];
  return profiles.filter(p=>p&&typeof p.id==='string'&&typeof p.name==='string').map(p=>({
    id:p.id,name:p.name,styles:decodeProgramStyles(p.styles||{}),layout:normalizeLayout(p.layout),
    revision:Number.isSafeInteger(p.revision)?p.revision:1,
    updatedAt:p.updatedAt||null
  }));
}
function makeProgramDisplay(settings,request) {
  const profiles=listProgramDisplays(settings);
  if(profiles.length>=LIMIT)throw Error('Maximum of 32 Program displays reached.');
  const name=String(request?.name||'New Stream Display').trim().slice(0,64);
  if(!name)throw Error('Enter a display name.');
  const now=new Date().toISOString();
  const item={id:crypto.randomUUID(),name,styles:{},layout:normalizeLayout(request?.layout),revision:1,updatedAt:now};
  item.styles=applyProgramStylePatch({},request?.styles||{});
  return {...settings,programDisplayProfiles:[...(settings.programDisplayProfiles||[]),item]};
}
function updateProgramDisplay(settings,id,patch) {
  if(!/^[\w-]{8,80}$/.test(String(id)))throw Error('Invalid display ID.');
  const old=(settings.programDisplayProfiles||[]).find(x=>x.id===id);
  if(!old)throw Error('Program display not found.');
  const version=Number(patch?.expectedRevision);
  if(!Number.isSafeInteger(version)||version!==old.revision) {
    const error=new Error('The display changed in Worship. Reload before saving.');
    error.conflict=true;throw error;
  }
  const name=patch.name===undefined?old.name:String(patch.name).trim().slice(0,64);
  if(!name)throw Error('Enter a display name.');
  const styles=patch.styles===undefined?old.styles:applyProgramStylePatch(old.styles||{},patch.styles);
  const layout=patch.layout===undefined?normalizeLayout(old.layout):normalizeLayout(patch.layout,old.layout);
  const item={...old,name,styles,layout,revision:old.revision+1,updatedAt:new Date().toISOString()};
  return {...settings,programDisplayProfiles:settings.programDisplayProfiles.map(x=>x.id===id?item:x)};
}
function removeProgramDisplay(settings,id) {
  if(!(settings.programDisplayProfiles||[]).some(x=>x.id===id))throw Error('Program display not found.');
  return {...settings,programDisplayProfiles:settings.programDisplayProfiles.filter(x=>x.id!==id)};
}
module.exports={listProgramDisplays,makeProgramDisplay,updateProgramDisplay,removeProgramDisplay,normalizeLayout,LAYOUT_DEFAULTS};
