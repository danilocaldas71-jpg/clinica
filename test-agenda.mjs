import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const html = readFileSync(new URL('./dist/index.html', import.meta.url), 'utf8');
const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
const source = script.slice(0, script.indexOf("\n$('actor').onchange"));
const report = vm.runInNewContext(source + `
const dates = ['2099-11-12', '2099-11-13'];
const times = [480, 570, 660, 790, 870, 960];
const rows = [];
const row = (scenario, expected, observed, failure = 'Nenhuma') =>
 rows.push({scenario, expected, observed, failure});
const ortho = state.procedures.find(procedure => procedureMatches(procedure, 'Ortodontia'));
const draft = (id, date, start, dent, worker = 'auto', items = {i1:1}) => ({
 id, date, early:start, late:start, dent, worker, items, duration:40,
 patient:'Paciente fictício '+id, status:'Confirmado', prepConfigured:true,
 specialty:dent==='d4'?'Ortodontia':'Diagnóstico', procedure:dent==='d4'?ortho.id:'p1'
});
let submit;
dialog = (_title, _body, _label, handler) => { submit = handler; };
finish = () => refreshStockPendencies();
function reset(){
 state.jobs = [];
 state.rentals = [];
 state.audit = [];
 state.sterilizationBlocks = [];
 state.sterileReplenishment = [];
 state.lots = [{id:'sim',code:'SIM',date:'2020-01-01',released:true}];
 state.packs = Array.from({length:24},(_,index)=>({
  id:'sim-'+index,code:'SIM-'+index,item:'i1',lot:'sim',
  status:'Disponível',valid:'2099-12-31',photo1:'data:image/png;base64,AA=='
 }));
 for(const worker of ['t1','a1'])person(worker).weeklyHours=undefined;
 actor = 'rt';
}
function book(request, preferredRoom){
 const result = preferredRoom?suggest(request,preferredRoom):suggestBooking(request);
 if(!result.match)return result;
 const checked=confirmAssistantMatch({...request,worker:result.match.worker},result.match,result.displaced);
 state.jobs.push({...checked.match,status:checked.shortages.length?'Reservado com pendência':'Confirmado'});
 return checked;
}
assert.equal(dentists().length,4);
assert.equal(rooms.length,3);
assert.equal(state.people.filter(person=>person.role==='asb').length,2);
assert.deepEqual([...person('d4').clinicalScope.specialties],['Ortodontia']);
assert.equal(prepBefore,10);
assert.equal(prepAfter,10);
reset();
for(const date of dates){
 times.forEach((start,index)=>{
  const pair=index%2===0?['d1','d2']:['d3','d4'];
  for(const dent of pair){
   const result=book(draft(date+'-'+start+'-'+dent,date,start,dent));
   assert(result.match,result.error);
   assert.equal(result.match.start,start);
   assert.equal(result.shortages.length,0);
  }
  const simultaneous=dayJobs(date).filter(job=>job.start===start);
  assert.equal(new Set(simultaneous.map(job=>job.room)).size,2);
  assert.equal(new Set(simultaneous.map(job=>job.worker)).size,2);
 });
 const jobs=dayJobs(date);
 assert.equal(jobs.length,12);
 for(const dentist of dentists())assert.equal(jobs.filter(job=>job.dent===dentist.id).length,3);
}
assert.equal(sterileProjection().claimed.size,24);
assert.equal(sterileNeeds().length,0);
row('Seis duplas em dois dias','12 por dia; 3 por dentista','24/24 com horário, 24/24 com ASB e 24/24 com kit liberado alocado');

reset();
person('t1').weeklyHours=Array.from({length:7},()=>({start:470,last:1000,off:true}));
let count=0;
for(const start of times){
 if(book(draft('A'+start,dates[0],start,'d1')).match)count++;
 if(book(draft('B'+start,dates[0],start,'d2')).match)count++;
}
assert.equal(count,6);
row('Falta de uma ASB','Uma consulta por horário fixo','6/12 com horário, ASB e kit; 6 recusadas nas janelas fixas');

reset();
saveSterilizationBlock({id:'est',date:dates[0],start:780,end:840,worker:'t1'});
const clinical=book(draft('est-clinic',dates[0],790,'d1'));
assert.equal(clinical.match.worker,'a1');
const blocked=suggestBooking(draft('est-blocked',dates[0],790,'d2'));
assert(!blocked.match);
assert.match(blocked.error,/Esterilização/);
assert.equal(dayJobs(dates[0]).length,1);
row('Bloco de esterilização às 13h','Uma das duas consultas às 13h10 fica sem ASB','1/2 com horário, ASB e kit; segunda recusada por esterilização');

reset();
assert(book(draft('late',dates[0],480,'d1','t1'),1).match);
const previous=state.jobs[0];
previous.attendanceStartedAt=dates[0]+'T08:00:00-03:00';
previous.attendanceEndedAt=dates[0]+'T09:25:00-03:00';
assert.match(attendanceSummary(previous),/45 min a mais/);
const delayed=suggest(draft('after-late',dates[0],570,'d2','t1'),1);
assert(!delayed.match,'A sala e a ASB continuam ocupadas durante o preparo posterior.');
assert(!suggest(draft('other-room',dates[0],570,'d2','t1'),2).match);
const afterCleanup=suggest(draft('after-cleanup',dates[0],585,'d2','t1'),1);
assert(afterCleanup.match,'O preparo das 09h35 deve caber após o giro.');
delete previous.attendanceEndedAt;
assert(visitEnd(previous,clinicInstant(dates[0],540))>=close);
row('Consulta de 40 min acaba às 09h25','Bloquear preparo às 09h20 na mesma sala e com a mesma ASB','09h30 recusado; 09h45 possível após o preparo posterior');

reset();
assert(book(draft('equip1',dates[0],540,'d1','auto',{i1:1,i3:1})).match);
const equipment=suggestBooking(draft('equip2',dates[0],540,'d2','auto',{i1:1,i3:1}));
assert(!equipment.match);
assert.match(equipment.error,/Fotopolimerizador/);
row('Dois pedidos para um equipamento compartilhado','Apenas um encaixe','1/2 com horário, ASB e kit; segundo recusado pelo fotopolimerizador');

reset();
const first=book(draft('cancel',dates[0],540,'d1','t1'));
assert(first.match);
assert(!suggest(draft('waiting',dates[0],540,'d2','t1')).match);
actor='r1';
cancelAppointment('cancel');
submit(new Map([['status','Cancelado'],['note','Teste fictício']]));
assert.equal(state.jobs[0].status,'Cancelado');
assert(book(draft('replacement',dates[0],540,'d2','t1')).match);
assert.equal(sterileProjection().claimed.size,1);
row('Cancelamento','Liberar horário, ASB e kit comprometido','Consulta substituta encaixada; apenas um kit comprometido');

actor='r1';
editAppointmentTime('replacement');
submit(new Map([['date',dates[1]],['start','09:30']]));
submit();
assert.equal(dayJobs(dates[0]).length,0);
assert.equal(dayJobs(dates[1])[0].start,570);
assert.equal(sterileProjection().claimed.size,1);
row('Reagendamento para o dia seguinte','Mover a reserva e recalcular a demanda','Dia anterior livre; nova reserva às 09h30 com ASB e um kit');

reset();
const forbidden=suggest({...draft('scope',dates[0],480,'d4','t1'),specialty:'Cirurgia',procedure:undefined});
assert(!forbidden.match);
assert.match(forbidden.error,/não atende/);
row('Cirurgia com ortodontista exclusivo','Recusar','Recusada pela atuação cadastrada');
rows;
`, { assert, structuredClone, crypto:webcrypto, localStorage:{ getItem:()=>null } });

console.table(report);
