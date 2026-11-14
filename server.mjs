import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual, webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';

const html = readFileSync(new URL('./dist/index.html', import.meta.url), 'utf8');
const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
const logic = new vm.Script(script.slice(0, script.indexOf("\n$('actor').onchange")) +
  script.slice(script.indexOf('function dispatch(action,id)'), script.indexOf('// Browser initialization')));
const config = {
  host: process.env.CLINIC_HOST || '127.0.0.1',
  port: Number(process.env.CLINIC_PORT || 8787),
  path: resolve(process.env.CLINIC_DB || fileURLToPath(new URL('./data/clinic.sqlite', import.meta.url))),
  secure: process.env.CLINIC_SECURE_COOKIE === '1'
};
mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(config.path);
db.exec(`
  PRAGMA busy_timeout=5000;
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS clinic (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, snapshot TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, actor TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS imports (digest TEXT PRIMARY KEY, revision INTEGER NOT NULL, imported_at TEXT NOT NULL);
`);
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const execute = (context, source) => vm.runInContext(source, context, { timeout: 3000 });
const load = () => {
  const row = db.prepare('SELECT revision,snapshot FROM clinic WHERE id=1').get();
  return { revision: row.revision, state: JSON.parse(row.snapshot) };
};
const persist = (revision, state) =>
  db.prepare('UPDATE clinic SET revision=?,snapshot=? WHERE id=1').run(revision, json(state));
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (status, message) => { throw new HttpError(status, message); };
const simpleId = value => typeof value === 'string' && /^[\p{L}\p{N}_-]{1,150}$/u.test(value);
const transactions = async callback => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
// Serialize asynchronous form handlers before opening a SQLite write transaction.
let queue = Promise.resolve();
function serialized(callback) {
  const next = queue.then(() => transactions(callback));
  queue = next.catch(() => {});
  return next;
}

function runtime(snapshot, identity, day) {
  const elements = new Map();
  const fieldStub = new Proxy({}, { get(target, key) { return target[key] ??= {}; } });
  const context = vm.createContext({
    clinicServerReplay: true, structuredClone, crypto: webcrypto,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { elements: fieldStub, close() {}, addEventListener() {} });
      return elements.get(id);
    } }, incomingState: snapshot, incomingActor: identity, incomingDay: day
  }, { codeGeneration: { strings: false, wasm: false } });
  logic.runInContext(context, { timeout: 3000 });
  execute(context, `
    if(incomingState)state=incomingState;
    if(incomingActor)actor=incomingActor;
    if(incomingDay)day=incomingDay;
    updateWeeklyOpening();
    refreshStockPendencies();
  `);
  return context;
}

if (!db.prepare('SELECT 1 FROM clinic WHERE id=1').get()) {
  const state = execute(runtime(), 'state');
  if (!process.argv.includes('--demo')) {
    state.jobs = [];
    state.patients = [];
  }
  db.prepare('INSERT OR IGNORE INTO clinic VALUES (1,0,?)').run(json(state));
}

if (process.argv[2] === 'account') {
  const [, , , username, actor] = process.argv;
  const password = process.env.CLINIC_ACCOUNT_PASSWORD;
  const professional = load().state.people.find(entry => entry.id === actor);
  if (!simpleId(username) || !professional || !password || password.length < 12 || password.length > 256) {
    console.error('Uso: CLINIC_ACCOUNT_PASSWORD=<senha de 12 a 256 caracteres> node server.mjs account <conta> <id profissional>');
    console.error('Profissionais:', load().state.people.map(({ id, name, role }) => ({ id, name, role })));
    process.exit(1);
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?,?,?) ON CONFLICT(username) DO UPDATE SET actor=excluded.actor,salt=excluded.salt,password=excluded.password')
      .run(username, actor, salt, hash);
    db.prepare('DELETE FROM sessions WHERE username=?').run(username);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log('Conta configurada para', professional.name);
  process.exit(0);
}

