const {createOperatorNotifications,STORE_KEY}=require('../lib/operatorNotifications');

beforeEach(()=>{document.body.innerHTML='';localStorage.clear();});
test('queues independent messages and supports severity, read and dismiss',()=>{
  const center=createOperatorNotifications({doc:document,storage:localStorage});
  center.add({id:'js-error',title:'Error in renderer',severity:'error',body:'Unexpected failure',actions:[{id:'save-report',label:'Save Report'}]});
  center.add({id:'network',title:'Network access',severity:'warning',body:'Rule check failed',actions:[{id:'fix',label:'Fix'}]});
  expect(center.getMessages()).toHaveLength(2);
  expect(document.querySelector('#liturgia-notification-button').textContent).toContain('2');
  document.querySelector('#liturgia-notification-button').click();
  expect(document.querySelectorAll('.liturgia-notification-entry')).toHaveLength(2);
  expect(center.getMessages().every(x=>x.read)).toBe(true);
  document.querySelector('.lnt-dismiss').click();
  expect(center.getMessages().filter(x=>x.dismissed)).toHaveLength(1);
});
test('persists read status and only alerts again for a new revision',()=>{
  let center=createOperatorNotifications({doc:document,storage:localStorage});
  center.add({id:'news',title:'A message from Liturgia',body:'Hello',origin:'liturgia',revision:'one'});
  expect(document.querySelector('#liturgia-notification-button').textContent).toContain('A message from Liturgia');
  center.show();
  center.dismiss('news');
  center.root.remove();
  center=createOperatorNotifications({doc:document,storage:localStorage});
  center.add({id:'news',title:'A message from Liturgia',body:'Hello',origin:'liturgia',revision:'one'});
  expect(document.querySelector('#liturgia-notification-button').hidden).toBe(true);
  center.add({id:'news',title:'A message from Liturgia',body:'New',origin:'liturgia',revision:'two'});
  expect(center.getMessages()[0].read).toBe(false);
  expect(JSON.parse(localStorage.getItem(STORE_KEY))).toHaveLength(1);
});
test('runs only the action on user click',async()=>{
  const action=jest.fn(async()=>{});
  const center=createOperatorNotifications({doc:document,storage:localStorage,onAction:action});
  center.add({id:'firewall',title:'Network access',actions:[{id:'repair',label:'Fix'}]});
  center.show();
  document.querySelector('.lnt-action').click();
  await new Promise(r=>setTimeout(r,0));
  expect(action).toHaveBeenCalledWith('repair',expect.objectContaining({id:'firewall'}));
});
