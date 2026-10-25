'use strict';
const fs=require('fs');
const path=require('path');
async function parsePptx(filePath){
 const [{parse},{renderSlide}]=await Promise.all([import('@pagus-kit/core'),import('@pagus-kit/renderer')]);
 const bytes=await fs.promises.readFile(filePath);
 const array=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
 const deck=await parse(array);
 if(!Array.isArray(deck?.slides)||!deck.slides.length)throw new Error('This presentation has no readable slides.');
 const slides=deck.slides.slice(0,300).map((slide,i)=>{
   const render=ir=>{
     const result=renderSlide(ir,deck.slideSize);
     if(!result?.svg||!result.svg.includes('<svg'))throw Error('Slide '+(i+1)+' could not be rendered.');
     // Chromium offscreen capture is unreliable for the renderer's very
     // tall XHTML foreignObject text boxes. Convert textual runs to actual
     // SVG <text> elements so both live and network rasters remain legible.
     return result.svg.replace(/<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi,(whole,attrs,inner)=>{
       const find=(key,defaultValue)=>Number(attrs.match(new RegExp('\\b'+key+'="(-?[\\d.]+)"'))?.[1]??defaultValue);
       const width=find('width',640), rawHeight=find('height',100);
       const y=find('y',0), x=find('x',0);
       const height=y<0?Math.min(rawHeight,Math.max(80,width*.175)):rawHeight;
       const content=inner.match(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)||[];
       const firstStyle=content[0]?.match(/style="([^"]*)"/)?.[1]||'';
       const font=Number(firstStyle.match(/font-size:\s*([\d.]+)px/)?.[1]||30);
       const color=firstStyle.match(/color:\s*(#[\da-fA-F]{3,8})/)?.[1]||'#FFFFFF';
       const weight=/font-weight:\s*(bold|[6-9]00)/.test(firstStyle)?'bold':'normal';
       const spans=content.map(run=>run.replace(/<[^>]+>/g,'')).filter(Boolean);
       if(!spans.length)return '';
       // All runs share one line in this fallback; real rich-text layout is
       // still retained in the original PPTX for future full fidelity.
       const text=spans.join('').replace(/&(?!(?:amp|lt|gt|quot|apos|#\\d+|#x[0-9a-f]+);)/gi,'&amp;')
         .replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
       const baseline=Math.max(font,Math.min(height-6,height/2+font*.35));
       return '<text x="'+(x+9.6)+'" y="'+(Math.max(0,y)+baseline)+'" fill="'+color+'" font-size="'+font+'" font-weight="'+weight+'" font-family="Arial, sans-serif">'+text+'</text>';
     });
   };
   const steps=[];
   const effects=slide.animations?.steps||[];
   const all=Array.isArray(slide.elements)?slide.elements:[];
   const hidden=new Set(slide.animations?.hiddenShapeIds||[]);
   // Preserve common click-to-reveal sequences. Complex motion paths are
   // represented by their resulting visible state until we have an exact
   // real-time animation executor.
   const snapshot=()=>render({...slide,elements:all.filter(el=>!hidden.has(String(el.id)))});
   steps.push(snapshot());
   for(const item of effects.slice(0,80)){
     for(const effect of item.effects||[]){
       if(effect.animClass==='entrance')hidden.delete(String(effect.targetId));
       else if(effect.animClass==='exit')hidden.add(String(effect.targetId));
     }
     steps.push(snapshot());
   }
   const t=slide.transition||{};
   return {name:'Slide '+(i+1),svg:steps[0],stepSvgs:steps,
     transition:{type:typeof t.type==='string'?t.type:'fade',
       duration:Number.isFinite(t.duration)?t.duration:450,
       direction:t.direction||null}};
 });
 return {slides};
}
module.exports={parsePptx};
