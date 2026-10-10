#!/usr/bin/env node
// Dò đường lấy link phát của Xoigac. Chạy trên MÁY BẠN (sandbox không vào được site):
//
//   node scripts/probe-xoigac.mjs                    # tự chọn 1 trận đang có BLV phát
//   node scripts/probe-xoigac.mjs --id 334565        # ép 1 mã trận cụ thể
//   node scripts/probe-xoigac.mjs --base https://xoigac.top
//
// Cần Node 18+ (có sẵn fetch). Không cài thêm gì. Nên chạy KHI CÓ TRẬN ĐANG LIVE.
// Kết quả in ra là báo cáo ngắn — copy toàn bộ dán lại cho người đang hỗ trợ.

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};
const BASES = argVal('--base')
  ? [argVal('--base').replace(/\/+$/, '')]
  : [String(process.env.XOIGAC_DOMAIN || 'https://xoigac.live').replace(/\/+$/, '')];
const FORCE_ID = argVal('--id');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const short = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…(+${t.length - n})` : t;
};
const log = (...a) => console.log(...a);

async function get(url, { referer = null, accept = '*/*', max = 400000 } = {}) {
  const headers = { 'User-Agent': UA, Accept: accept };
  if (referer) headers.Referer = referer;
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(12000) });
    const ct = res.headers.get('content-type') || '';
    let body = '';
    try {
      body = (await res.text()).slice(0, max);
    } catch {
      /* body không đọc được thì bỏ qua */
    }
    return { ok: true, status: res.status, location: res.headers.get('location') || '', ct, body };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}`, status: 0, location: '', ct: '', body: '' };
  }
}

function report(label, r) {
  if (!r.ok) return log(`  [${label}] LỖI MẠNG: ${r.error}`);
  const loc = r.location ? ` -> Location: ${short(r.location, 260)}` : '';
  log(`  [${label}] HTTP ${r.status} ${short(r.ct, 40)}${loc}`);
  if (r.status >= 200 && r.status < 300 && r.body) log(`      body: ${short(r.body, 220)}`);
}

