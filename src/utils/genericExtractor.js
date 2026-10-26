const cheerio = require('cheerio');
const { createHttpClient } = require('./httpClient');

const client = createHttpClient(
  {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
    },
    timeout: 12000
  },
  { maxAttempts: 2 }
);

// Matches .m3u8 / .flv URLs whether written plain or JSON-escaped (\/ , \u0026 ...)
const STREAM_URL_RE = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|flv)(?:\?[^\s"'<>\\]*)?/gi;
const IFRAME_SRC_RE = /<iframe[^>]+src=["']([^"']+)["']/gi;

function cleanUrl(raw) {
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function absolutize(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return '';
  }
}

function extractStreamUrls(html) {
  const found = new Set();
  const matches = html.match(STREAM_URL_RE) || [];
  matches.forEach((u) => found.add(cleanUrl(u)));
  return [...found];
}

function extractIframes(html, baseUrl) {
  const out = [];
  let m;
  IFRAME_SRC_RE.lastIndex = 0;
  while ((m = IFRAME_SRC_RE.exec(html))) {
    const src = absolutize(m[1], baseUrl);
    if (src && /^https?:\/\//i.test(src)) out.push(src);
  }
  return out;
}

function extractMeta($, name) {
  return (
    $(`meta[property="${name}"]`).attr('content') ||
    $(`meta[name="${name}"]`).attr('content') ||
    ''
  );
}

/** Best-effort "Home vs Away" split from a page/tab title. */
function guessTeams(title) {
  if (!title) return null;
  const cleaned = title
    .replace(/\s*[-–|].*(trực tiếp|truc tiep|live stream|xem trực tiếp).*/i, '')
    .trim();
  const parts = cleaned.split(/\s+(?:vs\.?|VS\.?|Vs\.?|–|-)\s+/);
  if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
    return { home: parts[0].trim(), away: parts[1].trim() };
  }
  return null;
}

/**
 * Fetch a page (and, if needed, follow up to one level of <iframe>) and try
 * to auto-detect a live .m3u8/.flv stream URL + basic match metadata using
 * generic heuristics. Works across arbitrary/unknown sites — no site-specific
 * parsing required, so it's the basis for "add a new source just by pasting
 * a few sample links".
 */
async function analyzeSourceLink(url) {
  const result = {
    url,
    ok: false,
    title: '',
    homeTeam: '',
    awayTeam: '',
    logo: '',
    streamUrls: [],
    error: ''
  };

  try {
    const { data: html } = await client.get(url);
    const $ = cheerio.load(html);

    result.title = $('title').first().text().trim() || extractMeta($, 'og:title');
    result.logo = extractMeta($, 'og:image');

    let streamUrls = extractStreamUrls(html);

    if (!streamUrls.length) {
      const iframes = extractIframes(html, url).slice(0, 2);
      for (const iframeUrl of iframes) {
        try {
          const { data: iframeHtml } = await client.get(iframeUrl, {
            headers: { Referer: url }
          });
          streamUrls = extractStreamUrls(iframeHtml);
          if (!streamUrls.length) {
            const nested = extractIframes(iframeHtml, iframeUrl).slice(0, 1);
            for (const nestedUrl of nested) {
              const { data: nestedHtml } = await client.get(nestedUrl, {
                headers: { Referer: iframeUrl }
              });
              streamUrls = extractStreamUrls(nestedHtml);
              if (streamUrls.length) break;
            }
          }
          if (streamUrls.length) break;
        } catch {
          // try next iframe candidate
        }
      }
    }

    result.streamUrls = streamUrls;

    const teams = guessTeams(result.title);
    if (teams) {
      result.homeTeam = teams.home;
      result.awayTeam = teams.away;
    }

    result.ok = streamUrls.length > 0;
    if (!result.ok) {
      result.error = 'Không tìm thấy link .m3u8/.flv trên trang (kể cả trong iframe lồng bên trong).';
    }
  } catch (err) {
    result.error = err.message || 'Không tải được trang';
  }

  return result;
}

module.exports = { analyzeSourceLink, extractStreamUrls, extractIframes, guessTeams };
