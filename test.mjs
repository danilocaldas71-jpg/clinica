import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const temp = mkdtempSync(join(tmpdir(),'clinica-fluxo-test-'));
const password = 'SomenteTesteFicticio123';
const env = {...process.env,CLINIC_DB:join(temp,'test.sqlite'),CLINIC_HOST:'127.0.0.1',
  CLINIC_PORT:'0',CLINIC_ACCOUNT_PASSWORD:password,CLINIC_SECURE_COOKIE:'0'};
const serverFile = fileURLToPath(new URL('./server.mjs',import.meta.url));
let child;
let url;
async function start(){
  child=spawn(process.execPath,[serverFile],{env,stdio:['ignore','pipe','inherit']});
  const [chunk]=await once(child.stdout,'data');
  url=chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert(url);
}
async function stop(){
  const ended=once(child,'exit');
  child.kill();
  await ended;
  child=undefined;
}
async function client(username){
  const login=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username,password})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  return async (path,body)=>{
    const response=await fetch(url+path,{method:body===undefined?'GET':'POST',
      headers:{Cookie:cookie,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  };
}
const step = fields => Object.entries(fields);
try{
  for(const [username,actor] of [['tecnica','rt'],['helena','d1'],['andre','d2'],['camila','t1'],['recepcao','r1']]){
    const child=spawnSync(process.execPath,[serverFile,'account',username,actor],{env,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
  }
  await start();
  assert.equal((await fetch(url+'/api/state')).status,401);
  const rt=await client('tecnica'), dentist1=await client('helena'),dentist2=await client('andre');
  const asb=await client('camila'), reception=await client('recepcao');
  const initial=await rt('/api/state');
  const backup=structuredClone(initial.state);
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(Date.now()+86400000);
  backup.lots=[{id:'lote-teste',code:'LT-01',date:'2020-01-01',cycleTime:'08:00',released:true}];
  backup.packs=[{id:'pacote-teste',code:'PK-01',item:'i1',lot:'lote-teste',status:'Disponível',
    valid:'2099-12-31',photo1:'data:image/png;base64,AA=='}];
  const source=JSON.stringify(backup);
  const preview=await rt('/api/import/preview',{snapshot:backup});
  assert.equal(preview.status,200);assert.equal(preview.counts.packs,1);
  assert.equal((await rt('/api/state')).state.packs.length,0);
  assert.equal((await reception('/api/import/preview',{snapshot:backup})).status,403);
  const input={snapshot:backup,revision:preview.revision,digest:preview.digest};
  const imported=await rt('/api/import',input);
  assert.equal(imported.status,200,imported.error);
  const repeated=await rt('/api/import',input);
  assert.equal(repeated.revision,imported.revision);assert.equal(repeated.state.packs.length,1);
  assert.equal(JSON.stringify(backup),source);
  assert.equal((await reception('/api/state')).state.packs[0].photo1,true);
  console.log('OK — prévia sem gravação, importação idempotente, origem preservada e permissões de leitura.');

  const makeBooking=(dent,revision)=>({action:'booking',revision,steps:[step({
    patient:'Paciente fictício '+dent,dent,date,early:'09:00',late:'09:00',duration:'60',worker:'t1',
    specialty:'Diagnóstico',procedure:'p1',notes:'Teste de concorrência',qty_i1:'1'
  }),[]],expected:{date,room:1,start:540,worker:'t1',displaced:[]}});
  assert.equal((await asb('/api/command',{action:'release',id:'lote-teste',revision:imported.revision,steps:[[]]})).status,403);
  const bookingRace=await Promise.all([
    dentist1('/api/command',makeBooking('d1',imported.revision)),
    dentist2('/api/command',makeBooking('d2',imported.revision))
  ]);
  assert.deepEqual(bookingRace.map(r=>r.status).sort(),[200,409],JSON.stringify(bookingRace.map(r=>[r.status,r.error])));
  const bookingConflict=bookingRace.find(r=>r.status===409);
  assert.match(bookingConflict.error,/Camila.*Atendimento|ocupado|ocupadas/);
  const afterBooking=await rt('/api/state');
  assert.equal(afterBooking.state.jobs.length,1);
  assert.equal(afterBooking.state.audit.filter(row=>row.event==='Atendimento confirmado').length,1);
  assert.equal((await reception('/api/state')).state.jobs.length,1);
  console.log('OK — reserva concorrente: uma gravação; cliente recusado recebeu: '+bookingConflict.error);

  const jobId=afterBooking.state.jobs[0].id;
  const prepare={action:'prepare',id:jobId,revision:afterBooking.revision,
    steps:[[...step({checkedRoom:'on'}),['pack','pacote-teste']]]};
  const prepareRace=await Promise.all([rt('/api/command',prepare),asb('/api/command',prepare)]);
  assert.deepEqual(prepareRace.map(r=>r.status).sort(),[200,409],JSON.stringify(prepareRace.map(r=>[r.status,r.error])));
  const prepareConflict=prepareRace.find(r=>r.status===409);
  assert.match(prepareConflict.error,/preparo.*outra pessoa|pacote.*outra pessoa/i);
  const afterPrepare=await rt('/api/state');
  assert.equal(afterPrepare.state.packs[0].job,jobId);
  assert.equal(afterPrepare.state.packs[0].status,'Separado');
  assert.equal(afterPrepare.state.audit.filter(row=>row.event==='Preparo conferido').length,1);
  console.log('OK — separação concorrente: uma gravação; cliente recusado recebeu: '+prepareConflict.error);

  const disabled = await rt('/api/command',{action:'person-status',id:'t1',revision:afterPrepare.revision,steps:[[]]});
  assert.equal(disabled.status,200,disabled.error);
  assert(disabled.state.people.find(p=>p.id==='t1').inactiveAt);
  assert.equal((await asb('/api/state')).status,401);
  const blocked=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'camila',password})});
  assert.equal(blocked.status,403);
  const command={action:'inactive-appointment-ack',id:jobId,revision:disabled.revision,steps:[[]]};
  assert.equal((await reception('/api/command',command)).status,403);
  const acknowledged=await rt('/api/command',command);
  assert.equal(acknowledged.status,200,acknowledged.error);
  assert.equal(acknowledged.state.jobs[0].inactiveProfessionalAcknowledgment.by,'rt');
  assert(acknowledged.state.audit.some(entry=>entry.event==='Ciência registrada sobre atendimento afetado'));
  assert.equal(acknowledged.state.jobs[0].status,'Pronto');
  console.log('OK — ciência exclusiva do administrador, registrada no histórico sem mudar a consulta.');

  const enabled=await rt('/api/command',{action:'person-status',id:'t1',revision:acknowledged.revision,steps:[[]]});
  assert.equal(enabled.status,200,enabled.error);
  await client('camila');
  assert.equal(enabled.state.jobs[0].worker,'t1');
  console.log('OK — desativação bloqueia sessão e login, reativação restaura acesso e histórico preservado.');

  const camila=await client('camila');
  const absenceForm=[step({date,start:'09:00',end:'10:00'})];
  const unauthorized=await camila('/api/command',{action:'report-absence',id:'d1',revision:enabled.revision,steps:absenceForm});
  assert.notEqual(unauthorized.status,200);
  const absence=await camila('/api/command',{action:'report-absence',revision:enabled.revision,steps:absenceForm});
  assert.equal(absence.status,200,absence.error);
  assert.equal(absence.state.people.find(p=>p.id==='t1').absences[0].by,'t1');
  const affected=await rt('/api/state');
  assert.equal(affected.state.jobs[0].worker,'t1');
  assert.equal(affected.state.people.find(p=>p.id==='t1').absences[0].start,540);
  const nextBooking=makeBooking('d2',absence.revision);
  assert.match((await dentist2('/api/command',nextBooking)).error,/Camila.*Falta informada/);
  console.log('OK — falta registrada na própria conta, visível à administração e bloqueada em novas reservas.');
  await stop();
  await start();
  const restarted=await client('tecnica');
  const persisted=await restarted('/api/state');
  assert.equal(persisted.revision,absence.revision);
  assert.equal(persisted.state.jobs[0].id,jobId);
  assert.equal(persisted.state.packs[0].job,jobId);
  console.log('OK — agenda, estoque e auditoria mantidos após reiniciar.');
}finally{
  if(child)await stop();
  rmSync(temp,{recursive:true,force:true});
}