function grepLines(text, re, limit = 8) {
  const out = [];
  for (const line of String(text).split(/\r?\n|;/)) {
    if (re.test(line)) {
      out.push(short(line, 240));
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function main() {
  log('=== PROBE XOIGAC ===', new Date().toISOString());

  // 1) Trang chủ -> focusMatchesData
  let base = '';
  let records = [];
  let cards = new Map();
  for (const b of BASES) {
    const r = await get(`${b}/`, { accept: 'text/html', max: 8000000 });
    report(`trang chủ ${b}`, r);
    const m = r.body.match(/<script[^>]*id=["']focusMatchesData["'][^>]*>([\s\S]*?)<\/script>/i);
    if (r.status === 200 && m) {
      try {
        records = JSON.parse(m[1]);
        base = b;
        for (const tag of r.body.matchAll(/<div class="focus-card [^>]*>/g)) {
          const id = (tag[0].match(/data-card-id="([^"]*)"/) || [])[1];
          const url = (tag[0].match(/data-stream-url="([^"]*)"/) || [])[1];
          if (id && url) cards.set(id, url);
        }
        break;
      } catch (e) {
        log(`  focusMatchesData parse lỗi: ${e.message}`);
      }
    }
  }
  if (!base) return log('KHÔNG vào được trang chủ Xoigac trên domain nào -> gửi nguyên đoạn trên.');
  log(`Dùng domain: ${base} | ${records.length} bản ghi | ${cards.size} thẻ`);

  // 2) Chọn trận
  const live = records.filter((r) => r.isStreamerLiveNow === true);
  const pick = FORCE_ID ? records.find((r) => String(r.id) === FORCE_ID) : live[0] || records[0];
  log(`Trận đang có BLV phát: ${live.length}. ${live.slice(0, 6).map((r) => `${r.id} ${r.homeTeam} v ${r.awayTeam} (${r.status})`).join(' | ') || '(không có — thử lại khi có trận live)'}`);
  if (!pick) return log('Không chọn được trận.');
  const pid = pick.playbackIdentifier || `${pick.id}_${pick.streamSessionId}`;
  log(`\nTRẬN THỬ: id=${pick.id} | ${pick.homeTeam} vs ${pick.awayTeam} | status=${pick.status} isLive=${pick.isLive} streamerLive=${pick.isStreamerLiveNow} | playbackIdentifier=${pid} | streamer=${pick.streamerNickname} | matchUrl=${pick.matchUrl}`);
  log(`data-stream-url trên thẻ: ${cards.get(pid) || cards.get(String(pick.id)) || '(không thấy)'}`);

  // 3) Thử các đường /hls/ (không Referer, rồi Referer site)
  log('\n--- A. Đường /hls/ trên site');
  const cand = [`/hls/${pick.id}/index.m3u8`, `/hls/${pid}/index.m3u8`, `/hls/${pick.id}_${pick.streamSessionId}/index.m3u8`];
  for (const p of [...new Set(cand)]) {
    report(`GET ${p} (không Referer)`, await get(`${base}${p}`, { accept: 'application/x-mpegURL, */*' }));
    report(`GET ${p} (Referer site)`, await get(`${base}${p}`, { referer: `${base}/`, accept: 'application/x-mpegURL, */*' }));
  }

  // 3b) API thật của trình phát (xác nhận 05/10/2026): /api/stream/info/<playbackIdentifier> -> { playbackUrl }
  log('\n--- A2. API /api/stream/info (nguồn link IVS thật)');
  for (const r of (live.length ? live : [pick]).slice(0, 3)) {
    const id = r.playbackIdentifier || `${r.id}_${r.streamSessionId}`;
    const a = await get(`${base}/api/stream/info/${id}`, { referer: `${base}/`, accept: 'application/json' });
    report(`GET /api/stream/info/${id} (BLV ${r.streamerNickname})`, a);
    try {
      const j = JSON.parse(a.body);
      log(`      playbackUrl: ${j.playbackUrl ? short(j.playbackUrl, 160) : '(không có)'} | keys: ${Object.keys(j).join(',')}`);
    } catch {
      /* không phải JSON thì bỏ qua */
    }
  }

  // 4) Trang chi tiết trận -> meta
  log('\n--- B. Trang chi tiết trận (thẻ meta)');
  const detailUrl = `${base}${String(pick.matchUrl || '').startsWith('/') ? '' : '/'}${pick.matchUrl || ''}`;
  const d = await get(detailUrl, { accept: 'text/html' });
  report('chi tiết', d);
  const metas = {};
  for (const m of d.body.matchAll(/<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]*content=["']([^"']*)["']/gi)) metas[m[1]] = m[2];
  for (const k of Object.keys(metas).filter((k) => /match|stream|play|video|ivs/i.test(k))) log(`  meta ${k} = ${short(metas[k], 200)}`);
  log('  dòng có m3u8/live-video/playback trong HTML chi tiết:');
  grepLines(d.body, /live-video\.net|\.m3u8|playbackUrl|playback_url|streamUrl|hls\//i).forEach((l) => log(`    ${l}`));

  // 5) Trang player riêng (meta match-play-url)
  const playUrl = metas['match-play-url'] || '';
  log('\n--- C. Trang player riêng');
  if (!playUrl) {
    log('  (trang chi tiết không có match-play-url)');
  } else {
    log(`  play-url = ${playUrl}`);
    const p = await get(playUrl, { accept: 'text/html', referer: `${base}/` });
    report('player', p);
    log('  dòng nghi vấn trong HTML player:');
    grepLines(p.body, /live-video\.net|m3u8|\/api\/|fetch\(|token|playback|channel/i, 14).forEach((l) => log(`    ${l}`));
    const scripts = [...p.body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    log(`  <script src>: ${scripts.join(' , ') || '(không có)'}`);
    for (const s of scripts.slice(0, 6)) {
      let su;
      try {
        su = new URL(s, playUrl).href;
      } catch {
        continue;
      }
      if (/hls\.|video\.|cdn|jquery|bootstrap|googleapis|cloudflare/i.test(su) && !/player|app|main|ivs|stream/i.test(su)) continue;
      const js = await get(su, { referer: playUrl, max: 600000 });
      log(`  [js ${short(su, 100)}] HTTP ${js.status}, ${js.body.length} ký tự`);
      grepLines(js.body, /live-video\.net|\/api\/[a-z]|\.m3u8|playbackUrl|getPlayback|token/i, 8).forEach((l) => log(`      ${l}`));
    }
  }

  log('\n=== HẾT. Copy toàn bộ từ dòng "=== PROBE XOIGAC ===" dán lại. ===');
}

main().catch((e) => {
  console.error('Lỗi script:', e);
  process.exitCode = 1;
});
