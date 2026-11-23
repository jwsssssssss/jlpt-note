// jws-lab 로그인 문 — Cloudflare Pages Functions 미들웨어 (모든 요청 앞에서 확인, 2026-11-24)
//
// 들어오는 길 두 가지: 구글 로그인(ALLOWED_EMAIL 계정 하나만) · 비밀번호(LOGIN_PASSWORD)
// 한 번 들어오면 30일 동안 서명된 쿠키(jl_s)로 기억. 모두 내보내려면 SESSION_SECRET을 바꿈.
//
// 환경 변수 (Cloudflare → Workers & Pages → jws-lab → Settings → Variables and Secrets, Production):
//   GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET · LOGIN_PASSWORD · SESSION_SECRET (Secret) · ALLOWED_EMAIL (Text)
//   값을 바꾸면 다음 배포부터 적용돼요. SESSION_SECRET이 없으면 아무도 못 들어가요(밖으로 열리지 않음).
//
// 로그인 없이 열리는 것: /login · /auth/* · 아이콘(png) · manifest · robots.txt — 홈 화면 설치용, 내용은 없음.
// 구글 쪽 '승인된 리디렉션 URI' = https://jws-lab.pages.dev/auth/callback (미리보기 주소에서는 비밀번호만 됨)

const COOKIE = 'jl_s';
const STATE_COOKIE = 'jl_st';
const DAYS = 30;
const PUBLIC = [
  /^\/robots\.txt$/,
  /^\/(?:[A-Za-z0-9_-]+\/)?manifest\.webmanifest$/,
  /^\/(?:[A-Za-z0-9_-]+\/)?icons\/[A-Za-z0-9_.-]+\.png$/,
];

