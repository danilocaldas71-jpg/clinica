import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Carrega as mesmas funções usadas pela interface e pelo servidor; simula relógio, formulários e armazenamento.
const html = readFileSync(new URL('./dist/index.html', import.meta.url), 'utf8');
const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
const logic = script.slice(0, script.indexOf("\n$('actor').onchange")) +
  script.slice(script.indexOf('function dispatch(action,id)'), script.indexOf('// Browser initialization'));
let now = Date.parse('2026-11-11T07:00:00-03:00');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const scenario = `
const dates=['2026-11-11','2026-11-12'];
const starts=[480,570,660,790,870,960];
const rows=[];
const report=(scenario,expected,observed,failure='Nenhuma')=>rows.push({scenario,expected,observed,failure});
const initial=structuredClone(state);
const setTime=(date,minutes)=>setClock(clinicInstant(date,minutes));
let submit;
dialog=(_title,_body,_label,callback)=>{submit=callback;};
finish=()=>{refreshStockPendencies();};
const form=(values={})=>({
 get:key=>values[key]??null,
 getAll:key=>Array.isArray(values[key])?values[key]:[],
 [Symbol.iterator]:()=>Object.entries(values)[Symbol.iterator]()
});
const source='carga-inicial';
function pack(i,lot=source,status='Disponível'){
 return {id:'p-'+lot+'-'+i,code:'PK-'+lot+'-'+i,item:'i1',lot,valid:'2026-11-15',status,
  photo1:'data:image/png;base64,AA=='};
}
function reset(qty){
 state=structuredClone(initial);
 state.jobs=[];state.patients=[];state.packs=Array.from({length:qty},(_,i)=>pack(i));
 state.lots=[{id:source,code:'Carga inicial fictícia',date:'2026-11-10',cycleTime:'13:00',released:true,
  releasedAt:'2026-11-10T14:15:00-03:00'}];
 state.sterileReplenishment=[];state.sterilizationBlocks=[];
 setTime(dates[0],420);
 updateWeeklyOpening();
}
function schedule(){
 for(const date of dates)for(const [wave,start] of starts.entries()){
  const pair=wave%2===0?['d1','d2']:['d3','d4'];
  for(const dent of pair){
   const ortho=dent==='d4';
   const draft={id:date+'-'+dent+'-'+start,dent,patient:'Paciente fictício',date,early:start,late:start,duration:40,
    worker:'auto',specialty:ortho?'Ortodontia':'Diagnóstico',procedure:ortho?undefined:'p1',
    items:{i1:1,i2:1},notes:'Simulação',prepConfigured:true};
   const result=suggestBooking(draft);
   assert(result.match,result.error);
   const confirmed=confirmAssistantMatch({...draft,worker:result.match.worker},result.match,result.displaced);
   state.jobs.push({...confirmed.match,status:confirmed.shortages.length?'Reservado com pendência':'Confirmado'});
  }
 }
 refreshStockPendencies();
}
function count(date){
 const all=state.jobs.filter(job=>job.date===date&&!isCancelled(job));
 const shortages=new Set(sterileNeeds().map(need=>need.job.id));
 return {horario:all.length,auxiliar:all.filter(job=>isAssistant(person(job.worker))).length,
  material:all.filter(job=>!shortages.has(job.id)&&job.status!=='Reservado com pendência').length};
}
reset(24);schedule();
for(const date of dates)assert.deepEqual(Object.values(count(date)),[12,12,12]);
report('Estoque inicial de 24 kits','12 com horário, ASB e material por dia',dates.map(date=>JSON.stringify(count(date))).join(' / '));

reset(12);schedule();
assert.deepEqual(Object.values(count(dates[0])),[12,12,12]);
assert.deepEqual(Object.values(count(dates[1])),[12,12,0]);
assert.equal(sterileNeeds().filter(need=>need.job.date===dates[1]).reduce((total,need)=>total+need.missing,0),12);
report('12 kits sem reposição','D1 12/12; D2 0/12 com material','D1 12/12; D2 12 horários e ASBs, 12 pendências de 1 kit');

const dayOne=state.jobs.filter(job=>job.date===dates[0]);
const target=dayOne.at(-1), worker=target.worker;
actor=worker;
setTime(dates[0],roomStart(target,dayJobs(dates[0])));
const selected=packagesForPreparation(target)[0];
assert(selected);
prepareJob(target.id);submit(form({checkedRoom:'on',pack:[selected.id]}));
assert.equal(selected.status,'Separado');
assert.equal(selected.job,target.id);
assert.equal(sterileNeeds().filter(need=>need.job.date===dates[1]).length,12);
actor='r1';cancelAppointment(target.id);submit(form({status:'Cancelado',note:'Paciente fictício'}));
assert.equal(selected.status,'Aguardando reprocessamento');
assert.equal(selected.previousJob,target.id);
assert.equal(count(dates[1]).material,0);
report('Cancelamento após separação','Kit separado não volta ao estoque e mantém vínculo','Cancelamento registrou o kit como Aguardando reprocessamento e preservou previousJob');

const scheduledBlock={id:'bloco-reposicao',date:'2026-11-10',start:480,end:555,worker:'t1'};
actor='rt';
assert.throws(()=>saveSterilizationBlock({...scheduledBlock,date:dates[0]}),/Conflito de escala/);
const possibleStarts=[];
for(const assistant of state.people.filter(isAssistant)){
 const hours=workingHours(assistant,dates[0]);
 for(let start=hours.start;start+75<=hours.last+prepAfter;start++){
  const availability=assistantAvailability(assistant,dates[0],start,start+75,dayOne);
  if(!availability.hard.length&&!availability.visits.length)possibleStarts.push({start,assistant:assistant.id});
 }
}
assert.equal(possibleStarts.length,0);
setTime(scheduledBlock.date,470);
saveSterilizationBlock(scheduledBlock);
report('Janela de esterilização de 75 min','A escala recusa janela que cruza consulta','Nenhum intervalo de 75 min livre no D1; bloco cadastrado no dia anterior sem compromissos');
const plan={id:'reposicao',item:'i1',block:scheduledBlock.id,capacity:12,preparation:15,cycle:45,release:15};
state.sterileReplenishment=[plan];
assert.equal(replenishmentEstimate(plan),clinicInstant(scheduledBlock.date,555));
const forecastNeeds=sterileNeeds();
assert.equal([...replenishmentCoverage(forecastNeeds).values()].reduce((sum,qty)=>sum+qty,0),12);
assert.equal(count(dates[1]).material,0);
report('Previsão de 12 kits','Previsão de 12; estoque disponível continua zero no D2','12 projetados separadamente; 0/12 com material físico até liberar o lote');

const nextLot={id:'lote-dia-dois',code:'Lote D2 fictício',date:dates[1],cycleTime:'07:00',released:false,replenishment:plan.id};
state.lots.push(nextLot);
setTime(dates[1],420);
actor='rt';
const renewed=reprocessPackage(selected,nextLot,'PK-REPROCESSADO','2026-11-15');
renewed.photo1='data:image/png;base64,AA==';
renewed.status='Aguardando liberação';
state.packs.push(...Array.from({length:11},(_,i)=>pack(i,nextLot.id,'Aguardando liberação')));
assert.equal(renewed.previousLot,source);
assert.equal(renewed.previousPack,selected.id);
assert.equal(renewed.previousJob,target.id);
assert.equal(selected.reprocessedInto,renewed.id);
assert.equal(availablePackage(renewed,Date.now()),false);
report('Reprocessamento','Nova etiqueta e lote com histórico do kit original','previousPack, previousLot, previousJob e reprocessedInto conferidos');

const morning=state.jobs.find(job=>job.date===dates[1]&&job.start===480);
setTime(dates[1],470);
assert.equal(packagesForPreparation(morning).length,1);
actor='rt';
assert.equal(count(dates[1]).material,0);
assert.equal(recordSterileShortages(),0);
assert.equal(recordSterileShortages(),0,'A mesma falta não deve ser duplicada.');
setTime(dates[1],550);
dispatch('release',nextLot.id);submit(form({checkedRelease:'on'}));
assert(nextLot.released);
assert.equal(nextLot.releasedBy,'rt');
assert.equal(count(dates[1]).material,12);
const upcoming=state.jobs.filter(job=>job.date===dates[1]&&roomStart(job,dayJobs(dates[1]))>=550);
assert.equal(upcoming.length,10);
assert.equal(availablePackage(renewed,Date.now()),true);
assert.equal(state.jobs.filter(job=>job.sterileShortages?.length).length,0);
day=dates[1];
report("Virada do dia sem separação","Excluir reservas do dia anterior ","Demanda anterior excluída ");
assert(!sterileNeeds().some(need=>need.job.date===dates[0]));

reset(12);schedule();
const cancelled=state.jobs.find(job=>job.date===dates[0]);
actor='r1';cancelAppointment(cancelled.id);submit(form({status:'Cancelado',note:'Teste'}));
assert.equal(count(dates[1]).material,1);
report('Cancelamento antes da separação','A primeira demanda do D2 recebe o kit liberado','D2 passa de 0/12 a 1/12 com material');

reset(12);schedule();
const moved=state.jobs.find(job=>job.date===dates[0]);
actor=moved.dent;
editAppointmentTime(moved.id);
submit(form({date:'2026-11-13',start:'08:00',worker:moved.worker}));
submit(form());
assert.equal(moved.date,'2026-11-13');
assert.equal(count(dates[1]).material,1);
assert.equal(moved.status,'Reservado com pendência');
report('Reagendamento de D1 para D3','Um kit migra para D2; D3 fica pendente','D2 1/12 com material, consulta movida para D3 com pendência');

reset(0);schedule();
const invalid={id:'lote-futuro',date:dates[1],cycleTime:'06:00',released:true,
 releasedAt:'2026-11-12T07:00:00-03:00'};
state.lots.push(invalid);
state.packs.push(pack(1,invalid.id));
assert.equal(availablePackage(state.packs[0],Date.now()),false);
const projected=sterileProjection();
const wasCounted=projected.claimed.has(state.packs[0].id);
report('Lote importado com liberação futura','0 kits liberados na projeção de hoje',
 wasCounted?'1 kit contado no D2 antes da liberação':'0 kits contados',
 wasCounted?'Projeção incluiu lote marcado como liberado no futuro':'Nenhuma');

console.table(rows);
assert.equal(wasCounted,false,'Previsão futura não pode ser comprometida como estoque disponível');
`;
const context=vm.createContext({
  assert,console,structuredClone,crypto:webcrypto,Date:Clock,
  clinicServerReplay:true,setClock:instant=>{now=instant;},
  localStorage:{getItem:()=>null}
});
vm.runInContext(logic+'\n'+scenario,context,{timeout:20000});
