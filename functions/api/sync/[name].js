// jws-lab 기록 저장소 창구: POST /api/sync/<이름>  (Cloudflare D1, 바인딩 이름 DB · 2026-11-24)
//   {op:'get'}         → {exists, data, v, t}
//   {op:'put', data, base} → {ok, v, t}  (통째로 바꿔 씀 · v는 저장할 때마다 1씩 늘어남)
//     base(이 기기가 마지막으로 본 v)가 지금 v와 다르면 409 {conflict, exists, data, v} — 앱이 합쳐서 다시 올려요(다른 기기 기록이 덮이지 않게)
// 로그인 확인은 functions/_middleware.js 가 먼저 해요 — 로그인 안 했으면 여기까지 오지 않고 401.
// 읽기도 POST인 까닭: 앱의 서비스 워커가 같은 주소 GET을 한 번 받아 두면 계속 그것만 내줘서(옛 기록이 보임).
// 데이터베이스가 연결 안 됐으면(DB 없음) 503 → 앱은 조용히 '이 기기에만' 저장으로 돌아가요.

const NAME = /^[a-z0-9-]{1,40}$/;
const MAX = 900000;   // 한 칸 최대 약 0.9MB (글자 수)
let ready = false;

const J = (o, status = 200) => new Response(JSON.stringify(o), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function table(db) {
  if (ready) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS sync (k TEXT PRIMARY KEY, data TEXT NOT NULL, v INTEGER NOT NULL, t INTEGER NOT NULL)').run();
  ready = true;
}

export async function onRequestPost({ params, env, request }) {
  if (!env.DB) return J({ error: 'no-db' }, 503);
  const k = String(params.name || '');
  if (!NAME.test(k)) return J({ error: 'name' }, 400);
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return J({ error: 'type' }, 415);
  const text = await request.text();
  if (text.length > MAX) return J({ error: 'too-big' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return J({ error: 'json' }, 400); }
  if (!body || typeof body !== 'object') return J({ error: 'json' }, 400);
  await table(env.DB);

  if (body.op === 'get') {
    const r = await env.DB.prepare('SELECT data, v, t FROM sync WHERE k = ?1').bind(k).first();
    if (!r) return J({ exists: false, v: 0 });
    let data = null;
    try { data = JSON.parse(r.data); } catch (_) { data = null; }
    return J({ exists: data !== null, data, v: r.v, t: r.t });
  }
  if (body.op === 'put') {
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return J({ error: 'data' }, 400);
    if (typeof body.base === 'number') {
      const cur = await env.DB.prepare('SELECT data, v FROM sync WHERE k = ?1').bind(k).first();
      const curV = cur ? cur.v : 0;
      if (curV !== body.base) {
        let data = null;
        try { data = cur ? JSON.parse(cur.data) : null; } catch (_) { data = null; }
        return J({ conflict: true, exists: data !== null, data, v: curV }, 409);
      }
    }
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO sync (k, data, v, t) VALUES (?1, ?2, 1, ?3) ON CONFLICT(k) DO UPDATE SET data = excluded.data, v = sync.v + 1, t = excluded.t'
    ).bind(k, JSON.stringify(body.data), now).run();
    const r = await env.DB.prepare('SELECT v FROM sync WHERE k = ?1').bind(k).first();
    return J({ ok: true, v: r ? r.v : 0, t: now });
  }
  return J({ error: 'op' }, 400);
}

export async function onRequest() {
  return J({ error: 'method' }, 405);
}