const enc = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64u(enc.encode(s));
const unb64uStr = s => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
};

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
function same(a, b) {            // 길이가 같을 때 걸리는 시간이 같은 비교
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
const cookie = (name, val, maxAge) => `${name}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const clear = name => cookie(name, '', 0);

function redirect(location, cookies = [], status = 302) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status, headers: h });
}

// 들어온 뒤 돌아갈 곳: 이 사이트 안 경로만 (다른 사이트로 넘기기 막기)
function safeNext(n) {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return '/';
  if (n.startsWith('/auth') || n.startsWith('/login')) return '/';
  return n.slice(0, 500);
}

async function makeSession(env, who) {
  const payload = b64uStr(JSON.stringify({ w: who, e: Date.now() + DAYS * 864e5 }));
  const sig = b64u(await hmac(env.SESSION_SECRET, 's1.' + payload));
  return cookie(COOKIE, payload + '.' + sig, DAYS * 86400);
}
async function readSession(env, req) {
  const t = getCookie(req, COOKIE);
  if (!t || !env.SESSION_SECRET) return null;
  const [payload, sig] = t.split('.');
  if (!payload || !sig) return null;
  const good = b64u(await hmac(env.SESSION_SECRET, 's1.' + payload));
  if (!same(enc.encode(good), enc.encode(sig))) return null;
  try {
    const p = JSON.parse(unb64uStr(payload));
    return p && typeof p.e === 'number' && p.e > Date.now() ? p : null;
  } catch (_) { return null; }
}

async function passwordOk(env, input) {
  if (!env.LOGIN_PASSWORD || !env.SESSION_SECRET) return false;
  const a = await hmac(env.SESSION_SECRET, 'pw:' + input);
  const b = await hmac(env.SESSION_SECRET, 'pw:' + env.LOGIN_PASSWORD);
  return same(a, b);
}

const MSG = {
  pw: '비밀번호가 맞지 않아요.',
  who: '이 구글 계정으로는 들어올 수 없어요. 허락된 계정으로 다시 로그인해 주세요.',
  google: '구글 로그인을 마치지 못했어요. 한 번 더 해 주세요.',
  nogoogle: '구글 로그인은 아직 준비 중이에요. 비밀번호로 들어와 주세요.',
  out: '로그아웃했어요.',
};

function loginPage(env, next, code) {
  const configOk = !!env.SESSION_SECRET;
  const hasGoogle = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ALLOWED_EMAIL);
  const hasPw = !!env.LOGIN_PASSWORD;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const msg = !configOk ? '로그인 설정이 아직 안 됐어요. Cloudflare의 jws-lab 환경 변수(SESSION_SECRET)를 확인해 주세요.' : (MSG[code] || '');
  const isErr = code && code !== 'out' || !configOk;
  const nx = encodeURIComponent(next);
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>jws-lab · 로그인</title><meta name="robots" content="noindex,nofollow">
<link rel="icon" href="/icons/favicon-32.png" sizes="32x32"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#121317" media="(prefers-color-scheme: dark)">
<style>
:root{color-scheme:light dark;--bg:light-dark(#ffffff,#121317);--paper:light-dark(#f6f6f4,#1b1c21);--ink:light-dark(#1b1b1f,#ececec);
 --sub:light-dark(#5d6168,#a3a7ae);--line:light-dark(#e3e3e0,#2c2e35);--hl:light-dark(#d3e2a6,#55663a);--wash:light-dark(#f4f8ec,#171b13);
 --ok:light-dark(#4d6a1f,#c2d892);--err:light-dark(#b3261e,#ff8a80);--ai:light-dark(#26408b,#8ea8ff)}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;background:linear-gradient(var(--wash),var(--bg) 320px) no-repeat,var(--bg);color:var(--ink);
 font:16px/1.6 "Noto Sans KR","Apple SD Gothic Neo",system-ui,sans-serif;word-break:keep-all;
 padding:32px max(20px,env(safe-area-inset-right,0px)) 32px max(20px,env(safe-area-inset-left,0px))}
main{width:min(100%,360px);text-align:center}
.mark{width:88px;height:88px;border-radius:22%;box-shadow:0 0 0 1px var(--line),0 12px 30px rgba(30,40,10,.10)}
h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;margin:16px 0 4px}
.hl{background:linear-gradient(176deg,transparent 56%,var(--hl) 56% 90%,transparent 90%);padding:0 .06em}
.lead{margin:0 0 22px;color:var(--sub);font-size:14.5px}
.msg{margin:0 0 16px;padding:10px 12px;border-radius:12px;font-size:14px;background:var(--paper);text-align:left}
.msg.err{color:var(--err)} .msg.ok{color:var(--ok)}
.g{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;border:1px solid var(--line);border-radius:12px;
 background:var(--bg);color:var(--ink);font:inherit;font-weight:700;text-decoration:none}
.g svg{width:18px;height:18px;flex:none}
.or{display:flex;align-items:center;gap:10px;margin:18px 0;color:var(--sub);font-size:13px}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
form{display:grid;gap:10px;text-align:left}
label{font-size:13px;font-weight:700;color:var(--sub)}
input{width:100%;min-height:48px;border:1px solid var(--line);border-radius:12px;padding:0 14px;font:inherit;background:var(--bg);color:var(--ink)}
button{min-height:48px;border:0;border-radius:12px;font:inherit;font-weight:700;background:var(--ink);color:var(--bg);cursor:pointer}
a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid var(--ai);outline-offset:2px}
.foot{margin-top:22px;color:var(--sub);font-size:12.5px}
</style></head><body><main>
<img class="mark" src="/icons/icon-192.png" alt="">
<h1>jws-<span class="hl">lab</span></h1>
<p class="lead">내 계정으로만 들어올 수 있어요.</p>
${msg ? `<p class="msg ${isErr ? 'err' : 'ok'}" role="${isErr ? 'alert' : 'status'}">${esc(msg)}</p>` : ''}
${configOk ? `
${hasGoogle ? `<a class="g" href="/auth/google?next=${nx}"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>Google로 로그인</a>` : ''}
${hasGoogle && hasPw ? '<div class="or">또는</div>' : ''}
${hasPw ? `<form method="post" action="/auth/password">
<label for="pw">비밀번호</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required ${hasGoogle ? '' : 'autofocus'}>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">들어가기</button></form>` : ''}` : ''}
<p class="foot">한 번 들어오면 이 기기에서 30일 동안 다시 묻지 않아요.</p>
</main></body></html>`;
  return new Response(html, {
    status: configOk ? 200 : 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    },
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 1) 로그인 없이 열리는 것 (홈 화면 설치용 아이콘 · manifest)
  if (request.method === 'GET' && PUBLIC.some(re => re.test(path))) return context.next();

  // 2) 로그인 화면
  if (path === '/login') {
    const next = safeNext(url.searchParams.get('next'));
    if (await readSession(env, request)) return redirect(next);
    return loginPage(env, next, url.searchParams.get('e') || (url.searchParams.has('out') ? 'out' : ''));
  }

  // 3) 비밀번호로 들어오기
  if (path === '/auth/password' && request.method === 'POST') {
    let pw = '', next = '/';
    try { const f = await request.formData(); pw = String(f.get('password') || '').slice(0, 512); next = safeNext(String(f.get('next') || '/')); } catch (_) {}
    if (await passwordOk(env, pw)) return redirect(next, [await makeSession(env, 'pw')], 303);
    await sleep(900);   // 틀리면 조금 늦게 (마구 넣어 보기 늦추기)
    return redirect('/login?e=pw&next=' + encodeURIComponent(next), [], 303);
  }

  // 4) 구글 로그인 시작 → 구글 화면으로
  if (path === '/auth/google') {
    const next = safeNext(url.searchParams.get('next'));
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.ALLOWED_EMAIL || !env.SESSION_SECRET) return redirect('/login?e=nogoogle&next=' + encodeURIComponent(next));
    const state = b64u(crypto.getRandomValues(new Uint8Array(18)));
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: url.origin + '/auth/callback',
      response_type: 'code',
      scope: 'openid email',
      state,
      prompt: 'select_account',
      login_hint: env.ALLOWED_EMAIL,
    });
    return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, [cookie(STATE_COOKIE, state + '.' + b64uStr(next), 600)]);
  }

  // 5) 구글에서 돌아옴 → 계정 확인 → 들어오기
  if (path === '/auth/callback') {
    const [sv, nx] = (getCookie(request, STATE_COOKIE) || '').split('.');
    let next = '/';
    try { next = safeNext(unb64uStr(nx || '')); } catch (_) {}
    const code = url.searchParams.get('code');
    if (!code || !sv || url.searchParams.get('state') !== sv || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
      return redirect('/login?e=google&next=' + encodeURIComponent(next), [clear(STATE_COOKIE)]);
    }
    let claims = null;
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/auth/callback', grant_type: 'authorization_code' }),
      });
      if (r.ok) {
        const tok = await r.json();
        // 구글 토큰 창구에서 HTTPS로 바로 받은 id_token이라 서명 검사 없이 내용을 읽어도 돼요 (구글 OpenID 안내)
        claims = JSON.parse(unb64uStr(String(tok.id_token || '').split('.')[1] || ''));
      }
    } catch (_) { claims = null; }
    if (!claims) return redirect('/login?e=google&next=' + encodeURIComponent(next), [clear(STATE_COOKIE)]);
    const okIss = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    const okWho = okIss && claims.aud === env.GOOGLE_CLIENT_ID && (claims.email_verified === true || claims.email_verified === 'true')
      && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now()
      && String(claims.email || '').toLowerCase() === String(env.ALLOWED_EMAIL || '').trim().toLowerCase();
    if (!okWho) return redirect('/login?e=who&next=' + encodeURIComponent(next), [clear(STATE_COOKIE)]);
    return redirect(next, [clear(STATE_COOKIE), await makeSession(env, 'g')]);
  }

  // 6) 로그아웃
  if (path === '/auth/logout') return redirect('/login?out=1', [clear(COOKIE)]);

  // 7) 나머지는 모두 로그인 확인
  if (await readSession(env, request)) {
    const res = await context.next();
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', out.headers.get('Cache-Control') ? out.headers.get('Cache-Control') + ', private' : 'private');
    return out;
  }
  const nav = request.method === 'GET' && (request.headers.get('Sec-Fetch-Mode') === 'navigate' || (request.headers.get('Accept') || '').includes('text/html'));
  if (nav) return redirect('/login?next=' + encodeURIComponent(safeNext(path + url.search)));
  return new Response('로그인이 필요해요', { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