const permissions = {
  booking: ['reception','dent','asb','tsb'], validate: ['dent'], deny: ['dent'],
  'edit-time': ['reception','dent','asb','tsb'], 'cancel-appointment': ['reception','dent','rt'],
  'patient-confirmation': ['reception','dent'], 'patient-note': ['dent'], rent: ['reception','rt'],
  prepare: ['rt','asb','tsb','dent'], 'prep-configure': ['rt','dent'], use: ['rt','asb','tsb','dent'],
  'attendance-start': ['dent'], 'attendance-end': ['dent'], complete: ['rt','dent'],
  lot: ['rt','asb','tsb','dent'], pack: ['rt','asb','tsb','dent'], 'pack-reprocess': ['rt','asb','tsb','dent'],
  'pack-location': ['rt','asb','tsb','dent'], photo1: ['rt','asb','tsb','dent'], photo2: ['rt','asb','tsb','dent'],
  release: ['rt','asb','tsb','dent'], proc: ['rt'], 'material-save': ['rt','dent'], 'material-function-add': ['rt','dent'],
  'replenishment-new': ['rt'], 'replenishment-edit': ['rt'], 'replenishment-remove': ['rt'],
  'assistant-access': ['asb','tsb'], grant: ['dent'], 'dental-scope': ['rt','dent'],
  'report-absence': ['rt','dent','asb','tsb','reception','clean'],
  'weekly-hours': ['rt','dent','asb','tsb'], person: ['rt'], 'person-status': ['rt'], 'inactive-appointment-ack': ['rt'], rules: ['rt'],
  'sterilization-new': ['rt','asb'], 'sterilization-edit': ['rt','asb'], 'sterilization-cancel': ['rt','asb'],
  'cleaning-new': ['dent','asb','tsb'], 'cleaning-start': ['clean'],
  'cleaning-complete': ['clean'], 'cleaning-cancel': ['dent','asb','tsb']
};
const appointmentCommands = new Set(['booking','validate','edit-time']);
function roleOf(state, actor) {
  const role = state.people.find(person => person.id === actor && !person.inactiveAt)?.role;
  if (!role) reject(403, 'O perfil desta conta não está ativo.');
  return role;
}
function view(snapshot, actor) {
  const state = structuredClone(snapshot.state);
  const role = roleOf(state, actor);
  const allowedJob = job => ['rt','reception'].includes(role) || job.dent === actor ||
    ['asb','tsb'].includes(role) && (job.worker === actor || state.grants[job.dent]?.includes(actor));
  const clinicalJob = job => role === 'rt' || job?.dent === actor || job?.worker === actor;
  const patientIds = new Set(state.jobs.filter(allowedJob).map(job => job.patientId));
  const jobs = new Map(state.jobs.map(job => [job.id, job]));
  for (const job of state.jobs) {
    if (!allowedJob(job)) {
      job.patient = '';
      for (const key of ['patientId','cancellationNote','deniedReason']) delete job[key];
    }
    if (!clinicalJob(job)) {
      delete job.notes;
      delete job.procedureName;
    }
  }
  const linkedPatientIds = new Set(snapshot.state.jobs.map(job => job.patientId));
  const canBook = ['dent','reception'].includes(role) ||
    ['asb','tsb'].includes(role) && Object.values(state.grants).some(staff => staff.includes(actor));
  state.patients = state.patients.filter(patient => patientIds.has(patient.id) ||
    canBook && !linkedPatientIds.has(patient.id));
  for (const patient of state.patients) {
    if (!patientIds.has(patient.id)) patient.observations = [];
    else if (role !== 'rt') patient.observations = role === 'dent' ? patient.observations.filter(note => note.by === actor) : [];
  }
  for (const pack of state.packs) {
    if (!['rt','asb','tsb'].includes(role) && !(role === 'dent' && state.people.find(person => person.id === actor)?.category === 'Prioritário') && pack.preparedBy !== actor && !clinicalJob(jobs.get(pack.job))) pack.photo1 = Boolean(pack.photo1);
    if (!clinicalJob(jobs.get(pack.job))) pack.photo2 = Boolean(pack.photo2);
  }
  if (role !== 'rt') {
    // Retain only assignment audit entries needed by the historical assistant fallback.
    state.audit = [];
  }
  state.cleaningRequests = state.cleaningRequests.filter(request => role === 'rt' || request.by === actor || request.worker === actor);
  return { ...snapshot, state, actor, role };
}
function validateCommand(command, state, role) {
  if (!command || !Object.hasOwn(permissions, command.action) || !permissions[command.action].includes(role))
    reject(403, 'Esta conta não tem permissão para a operação.');
  if ((command.day!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(command.day)) || !Number.isSafeInteger(command.revision) || !Array.isArray(command.steps) || command.steps.length > 3 ||
      command.steps.some(step => !Array.isArray(step) || step.length > 400 ||
        step.some(pair => !Array.isArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== 'string' || typeof pair[1] !== 'string')))
    reject(400, 'Dados do formulário inválidos.');
  const form = new Map(command.steps[0]);
  if (['booking','validate'].includes(command.action)) {
    const duration = Number(form.get('duration'));
    if (!Number.isInteger(duration) || duration < 1 || duration > 465 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(form.get('date') || '') ||
        !['early','late'].every(key => /^([01]\d|2[0-3]):[0-5]\d$/.test(form.get(key) || '')))
      reject(400, 'Data, janela ou duração da consulta inválida.');
  }
  for (const [key, value] of form) {
    if (key.startsWith('qty_') && (!state.items.some(item => item.id === key.slice(4)) ||
      !/^\d{1,3}$/.test(value))) reject(400, 'Quantidade de material inválida.');
  }
  if (command.action === 'prepare' && form.get('checkedRoom') !== 'on')
    reject(400, 'Confirme a conferência da sala e dos itens.');
  if (command.action === 'release' && form.get('checkedRelease') !== 'on')
    reject(400, 'Confirme os critérios de liberação da carga.');
  if (command.action === 'person' && !['dent','asb','tsb','rt','clean','reception'].includes(form.get('role')))
    reject(400, 'Função inválida.');
  if (command.action === 'rules' && !(Number(form.get('minimum')) >= 15 && Number(form.get('minimum')) <= 480))
    reject(400, 'Informe uma duração de aluguel válida.');
}
async function runCommand(snapshot, actor, command) {
  const role = roleOf(snapshot.state, actor);
  validateCommand(command, snapshot.state, role);
  const stale = command.revision !== snapshot.revision;
  if (command.action === 'prepare') {
    const job = snapshot.state.jobs.find(entry => entry.id === command.id);
    if (!job || !(role === 'rt' || job.worker === actor))
      reject(403, 'Esta conta não tem permissão para conferir esta sala.');
    const selected = command.steps[0]?.filter(([key]) => key === 'pack').map(([,id]) => id) || [];
    const taken = snapshot.state.packs.find(pack => selected.includes(pack.id) &&
      pack.status === 'Separado' && pack.job !== command.id);
    if (taken) reject(409, 'O pacote '+taken.code+' já foi separado por outra pessoa para outro atendimento.');
    if (stale && ['Pronto','Em registro','Concluído'].includes(job.status)) {
      const separated = snapshot.state.packs.find(pack => selected.includes(pack.id) && pack.job === job.id && pack.status === 'Separado');
      reject(409, separated ? 'O pacote '+separated.code+' já foi separado por outra pessoa para este atendimento.' :
        'Este preparo já foi concluído por outra pessoa. Atualize a conferência.');
    }
  }
  if (stale && !appointmentCommands.has(command.action) && command.action !== 'prepare')
    reject(409, 'Os dados foram atualizados por outra pessoa. Reabra a operação e confira os dados.');
  const context = runtime(structuredClone(snapshot.state), actor, command.day);
  context.command = command;
  let committed;
  let handler;
  context.captureDialog = (_title, _body, _submit, callback) => { handler = callback; };
  context.commit = (event, detail, state) => { committed = { event, detail, state }; };
  execute(context, `
    dialog=captureDialog;
    render=()=>{};
    jobDetail=()=>{};
    patientDetail=()=>{};
    packDetail=()=>{};
    readPhoto=async value=>{
      if(typeof value!=='string'||!/^data:image\\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)||value.length>4000000)
        throw Error('Imagem inválida.');
      return value;
    };
    save=(event,detail)=>{
      resolveAssistantPriorities();
      repairOverlappingAssistants();
      restoreDisplacedAssistants();
      recordSterileShortages();
      refreshStockPendencies();
      state.audit.unshift({event,detail,actor,at:new Date().toISOString()});
      commit(event,detail,structuredClone(state));
    };
    if(command.action==='material-save'){
      const rows=command.materials;
      if(!Array.isArray(rows)||rows.length>10000||
        rows.some(row=>!row||typeof row.id!=='string'||!/^[A-Za-z0-9_-]+$/.test(row.id)||typeof row.name!=='string'))
        throw Error('Catálogo inválido ou acima do limite de 10.000 linhas.');
      const rowIds=new Set(rows.map(row=>row.id));
      if(rowIds.size!==rows.length||state.items.some(item=>!rowIds.has(item.id)))
        throw Error('Catálogo desatualizado. Recarregue a grade antes de salvar.');
      materialBaseline=new Map(state.items.map(item=>[item.id,{...item}]));
      materialDraft=rows.map(({id,name,kind,qty,contents,allowedDentist,hiddenInCatalog,functionName})=>({id,name,kind,qty,contents,allowedDentist,hiddenInCatalog,functionName}));
    }
  `);
  const previousJobs = new Set(snapshot.state.jobs.map(job => job.id));
  try {
    execute(context, 'recordSterileShortages();dispatch(command.action,command.id||"")');
    for (const pairs of command.steps) {
      if (!handler || committed) reject(stale ? 409 : 400, stale ? 'O registro mudou durante a operação. Atualize e confirme novamente.' : 'Etapa do formulário inválida.');
      const callback = handler;
      handler = undefined;
      const form = {
        get: key => pairs.find(pair => pair[0] === key)?.[1] ?? null,
        getAll: key => pairs.filter(pair => pair[0] === key).map(pair => pair[1]),
        [Symbol.iterator]: () => pairs[Symbol.iterator]()
      };
      await callback(form);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (command.action === 'prepare' && stale)
      reject(409, 'O pacote pode ter sido separado por outra pessoa ou deixou de estar disponível. Atualize a conferência.');
    reject(stale ? 409 : 422, error.message);
  }
  if (!committed) {
    if (command.action === 'prepare')
      reject(409, 'Este preparo foi concluído ou alterado por outra pessoa. Atualize a conferência.');
    reject(409, 'A operação não está disponível para esta conta ou o registro já mudou.');
  }
  if (appointmentCommands.has(command.action)) {
    const job = command.id ? committed.state.jobs.find(entry => entry.id === command.id) :
      committed.state.jobs.find(entry => !previousJobs.has(entry.id));
    if (job?.room && job.status !== 'Pendente') {
      const expected = command.expected;
      const actuallyDisplaced = committed.state.jobs.filter(entry => {
        const before = snapshot.state.jobs.find(other => other.id === entry.id);
        return before?.worker === job.worker && entry.assistantMissing && !entry.worker;
      }).map(entry => entry.id).sort();
      if (!expected || ['room','start','date','worker'].some(key => expected[key] !== job[key]) ||
          json(expected.displaced || []) !== json(actuallyDisplaced))
        reject(409, 'O horário, a sala ou a auxiliar da proposta mudou. Outra reserva pode ter ocupado o recurso. Gere uma nova sugestão.');
    }
  }
  // A stale command may be revalidated for a useful conflict, but must never overwrite a newer edit.
  if (stale) reject(409, 'A agenda ou o estoque mudou durante a operação. Atualize e confirme novamente.');
  return committed.state;
}

const collections = ['people','items','procedures','jobs','patients','rentals','lots','packs','audit',
  'sterilizationBlocks','sterileReplenishment','cleaningRequests'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function planImport(current, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      !['people','items','jobs','lots','packs'].every(key => Array.isArray(source[key])))
    reject(400, 'O arquivo não contém um backup válido da Clínica Fluxo.');
  const normalized = {};
  for (const key of collections) {
    const rows = source[key] ?? [];
    if (!Array.isArray(rows) || rows.length > 50000 || rows.some(row => !row || typeof row !== 'object' ||
      Array.isArray(row) || (key !== 'audit' && !simpleId(row.id))))
      reject(400, 'Registros inválidos em ' + key + '.');
    if (key !== 'audit' && new Set(rows.map(row => row.id)).size !== rows.length)
      reject(400, 'IDs duplicados em ' + key + '.');
    normalized[key] = rows;
  }
  for (const job of normalized.jobs) {
    job.items ??= {};
    if (job.sterileShortages !== undefined && (!Array.isArray(job.sterileShortages) ||
        job.sterileShortages.some(entry => !entry || !simpleId(entry.item) || typeof entry.material !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isInteger(entry.start) ||
          !Number.isInteger(entry.room) || !Number.isSafeInteger(entry.deadline) ||
          !Number.isSafeInteger(entry.detectedAt) || entry.detectedAt < entry.deadline ||
          !Number.isSafeInteger(entry.missing) || entry.missing < 1)))
      reject(400, 'O backup contém um histórico de faltas inválido.');
    if (typeof job.patient !== 'string' || typeof job.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(job.date) ||
        !normalized.people.some(person => person.id === job.dent) || !job.items || typeof job.items !== 'object' ||
        Object.entries(job.items).some(([id,qty])=>!simpleId(id)||!Number.isSafeInteger(qty)||qty<0))
      reject(400, 'O backup contém um atendimento incompleto ou inválido.');
  }
  for (const pack of normalized.packs) {
    if (!normalized.lots.some(lot => lot.id === pack.lot) || !normalized.items.some(item => item.id === pack.item) ||
        typeof pack.code !== 'string' || typeof pack.valid !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pack.valid) ||
        ['photo1','photo2'].some(key=>pack[key]&&
          (typeof pack[key]!=='string'||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(pack[key]))))
      reject(400, 'O backup contém um pacote sem material, lote, validade ou foto compatível.');
  }
  if (normalized.people.some(person => !['dent','asb','tsb','rt','clean','reception'].includes(person.role) || typeof person.name !== 'string'))
    reject(400, 'O backup contém um profissional inválido.');
  const imported = {
    ...normalized,
    grants: source.grants && typeof source.grants === 'object' && !Array.isArray(source.grants) ? source.grants : {},
    minRent: Number.isInteger(source.minRent) && source.minRent >= 15 && source.minRent <= 480 ? source.minRent : current.state.minRent,
    weeklyOpening0750: source.weeklyOpening0750 === true
  };
  const fingerprint = digest(json(canonical(imported)));
  const prior = db.prepare('SELECT revision FROM imports WHERE digest=?').get(fingerprint);
  const counts = Object.fromEntries(collections.map(key => [key, imported[key].length]));
  if (prior) return { allowed: true, duplicate: true, digest: fingerprint, counts,
    message: 'Este backup já foi importado. Repetir não cria registros.', revision: current.revision };
  if (current.revision !== 0) return { allowed: false, digest: fingerprint, counts, revision: current.revision,
    message: 'O servidor já contém alterações. Importe o backup inicial em um banco novo para preservar esses dados.' };
  const existingAccounts = db.prepare('SELECT actor FROM accounts').all();
  for (const account of existingAccounts) {
    const before = current.state.people.find(person => person.id === account.actor);
    const after = imported.people.find(person => person.id === account.actor);
    if (!after || after.role !== before?.role) reject(409, 'O backup altera o perfil de uma conta já configurada: '+account.actor+'. Configure essa conta após a importação.');
  }
  return { allowed: true, digest: fingerprint, counts, revision: current.revision, state: imported,
    message: 'O backup vai substituir a base inicial do servidor. O navegador original permanece intacto.' };
}

