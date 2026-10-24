const {createScheduleMotion}=require('../lib/scheduleMotion');

function rig(reduced=false) {
  document.body.innerHTML='<div id="list"></div>';
  const list=document.getElementById('list');
  const motions=[],cancels=[];
  const animateFn=(node,params)=>{
    motions.push({node,params});
    const api={cancel:jest.fn()};cancels.push(api.cancel);return api;
  };
  const manager=createScheduleMotion(list,{
    view:{matchMedia:()=>({matches:reduced})},
    animateFn,springFn:()=> 'out(3)'
  });
  function draw(items,rects) {
    const before=manager.capture();
    list.innerHTML='';
    items.forEach((item,i)=>{
      const div=document.createElement('div');
      div.className='schedule-item';
      div.dataset.motionId=manager.keyFor(item);
      div.textContent=item.name;
      div.getBoundingClientRect=()=>({top:rects[i],left:10,width:180,height:38});
      list.appendChild(div);
    });
    manager.reconcile(before);
  }
  return {list,draw,motions,cancels,manager};
}

test('stable identity, including duplicate item titles, never modifies saved schedule records',()=>{
  const a={name:'Same'},b={name:'Same'};
  const t=rig();
  t.draw([a,b],[0,50]);
  expect(t.manager.keyFor(a)).not.toBe(t.manager.keyFor(b));
  expect(Object.keys(a)).toEqual(['name']);
  expect(t.motions).toHaveLength(0); // first paint not animated
  t.draw([a,b],[0,50]);
  expect(t.motions).toHaveLength(0); // ordinary selection/re-render
});

test('new schedule items enter from below and existing cards slide into their new positions',()=>{
  const t=rig();
  const a={name:'Verse'},b={name:'Song'},c={name:'Media'};
  t.draw([a,b],[0,50]);
  t.draw([c,a,b],[0,50,100]);
  const entering=t.motions.find(m=>m.node.textContent==='Media');
  expect(entering.params.opacity).toEqual([0,1]);
  expect(entering.params.y).toEqual([11,0]);
  const displaced=t.motions.find(m=>m.node.textContent==='Verse');
  expect(displaced.params.y).toEqual([-50,0]);
  expect(t.list.children).toHaveLength(3);
});

test('reordering uses FLIP animation and keeps business order synchronous',()=>{
  const t=rig(),a={name:'A'},b={name:'B'},c={name:'C'};
  t.draw([a,b,c],[0,50,100]);
  t.draw([c,a,b],[0,50,100]);
  const moved=t.motions.find(m=>m.node.textContent==='C');
  expect(moved.params.y).toEqual([100,0]);
  expect([...t.list.children].map(x=>x.textContent)).toEqual(['C','A','B']);
});

test('removed item fades as inert ghost while the remaining schedule updates immediately',()=>{
  const t=rig(),a={name:'First'},b={name:'Second'};
  t.draw([a,b],[0,50]);
  t.draw([b],[0]);
  expect(t.list.children).toHaveLength(1);
  expect(t.list.firstElementChild.textContent).toBe('Second');
  const exit=t.motions.find(x=>x.node.classList.contains('schedule-motion-ghost'));
  expect(exit.params.opacity).toEqual([1,0]);
  expect(exit.node.style.pointerEvents).toBe('none');
  expect(document.body.contains(exit.node)).toBe(true);
  exit.params.onComplete();
  expect(document.body.contains(exit.node)).toBe(false);
});

test('quick successive reorder interrupts old animations and reduced motion skips them',()=>{
  const t=rig(),a={name:'A'},b={name:'B'};
  t.draw([a,b],[0,50]);
  t.draw([b,a],[0,50]);
  t.draw([a,b],[0,50]);
  expect(t.cancels.some(fn=>fn.mock.calls.length>0)).toBe(true);
  t.manager.destroy();
  const reduce=rig(true),x={name:'X'},y={name:'Y'};
  reduce.draw([x],[0]);reduce.draw([x,y],[0,50]);
  reduce.draw([y],[0]);
  expect(reduce.motions).toHaveLength(0);
  expect(document.querySelectorAll('.schedule-motion-ghost')).toHaveLength(0);
});

test('renderer calls animation controller only around schedule DOM, not preview or live output',()=>{
  const fs=require('fs'),path=require('path');
  const source=fs.readFileSync(path.join(__dirname,'..','renderer.js'),'utf8');
  const start=source.indexOf('function renderSchedule() {');
  const end=source.indexOf('\nfunction deleteScheduleItem(',start);
  const impl=source.slice(start,end);
  expect(impl).toContain('scheduleMotion.capture()');
  expect(impl).toContain('scheduleMotion.keyFor(item)');
  expect(impl).toContain('scheduleMotion.reconcile(motionSnapshot)');
  expect(impl).not.toContain('set-live');
});
