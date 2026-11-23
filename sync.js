/* jws-lab 기록 맞추기 (2026-11-24) — 로그인한 나만의 저장소(/api/sync/<이름>, Cloudflare D1)와 이 기기를 맞춰요.
   앱에서 쓰는 법 (Firestore 문서처럼 생겼어요):
     const ref = JWSSYNC.doc('이름', { local: () => 이 기기의 지금 기록, join: (서버 기록, 이 기기 기록) => 합친 기록,
                                     merge3: (마지막으로 본 서버 기록, 내 기록, 지금 서버 기록) => 합친 기록 });
     ref.onSnapshot(cb)  — 처음 한 번, 그리고 다른 기기에서 바뀐 것을 받아 올 때 cb({exists, data(), metadata})
     ref.set(obj)        — 1.5초 모아서 올림 · 못 올리면 이 기기에 두었다가 연결되면 올림
   - 기기마다 처음 연결할 때(또는 오프라인에서 바꾼 것이 남아 있을 때) 서버 기록과 이 기기 기록을 join으로 합쳐요 → 어느 쪽도 안 사라짐.
   - 화면으로 돌아올 때 · 60초마다(보고 있을 때) 다른 기기의 새 기록을 받아 와요.
   - 올릴 때 그사이 다른 기기가 바꿨으면(서버 409) merge3로 '내가 바꾼 것'만 지금 서버 기록 위에 얹어 다시 올리고, 화면에도 알려요.
   - 로그인이 끝났거나(401) 저장소가 없으면(503) 조용히 멈추고, 앱은 이 기기에만 저장해요.
   - 바꾸면 이 파일을 부르는 주소의 ?v= 숫자를 올려요 (앱 서비스 워커가 옛 파일을 계속 쓰지 않게). */
(() => {
  if (window.JWSSYNC) return;
  const API = location.origin + '/api/sync/';
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const docs = [];

  async function call(name, body, keepalive) {
    const r = await fetch(API + encodeURIComponent(name), {
      method: 'POST', credentials: 'same-origin', keepalive: !!keepalive, cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 401 || r.status === 503) { const e = new Error('stop'); e.stop = true; throw e; }
    if (r.status === 409) return Object.assign(await r.json(), { conflict: true });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }

  function doc(name, opts = {}) {
    const PEND = 'jwslab-sync-pending:' + name, JOINED = 'jwslab-sync-joined:' + name;
    const d = { name, v: null, base: null, cb: null, pending: null, timer: 0, stopped: false, loading: false, first: true };
    try { d.pending = JSON.parse(LS.get(PEND) || 'null'); } catch (_) { d.pending = null; }
    const snap = (exists, data) => ({ exists, data: () => data, metadata: { hasPendingWrites: false } });
    const clone = o => (o == null ? null : JSON.parse(JSON.stringify(o)));

    async function flush(keepalive) {
      clearTimeout(d.timer); d.timer = 0;
      if (!d.pending || d.stopped || d.v === null) return;
      let send = d.pending, merged = false;
      try {
        for (let i = 0; i < 3; i++) {
          const r = await call(name, { op: 'put', data: send, base: d.v }, keepalive);
          if (!r.conflict) {
            d.v = r.v; d.base = clone(send);
            if (d.pending === send || merged) { d.pending = null; LS.del(PEND); }
            if (merged && d.cb) d.cb(snap(true, clone(send)));      // 다른 기기 기록과 합친 결과를 화면에도
            return;
          }
          // 그사이 다른 기기가 바꿈 → 내가 바꾼 것만 지금 서버 기록 위에 얹기
          const theirs = r.exists ? r.data : null;
          send = opts.merge3 ? opts.merge3(d.base, send, theirs) : send;
          d.v = r.v; d.base = clone(theirs); merged = true;
          d.pending = send; LS.set(PEND, JSON.stringify(send));
        }
      } catch (e) { if (e.stop) d.stopped = true; }
    }

    async function load() {
      if (d.stopped || d.loading || !d.cb) return;
      d.loading = true;
      try {
        const r = await call(name, { op: 'get' });
        if (d.first) {
          d.first = false;
          let data = r.exists ? r.data : null;
          const local = opts.local ? opts.local() : null;
          const mustJoin = r.exists && opts.join && (!LS.get(JOINED) || d.pending);
          if (mustJoin) {
            const mine = d.pending || local;
            const merged = mine ? opts.join(data, mine) : data;
            d.v = r.v; d.base = clone(data);
            if (JSON.stringify(merged) !== JSON.stringify(data)) {
              d.pending = merged; LS.set(PEND, JSON.stringify(merged));
              await flush();
            } else { d.pending = null; LS.del(PEND); }
            data = merged;
          } else {
            d.v = r.v; d.base = clone(data);
            if (!r.exists && d.pending) await flush();
          }
          LS.set(JOINED, '1');
          d.cb(snap(r.exists || !!(mustJoin && data), data));
          return;
        }
        if (d.pending) { await flush(); return; }          // 이 기기에서 바꾼 것을 먼저 올림
        if (r.v !== d.v) { d.v = r.v; d.base = clone(r.exists ? r.data : null); if (r.exists) d.cb(snap(true, r.data)); }
      } catch (e) {
        if (e.stop) d.stopped = true;                      // 로그인 끝 · 저장소 없음 → 멈춤
      } finally { d.loading = false; }
    }

    const ref = {
      onSnapshot(cb) { d.cb = cb; load(); return () => { d.cb = null; }; },
      set(obj) {
        d.pending = JSON.parse(JSON.stringify(obj || {}));
        LS.set(PEND, JSON.stringify(d.pending));
        clearTimeout(d.timer); d.timer = setTimeout(() => flush(), 1500);
        return Promise.resolve();
      },
      _flush: flush, _load: load, _state: d,
    };
    docs.push(ref);
    return ref;
  }

  // 화면으로 돌아오면 받아 오기 · 떠날 때 남은 것 올리기 · 다시 연결되면 둘 다
  document.addEventListener('visibilitychange', () => {
    for (const r of docs) document.visibilityState === 'visible' ? r._load() : r._flush(true);
  });
  addEventListener('pagehide', () => { for (const r of docs) r._flush(true); });
  addEventListener('online', () => { for (const r of docs) { r._state.stopped = false; r._flush().then(() => r._load()); } });
  setInterval(() => { if (document.visibilityState === 'visible') for (const r of docs) r._load(); }, 60000);

  window.JWSSYNC = { doc };
})();
