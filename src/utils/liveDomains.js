// Domain THẬT đang sống của từng nguồn, học được LÚC CHẠY (không chờ ai sửa biến SOURCE_DOMAINS).
//
// FIX (31/10/2026 — "domain cũ đã chuyển hướng nhưng Generate vẫn quét domain cũ, trận live mất link,
// log: [xoilac] lỗi mở trang nhúng https://xl365.domainkqt.cc/... (Referer https://xoilacvbx.tv): 403"):
// các service đọc domain 1 lần lúc khởi động (process.env.X || mặc định) rồi dùng mãi, kể cả Referer/Origin gửi
// cho trang nhúng. Domain cũ vẫn mở được trang chủ (redirect hoặc còn phục vụ) nên danh sách trận quét được,
// nhưng trang nhúng chỉ nhận Referer là domain MỚI -> 403 -> mất hết trận live. Module này giúp service:
//   1) biết domain sau redirect (originFromResponse) và dùng nó làm domain chính (setLiveDomain/getLiveDomain);
//   2) có danh sách domain dự phòng lấy từ lịch sử data/source-domains.json (historyDomains);
//   3) tự nhờ workflow Check Domains dò domain mới khi mọi domain đều bị từ chối (requestDomainRecheck).

import fs from 'node:fs';
import path from 'node:path';

const live = new Map(); // key nguồn -> origin đang dùng thật

const stripSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

export function originOf(url) {
  try {
    const s = String(url || '').trim();
    if (!s) return '';
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).origin;
  } catch {
    return '';
  }
}

export function setLiveDomain(key, origin) {
  const o = originOf(origin);
  if (o) live.set(key, o);
  return o;
}

export function getLiveDomain(key, fallback = '') {
  return live.get(key) || stripSlash(fallback);
}

/** Origin cuối cùng của 1 response axios sau khi đã theo redirect ('' nếu không đọc được). */
export function originFromResponse(res) {
  const finalUrl = res?.request?.res?.responseUrl || res?.request?._redirectable?._currentUrl || res?.request?.responseURL || '';
  return /^https?:\/\//i.test(finalUrl) ? originOf(finalUrl) : '';
}

/** Domain từng/đang dùng của 1 nguồn theo lịch sử trong git (mới nhất trước) + domain tìm thấy gần nhất. */
export function historyDomains(key, { dir = process.env.SNAPSHOT_DIR || 'data' } = {}) {
  const out = [];
  const add = (u) => {
    const o = originOf(u);
    if (o && !out.includes(o)) out.push(o);
  };
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(process.cwd(), dir, 'source-domains.json'), 'utf8'));
    const cur = snap?.domains?.[key];
    if (cur) {
      add(typeof cur === 'string' ? cur : cur.url);
      if (cur.found) add(cur.found); // domain mới tìm thấy nhưng chưa áp dụng được vào biến
    }
    const hist = Array.isArray(snap?.history) ? snap.history : [];
    for (const h of [...hist].reverse()) {
      if (h?.source !== key) continue;
      add(h.to);
      add(h.from);
    }
  } catch {
    /* chưa có file */
  }
  return out.slice(0, 12);
}

// ---- nhờ workflow Check Domains dò lại domain (chỉ chạy trên GitHub Actions, có giới hạn tần suất) ----
const recheckAt = new Map(); // key -> thời điểm gọi gần nhất
const RECHECK_MIN_GAP_MS = Number(process.env.DOMAIN_RECHECK_MIN_GAP_MS) > 0 ? Number(process.env.DOMAIN_RECHECK_MIN_GAP_MS) : 45 * 60 * 1000;

/**
 * Gọi workflow_dispatch check-domains.yml cho nguồn `key`, ép dò lại (force_discover) và loại các domain
 * `excluded` (domain đã thử mà trang nhúng/ API vẫn từ chối). Không bao giờ ném lỗi. Trả true nếu đã gọi.
 * Tắt: DOMAIN_RECHECK=off.
 */
export async function requestDomainRecheck(key, excluded = [], { fetchImpl = globalThis.fetch, log = console } = {}) {
  try {
    if (/^(0|false|no|off)$/i.test(String(process.env.DOMAIN_RECHECK ?? '1').trim() || '1')) return false;
    const token = process.env.GITHUB_TOKEN || '';
    const repo = process.env.GITHUB_REPOSITORY || '';
    const ref = process.env.GITHUB_REF_NAME || 'main';
    if (!token || !repo || typeof fetchImpl !== 'function') return false;
    const last = recheckAt.get(key) || 0;
    if (Date.now() - last < RECHECK_MIN_GAP_MS) return false;
    recheckAt.set(key, Date.now());
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/check-domains.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref,
        inputs: {
          sources: key,
          auto_fix: 'true',
          restart_generator: 'true',
          save_snapshot: 'true',
          force_discover: key,
          exclude_domains: [...new Set(excluded.map((d) => originOf(d)).filter(Boolean))].join(',')
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (res.status === 204) {
      log.log(`[domains] ${key}: mọi domain đều bị từ chối -> đã nhờ workflow Check Domains dò domain mới (xem tab Actions > Check Domains)`);
      return true;
    }
    log.warn(`[domains] ${key}: gọi Check Domains thất bại (HTTP ${res.status}) — chạy tay Actions > Check Domains nếu cần`);
  } catch (err) {
    log.warn(`[domains] ${key}: không gọi được Check Domains: ${err?.message || err}`);
  }
  return false;
}
