/**
 * Extract SEO slug from Gavang live URL.
 * example.com/truc-tiep/arema-fc-vs-dpmm-fc-ngay-31-07-2026/ → arema-fc-vs-dpmm-fc-ngay-31-07-2026
 */
function extractSlugFromUrl(url) {
  if (!url) return '';
  try {
    const path = String(url).split('?')[0].replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'truc-tiep');
    if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
    return decodeURIComponent(parts[parts.length - 1] || '');
  } catch {
    return '';
  }
}

function slugifyVi(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build SEO slug from match teams + date (fallback when liveUrl missing).
 * arema-fc-vs-dpmm-fc-ngay-31-07-2026
 */
function buildMatchSlug(match) {
  if (match?.slug) return String(match.slug).replace(/^\/+|\/+$/g, '');

  const fromUrl = extractSlugFromUrl(match?.stream?.liveUrl || match?.liveUrl || match?.detailUrl);
  if (fromUrl) return fromUrl;

  const home = slugifyVi(match?.homeTeam?.name);
  const away = slugifyVi(match?.awayTeam?.name);
  if (!home || !away) return match?.matchId || '';

  let datePart = '';
  const ts = match?.matchTimeTimestamp || match?.matchTime;
  if (ts) {
    const ms = ts < 99999999999 ? ts * 1000 : ts;
    const d = new Date(ms);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    datePart = `-ngay-${dd}-${mm}-${yyyy}`;
  }

  return `${home}-vs-${away}${datePart}`;
}

module.exports = {
  extractSlugFromUrl,
  slugifyVi,
  buildMatchSlug
};