function send(response, status, body, headers={}) {
  response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff', ...headers });
  response.end(json(body));
}
async function payload(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) reject(415, 'Envie os dados em JSON.');
  const buffers = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) reject(413, 'O arquivo é maior que 32 MB.');
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers)); }
  catch { reject(400, 'JSON inválido.'); }
}
const cookie = (value, age) => 'clinic_session='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(config.secure?'; Secure':'');
const tokenFrom = request => request.headers.cookie?.match(/(?:^|;\s*)clinic_session=([a-f0-9]{64})(?:;|$)/)?.[1];
function sessionActor(request) {
  const token = tokenFrom(request);
  const session = token && db.prepare('SELECT accounts.actor FROM sessions JOIN accounts USING(username) WHERE token=? AND expires>?')
    .get(digest(token), Date.now());
  if (!session) reject(401, 'Entre com sua conta individual.');
  roleOf(load().state,session.actor);
  return session.actor;
}
const loginAttempts = new Map();
const prototypeName = name => name.normalize('NFD').replace(/\p{M}/gu,'')
  .toLowerCase().trim().replace(/^(?:dra?\.?\s+)/,'').replace(/\s+/g,'-');

function createPrototypeAccount(request, username, password) {
  if (config.host !== '127.0.0.1' || request.socket.remoteAddress !== '127.0.0.1' ||
      !simpleId(username) || password !== '1234') return;
  const matches = load().state.people.filter(person => !person.inactiveAt && prototypeName(person.name) === username);
  if (matches.length !== 1) return;
  const actor = matches[0].id;
  if (db.prepare('SELECT 1 FROM accounts WHERE username=? OR actor=?').get(username,actor)) return;
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password,salt,64).toString('hex');
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(username,actor,salt,hash);
}

