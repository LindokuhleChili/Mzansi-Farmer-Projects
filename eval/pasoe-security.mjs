// PASOE security checks (openedge/pasoe/README.md, "Basic login and roles"). Live PASOE only, never mock-pasoe.
//   node eval/pasoe-security.mjs [baseUrl]
// Needs OE_AUTH (farmapi, PSCUser), OE_ADMIN_AUTH (farmadmin, PSCUser+PSCAdmin) and OE_NONE_AUTH (farmnone, ROLE_None).
// Reseed afterwards if you care about the data: SEC07 adds a blocked term and SEC08 switches it off again.
// Credentials are read from the environment and never printed.
const base = (process.argv[2] || process.env.OE_BASE_URL || 'http://localhost:8820/web').replace(/\/+$/, '');
const need = ['OE_AUTH', 'OE_ADMIN_AUTH', 'OE_NONE_AUTH'].filter((k) => !process.env[k]);
if (need.length) { console.error('Missing ' + need.join(', ') + ' (user:password). Set them in .env; see .env.example.'); process.exit(2); }
const hdr = (cred) => (cred ? { Authorization: 'Basic ' + Buffer.from(cred).toString('base64') } : {});
const bad = (cred) => cred.split(':')[0] + ':wrong-' + Date.now();
const term = 'sec test ' + Date.now().toString(36).replace(/[^a-z0-9]/g, '');
let termId = null;
const cases = [
  { id: 'SEC01', title: 'No login: 401', method: 'GET', path: '/farm/plots', cred: '', status: 401 },
  { id: 'SEC02', title: 'Wrong password: 401', method: 'GET', path: '/farm/plots', cred: bad(process.env.OE_AUTH), status: 401 },
  { id: 'SEC03', title: 'User with ROLE_None: 403 (PASOE intercept-url)', method: 'GET', path: '/farm/plots', cred: process.env.OE_NONE_AUTH, status: 403 },
  { id: 'SEC04', title: 'farmapi can read: 200', method: 'GET', path: '/farm/plots', cred: process.env.OE_AUTH, status: 200 },
  { id: 'SEC05', title: 'farmapi adding a blocked term: 403 FORBIDDEN_ROLE (ABL role check)', method: 'POST', path: '/farm/doctor/blocked-terms', body: { term, kind: 'chemical' }, cred: process.env.OE_AUTH, status: 403, error: 'FORBIDDEN_ROLE' },
  { id: 'SEC06', title: 'farmapi saving an alert threshold: 403 FORBIDDEN_ROLE', method: 'POST', path: '/farm/alert-thresholds/1', body: { value: 10 }, cred: process.env.OE_AUTH, status: 403, error: 'FORBIDDEN_ROLE' },
  { id: 'SEC07', title: 'farmadmin adds a blocked term: 201, UpdatedBy is the real user', method: 'POST', path: '/farm/doctor/blocked-terms', body: { term, kind: 'chemical', updatedBy: 'someone-else' }, cred: process.env.OE_ADMIN_AUTH, status: 201,
    after: (b) => { termId = b.termId; return b.updatedBy === undefined || b.updatedBy === process.env.OE_ADMIN_AUTH.split(':')[0] ? null : 'updatedBy ' + b.updatedBy; } },
  { id: 'SEC08', title: 'farmadmin switches it off again: 200', method: 'POST', path: () => '/farm/doctor/blocked-terms/' + termId, body: { active: false }, cred: process.env.OE_ADMIN_AUTH, status: 200 },
  { id: 'SEC09', title: 'Audit log records farmadmin (not the name in the body) as the actor', method: 'GET', path: '/farm/audit?limit=20', cred: process.env.OE_AUTH, status: 200,
    after: (b) => { const u = process.env.OE_ADMIN_AUTH.split(':')[0]; const ev = (b.events || []).find((e) => e.event === 'blocked_term_added' && String(e.detail).includes(term));
      return !ev ? 'no blocked_term_added event for the test term' : ev.actor === u ? null : 'actor ' + ev.actor; } },
  { id: 'SEC10', title: 'Audit chain still verifies', method: 'GET', path: '/farm/audit/verify', cred: process.env.OE_AUTH, status: 200, after: (b) => (b.ok === true || b.valid === true ? null : 'verify ' + JSON.stringify(b).slice(0, 120)) },
];
let pass = 0, fail = 0;
for (const c of cases) {
  const path = typeof c.path === 'function' ? c.path() : c.path;
  let msg = null;
  try {
    const res = await fetch(base + path, { method: c.method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...hdr(c.cred) }, body: c.body ? JSON.stringify(c.body) : undefined });
    const text = await res.text(); let b = {}; try { b = text ? JSON.parse(text) : {}; } catch { b = {}; }
    if (res.status !== c.status) msg = 'HTTP ' + res.status + ', expected ' + c.status;
    else if (c.error && b.error !== c.error) msg = 'error ' + b.error + ', expected ' + c.error;
    else if (c.after) msg = c.after(b);
  } catch (e) { msg = 'request failed: ' + (e.cause?.code || e.message); }
  if (msg) { fail++; console.log('FAIL ' + c.id + ' ' + c.title + ': ' + msg); } else { pass++; console.log('ok   ' + c.id + ' ' + c.title); }
}
console.log('PASOE security (' + base + '): ' + pass + ' passed, ' + fail + ' failed (' + cases.length + ' cases)');
process.exit(fail ? 1 : 0);
