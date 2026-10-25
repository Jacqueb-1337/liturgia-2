'use strict';
const fs=require('fs'),path=require('path');
const {makePresentation,makeSlide,makeElement,renderSlideSvg,nextPosition,validateSlide}=require('../lib/presentationSlides');
const {routeWidgetForDisplay}=require('../lib/widgetDisplayRouting');

test('new presentations have one selected-able slide and safe default',()=>{
 const p=makePresentation('Announcements');
 expect(p.type).toBe('PRESENTATION');expect(p.source).toBe('native');
 expect(p.slides).toHaveLength(1);
 expect(p.slides[0].transition.type).toBe('fade');
});
test('next/previous iterate reveal steps before adjacent slides',()=>{
 const p=makePresentation();
 p.slides[0].elements.push(makeElement('text',{text:'Later',appearStep:2}));
 p.slides.push(makeSlide());
 expect(nextPosition(p,0,0,true)).toEqual({index:0,step:1});
 expect(nextPosition(p,0,1,true)).toEqual({index:0,step:2});
 expect(nextPosition(p,0,2,true)).toEqual({index:1,step:0});
 expect(nextPosition(p,1,0,false)).toEqual({index:0,step:2});
 expect(nextPosition(p,1,0,true)).toEqual({index:1,step:0});
});
test('Native SVG includes only current or prior reveal steps and escapes dangerous text',()=>{
 const p=makePresentation(),slide=p.slides[0];
 slide.elements.push(makeElement('text',{text:'<script>alert("bad")</script>',appearStep:1}));
 const step0=renderSlideSvg(slide,0),step1=renderSlideSvg(slide,1);
 expect(step0).not.toContain('alert');
 expect(step1).toContain('&lt;script&gt;alert(&quot;bad&quot;)&lt;/script&gt;');
 expect(step1).not.toContain('<script>');
});
test('validation rejects unsupported elements, dangerous remote image sources, and invalid bounds',()=>{
 const slide=makeSlide();
 slide.elements=[
  makeElement('iframe',{src:'https://evil.example'}),
  makeElement('image',{image:'javascript:alert(1)',x:-50,w:1000}),
  makeElement('text',{text:'Valid',fontSize:999,appearStep:999})
 ];
 const safe=validateSlide(slide);
 expect(safe.elements).toHaveLength(2);
 expect(safe.elements[0].image).toBeNull();
 expect(safe.elements[0].x).toBe(0);
 expect(safe.elements[0].w).toBe(100);
 expect(safe.elements[1].fontSize).toBe(180);
 expect(safe.elements[1].appearStep).toBe(50);
});
test('physical and network display exclusions blank presentation only on targeted outputs',()=>{
 const data={isPresentationSlide:true,mediaType:'PNG',mediaPath:'C:\\slides\\image.png',
  presentationExcludedDisplays:['window:5','network:0','network:profile-x']};
 const physical=routeWidgetForDisplay(data,'window',5);
 expect(physical.mediaPath).toBeNull();expect(physical.mediaType).toBe('COLOR');expect(physical.mediaColor).toBe('#000000');
 expect(routeWidgetForDisplay(data,'network','0').presentationExcluded).toBe(true);
 expect(routeWidgetForDisplay(data,'network','profile-x').presentationExcluded).toBe(true);
 expect(routeWidgetForDisplay(data,'window',6)).toBe(data);
 expect(routeWidgetForDisplay({isMedia:true,mediaPath:'C:\\slides\\image.png'},'window',5).mediaPath).toContain('image.png');
});
test('Media tile, editor, mini-player and schedule use unified presentation type',()=>{
 const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
 const renderer=fs.readFileSync(path.join(__dirname,'..','renderer.js'),'utf8');
 const grid=require('../lib/mediaLibraryGrid').renderMediaLibraryGrid({
  allMedia:[{type:'PRESENTATION',name:'Test Deck',slides:[{name:'Slide 1',path:'C:\\slides\\0.png'}]}],showCreateColor:false
 });
 expect(grid).toContain('1 slides');expect(grid).toContain('0.png');
 for(const id of ['presentation-mini','presentation-slide-list','presentation-live-nav','presentation-prev','presentation-next','media-add-menu-pptx','media-add-menu-slides'])
   expect(html).toContain('id="'+id+'"');
 expect(renderer).toContain('presentationRuntime?.showPreview(deck,slideIndex)');
 expect(renderer).toContain('presentationRuntime?.goLive(deck,slideIndex,0)');
 expect(renderer).toContain("allMedia[item.mediaIndex]?.type==='PRESENTATION'");
});