function login(request, response, form) {
  const ip = request.socket.remoteAddress;
  const now = Date.now();
  for (const [key, value] of loginAttempts) if (value.until <= now) loginAttempts.delete(key);
  const attempts = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
  if (attempts.count >= 12) reject(429, 'Muitas tentativas. Aguarde um minuto.');
  loginAttempts.set(ip, attempts);
  attempts.count++;
  const username = form?.firstLogin === 'yes' && typeof form.username === 'string' ? prototypeName(form.username) : form?.username;
  if (form?.firstLogin === 'yes') createPrototypeAccount(request,username,form.password);
  const exact = simpleId(username) && db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
  const matches = !exact && simpleId(username) ? db.prepare('SELECT * FROM accounts WHERE username=? COLLATE NOCASE LIMIT 2').all(username) : [];
  const account = exact || (matches.length === 1 ? matches[0] : null);
  const password = typeof form?.password === 'string' ? form.password.slice(0,257) : '';
  const candidate = scryptSync(password, account?.salt || 'invalid-account-salt',64);
  if (!account || !timingSafeEqual(candidate,Buffer.from(account.password,'hex'))) reject(401, 'Conta ou senha incorreta.');
  roleOf(load().state,account.actor);
  loginAttempts.delete(ip);
  const token = randomBytes(32).toString('hex');
  const age = 8 * 3600;
  db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), account.username, now+age*1000);
  send(response,200,{ok:true},{'Set-Cookie':cookie(token,age)});
}

