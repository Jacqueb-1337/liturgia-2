'use strict';

// Liturgia's original flame, faithfully vector-traced from the 20 silhouettes
// in loading.gif. GSAP drives a continuously interpolated contour at the
// display refresh rate, rather than stepping through ten raster frames/sec.
const { gsap } = require('gsap');
const source = require('./flameSourceFrames.json');

const frames = source.frames;
const POINTS = source.pointsPerFrame;
const FRAME_COUNT = source.frameCount;
const DURATION = FRAME_COUNT / source.fps; // Preserve original 2-second gesture.

function geometryAt(framePosition) {
  const count = frames.length;
  const f = ((framePosition % count) + count) % count;
  const index = Math.floor(f), t = f - index;
  const before = frames[(index-1+count)%count];
  const a = frames[index], b = frames[(index+1)%count];
  const after = frames[(index+2)%count];
  const t2=t*t, t3=t2*t;
  const h00=2*t3-3*t2+1, h10=t3-2*t2+t, h01=-2*t3+3*t2, h11=t3-t2;
  // Periodic Hermite interpolation keeps the tip and sides moving without
  // the repeated stop/go easing of individually chained tweens.
  const points = new Array(POINTS);
  for(let k=0;k<POINTS;k++){
    const point=new Array(2);
    for(let axis=0;axis<2;axis++){
      const v0=a[k][axis],v1=b[k][axis];
      const entry=(v1-before[k][axis])*.28;
      const exit=(after[k][axis]-v0)*.28;
      point[axis]=h00*v0+h10*entry+h01*v1+h11*exit;
    }
    points[k]=point;
  }
  return points;
}

const fmt=v=>Math.round(v*100)/100;

// Spatial cubic interpolation yields smooth edges without using the jagged
// pixel boundaries in the original GIF. All contours are aligned to the
// left-hand lower prong and share the same 72 arc-length samples.
function pathFromPoints(points){
  const n=points.length;
  if(n<3)return '';
  let path='M'+fmt(points[0][0])+' '+fmt(points[0][1]);
  for(let k=0;k<n;k++){
    const prev=points[(k+n-1)%n],a=points[k],b=points[(k+1)%n],next=points[(k+2)%n];
    const c1x=a[0]+(b[0]-prev[0])/6, c1y=a[1]+(b[1]-prev[1])/6;
    const c2x=b[0]-(next[0]-a[0])/6, c2y=b[1]-(next[1]-a[1])/6;
    path+='C'+fmt(c1x)+' '+fmt(c1y)+' '+fmt(c2x)+' '+fmt(c2y)+' '+fmt(b[0])+' '+fmt(b[1]);
  }
  return path+'Z';
}
function pathAt(framePosition){return pathFromPoints(geometryAt(framePosition));}
const SHAPES=Object.freeze({
  body:Object.freeze({rest:pathAt(0), lift:pathAt(2), lean:pathAt(13)}),
  hollow:Object.freeze({rest:'',lift:'',lean:''}) // Legacy API compatibility
});

function createFlameBoot(root,options={}){
  if(!root)throw Error('Flame SVG root is required');
  const path=root.querySelector('#boot-flame-body');
  if(!path)throw Error('Flame SVG body path is required');
  const view=options.view||root.ownerDocument?.defaultView;
  const media=view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const prefersReduced=!!media?.matches;
  let destroyed=false,loop=null;
  let renderedFrame=0;
  const state={frame:0};
  const update=()=>{
    if(destroyed)return;
    renderedFrame=state.frame;
    path.setAttribute('d',pathAt(state.frame));
  };
  update();
  if(options.animate!==false&&!prefersReduced){
    loop=gsap.to(state,{
      frame:FRAME_COUNT,
      duration:DURATION,
      ease:'none',
      repeat:-1,
      paused:!!options.paused,
      onUpdate:update,
      onRepeat:update
    });
  }
  function setTime(seconds){
    if(destroyed)return;
    if(loop){
      loop.pause();
      loop.time(((seconds%DURATION)+DURATION)%DURATION);
      update();
    } else {
      state.frame=(((seconds%DURATION)+DURATION)%DURATION)/DURATION*FRAME_COUNT;
      update();
    }
  }
  function onMotionChange(){
    if(destroyed)return;
    if(media.matches) {
      loop?.pause();
      state.frame=0;update();
    }else if(loop)loop.play();
    else if(options.animate!==false){
      loop=gsap.to(state,{frame:FRAME_COUNT,duration:DURATION,ease:'none',repeat:-1,onUpdate:update});
    }
  }
  media?.addEventListener?.('change',onMotionChange);
  function destroy(){
    if(destroyed)return;
    destroyed=true;
    media?.removeEventListener?.('change',onMotionChange);
    view?.removeEventListener?.('pagehide',destroy);
    loop?.kill(); loop=null;
  }
  view?.addEventListener?.('pagehide',destroy,{once:true});
  return {setTime,destroy,get duration(){return DURATION;},get isAnimated(){return !!loop;},get currentFrame(){return renderedFrame;}};
}

module.exports={createFlameBoot,SHAPES,pathAt,geometryAt,FRAME_COUNT,DURATION};