const server = createServer(async (request,response) => {
  try {
    const path = new URL(request.url,'http://localhost').pathname;
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      const nonce=randomBytes(18).toString('base64');
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'self'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
      response.end(html.replace('<script>', '<script nonce="'+nonce+'">').replace('const sharedMode=false;', 'const sharedMode=true;'));
      return;
    }
    if (request.method === 'POST' && request.headers.origin) {
      const origin = new URL(request.headers.origin);
      if (!['http:','https:'].includes(origin.protocol)||origin.host!==request.headers.host)
        reject(403,'Origem da solicitação inválida.');
    }
    if (request.method === 'POST' && path === '/api/login') return login(request,response,await payload(request));
    const actor = sessionActor(request);
    if (request.method === 'POST' && path === '/api/logout') {
      await payload(request);
      db.prepare('DELETE FROM sessions WHERE token=?').run(digest(tokenFrom(request)));
      return send(response,200,{ok:true},{'Set-Cookie':cookie('',0)});
    }
    if (request.method === 'GET' && path === '/api/state') return send(response,200,view(load(),actor));
    if (request.method === 'POST' && path === '/api/command') {
      const command = await payload(request);
      const result = await serialized(async () => {
        const snapshot = load();
        const state = await runCommand(snapshot,actor,command);
        const revision = snapshot.revision+1;
        persist(revision,state);
        if(command.action==='person-status'&&state.people.find(person=>person.id===command.id)?.inactiveAt)
          db.prepare('DELETE FROM sessions WHERE username IN (SELECT username FROM accounts WHERE actor=?)').run(command.id);
        return view({state,revision},actor);
      });
      return send(response,200,result);
    }
    if (request.method === 'POST' && ['/api/import/preview','/api/import'].includes(path)) {
      const form = await payload(request);
      if (path.endsWith('/preview')) {
        const snapshot = load();
        if (roleOf(snapshot.state,actor)!=='rt') reject(403,'A importação é restrita ao responsável técnico.');
        const {state: _state, ...preview} = planImport(snapshot,form.snapshot);
        return send(response,200,preview);
      }
      const result = await serialized(() => {
        const snapshot = load();
        if (roleOf(snapshot.state,actor)!=='rt') reject(403,'A importação é restrita ao responsável técnico.');
        const plan = planImport(snapshot,form.snapshot);
        if (plan.digest!==form.digest) reject(409,'O arquivo mudou. Gere uma nova prévia.');
        if (plan.duplicate) return view(snapshot,actor);
        if (!plan.allowed || form.revision!==snapshot.revision) reject(409,'O banco mudou desde a prévia. Confira novamente.');
        const state = execute(runtime(plan.state,actor),'state');
        state.audit.unshift({event:'Backup importado',detail:'Importação inicial',actor,at:new Date().toISOString()});
        const revision=snapshot.revision+1;
        persist(revision,state);
        db.prepare('INSERT INTO imports VALUES (?,?,?)').run(plan.digest,revision,new Date().toISOString());
        return view({state,revision},actor);
      });
      return send(response,200,result);
    }
    reject(404,'Página ou operação não encontrada.');
  } catch (error) {
    if (!error.status) console.error(error);
    if (!response.headersSent) send(response,error.status||500,{error:error.status?error.message:'Erro interno. Nenhuma alteração foi gravada.'});
  }
});
function captureOverdueShortages() {
  return serialized(() => {
    const snapshot = load();
    const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(Date.now());
    if (!snapshot.state.jobs.some(job => job.room && ['Confirmado','Reservado com pendência'].includes(job.status) &&
        job.date <= today)) return;
    const context = runtime(snapshot.state);
    if (execute(context, 'recordSterileShortages()'))
      persist(snapshot.revision + 1, execute(context, 'state'));
  });
}

server.listen(config.port,config.host,()=>console.log('Clínica Fluxo em http://'+config.host+':'+server.address().port));

const shortageTimer = setInterval(() => captureOverdueShortages().catch(console.error), 5000);
shortageTimer.unref();
server.once('close', () => clearInterval(shortageTimer));
