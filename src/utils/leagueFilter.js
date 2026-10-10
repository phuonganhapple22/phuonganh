// Lọc bỏ trận bóng đá "giải cỏ": hạng 2/3, nữ, trẻ, dự bị, VĐQG các nước nhỏ...
//
// Cách hoạt động (chỉ áp dụng cho BÓNG ĐÁ, các môn khác giữ nguyên):
//   1. CHẶN trước: tên giải/đội có dấu hiệu hạng thấp, nữ, trẻ, dự bị -> bỏ.
//   2. Còn lại chỉ GIỮ nếu tên giải nằm trong danh sách giải lớn (ALLOW) -> các
//      giải khác (VĐQG Guatemala, Ngoại hạng Darwin, Giao hữu CLB...) bị bỏ.
// Tên giải trên các site trộn tiếng Việt lẫn tiếng Anh ("Hạng 2 Indonesia",
// "Italian Serie C", "RUS D3B") nên so khớp trên bản đã bỏ dấu + chữ thường.
//
// Chỉnh bằng biến môi trường (không cần sửa code):
//   LEAGUE_FILTER_SOURCES  nguồn áp dụng: "xoilac,xoigac" (mặc định) | "xoilac,gavang" | "all" | "none"
//   LEAGUE_ALLOW           từ khoá GIỮ thêm, cách nhau dấu phẩy. VD: "colombia,indonesia liga 1"
//   LEAGUE_BLOCK           từ khoá BỎ thêm.  VD: "friendly,giao huu clb"
// Từ khoá cũng được gõ có dấu/hoa thường tuỳ ý. LEAGUE_BLOCK thắng LEAGUE_ALLOW.

export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- 1. CHẶN (áp dụng trên tên giải) -------------------------------------
const BLOCK_LEAGUE = [
  /\bhang (2|3|4|hai|ba|bon|nhat|nhi)\b/, // Hạng 2 / Hạng Nhất / Hạng Ba...
  /\b(second|third|fourth) (division|league|tier)\b/,
  /\bdivision (2|3|ii|iii|two|three)\b/,
  /\b(liga|league|ligue|lig|serie|division|divisao|divizia|primera|segunda|ettan|liga) ?(2|3|ii|iii|two|one)\b/, // La Liga 2, Ligue 2, Premier League 2, League One
  /\b(2|3|ii|iii) (bundesliga|liga|lig|division)\b/, // 2. Bundesliga, 3. Liga
  /\bserie (b|c|d)\b/,
  /\bsegunda\b|\bprimera (b|nacional|federacion)\b|\bsegunda division\b|\bchampionship\b|\bnational league\b/,
  /\bj ?[23]\b|\bj ?league ?[23]\b|\bk ?league ?[23]\b|\bk3\b|\bk4\b|\bj3\b/,
  /\bd[2-5][a-z]?\b/, // RUS D3B, D2...
  /\b(u|under) ?(1[4-9]|2[0-3])\b|\byouth\b|\bjunior|\bacademy\b|\bcadet|\bsub ?(1[4-9]|2[0-3])\b/,
  /\breserves?\b|\bamateur\b|\bregional(liga)?\b|\boberliga\b|\bverbandsliga\b|\bdilettanti\b/,
  /\bwomen\b|\bwoman\b|\bfemin|\bfemen|\bnu\b|\bladies\b|\bw league\b|\bwsl\b/,
  /\b(futsal|beach|esports?|virtual|simulated)\b/
];

// Dấu hiệu nữ/trẻ/dự bị nằm trong TÊN ĐỘI (nhiều giải ghi tên giải trung tính).
const BLOCK_TEAM = [
  /\b(u|under) ?(1[4-9]|2[0-3])\b/,
  /\(w\)|\bwomen\b|\bwoman\b|\bfemin|\bfemen|\bladies\b|\bnu$|\sw$/,
  /\b(ii|iii|b|c)$/, // "Barcelona B", "Real Sociedad II"
  /\b(reserves?|youth|academy)\b/
];

// --- 2. GIỮ (áp dụng trên tên giải, sau khi qua bước chặn) ---------------
const ALLOW = [
  // Cúp châu lục & quốc tế
  /\buefa (champions|europa|conference|super)/, /^champions league$/, /^europa league$/, /\bconference league\b/,
  /\bafc champions league\b/, /\basian champions league\b/, /\bcup c[123]\b/, /^c1$/,
  /\bworld cup\b/, /\bvong loai (world cup|euro|asian cup|vck)\b/, /\bwc qualif/,
  /\beuro\b|\beuropean championship\b/, /^(uefa )?nations league$/, /\bcopa america\b/, /\basian cup\b/,
  /\bafrica cup of nations\b|\bafcon\b/, /\bgold cup\b/, /\bolympic/, /\bfifa\b/, /\bclub world cup\b/,
  /\bgiao huu quoc te\b|\binternational friendl/, /\bkirin (challenge )?cup\b/, /^vietnam(ese)? (national )?cup$|\bcup quoc gia\b/, /\bclub friendl.*(real madrid|barcelona|manchester|liverpool|arsenal|chelsea|bayern|juventus|milan|psg)/,
  // Giải VĐQG châu Âu lớn (neo ^$ để không lẫn "Egyptian Premier League", "Austrian Bundesliga"...)
  /^(english )?premier league$/, /^ngoai hang anh$/, /^(spanish )?la ?liga$/, /^(italian )?serie a$/,
  /^(german )?bundesliga$/, /^(french )?ligue 1$/, /^(dutch )?eredivisie$/, /^(portuguese )?primeira liga$/,
  /^(belgian )?(pro league|first division a)$/, /^(turkish )?(super lig|super league)$/, /^(scottish )?premiership$/,
  // Cúp quốc nội lớn
  /^(english )?fa cup$/, /\befl cup\b|\bcarabao\b|^league cup$/, /\bcommunity shield\b/, /\bcopa del rey\b/, /\bsupercopa\b/,
  /\bcoppa italia\b/, /\bsupercoppa\b/, /\bdfb pokal\b/, /\bsupercup\b/, /\bcoupe de france\b/, /\btrophee des champions\b/,
  // Châu Á
  /\bv ?league( 1)?\b/, /\bthai league 1\b/, /^j ?1 league$|^j ?league$|\bmeiji yasuda j1\b/, /\bk ?league 1\b/,
  /\bchinese super league\b|^csl$/, /\bsaudi (pro|professional) league\b|\bsaudi super cup\b/,
  // Châu Mỹ
  /\bmajor league soccer\b|^mls$/, /\bliga mx\b/, /\b(brazilian|brasileiro|brasileirao).*serie a\b|^campeonato brasileiro serie a$/,
  /\b(liga profesional|argentine primera|primera division argentina|argentine liga profesional)\b/,
  /\bcopa libertadores\b/, /\bcopa sudamericana\b/, /\bleagues cup\b/,
  // Tên tiếng Việt kiểu "VĐQG <nước>" cho các nước lớn
  /^vdqg (anh|tay ban nha|y|duc|phap|ha lan|bo dao nha|bi|tho nhi ky|scotland|viet nam|thai lan|nhat ban|han quoc|trung quoc|a rap xe ut|saudi arabia|my|mexico|brazil|argentina)$/
];

const envList = (name) =>
  String(process.env[name] || '')
    .split(',')
    .map((x) => normalizeName(x))
    .filter(Boolean);

/** Trả về { keep, reason } cho 1 trận bóng đá (đưa vào tên giải + tên 2 đội). */
export function judgeFootballLeague(leagueName, homeName = '', awayName = '') {
  const league = normalizeName(leagueName);
  if (!league) return { keep: true, reason: 'không có tên giải -> giữ' };

  const extraBlock = envList('LEAGUE_BLOCK');
  const hitBlock = extraBlock.find((k) => league.includes(k));
  if (hitBlock) return { keep: false, reason: `LEAGUE_BLOCK "${hitBlock}"` };

  const extraAllow = envList('LEAGUE_ALLOW');
  const hitAllow = extraAllow.find((k) => league.includes(k));
  if (hitAllow) return { keep: true, reason: `LEAGUE_ALLOW "${hitAllow}"` };

  const bl = BLOCK_LEAGUE.find((re) => re.test(league));
  if (bl) return { keep: false, reason: `giải thấp/nữ/trẻ (${bl})` };

  const teams = [normalizeName(homeName), normalizeName(awayName)];
  const bt = BLOCK_TEAM.find((re) => teams.some((t) => re.test(t)));
  if (bt) return { keep: false, reason: `đội nữ/trẻ/dự bị (${bt})` };

  const al = ALLOW.find((re) => re.test(league));
  if (al) return { keep: true, reason: 'giải lớn' };

  return { keep: false, reason: 'không thuộc danh sách giải lớn' };
}

function sourcesEnabled() {
  const raw = String(process.env.LEAGUE_FILTER_SOURCES ?? 'xoilac,xoigac').toLowerCase().trim();
  if (!raw || raw === 'none' || raw === 'off' || raw === '0') return null;
  if (raw === 'all' || raw === '*') return 'all';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** true = BỎ trận này. Chỉ động vào bóng đá của các nguồn được bật. */
export function shouldDropMatch(match, source) {
  if (String(match?.sport || '').toLowerCase() !== 'football') return false;
  const enabled = sourcesEnabled();
  if (!enabled) return false;
  if (enabled !== 'all' && !enabled.has(String(source || match?.source || '').toLowerCase())) return false;
  const league = match?.competition?.name || match?.leagueName || match?.league?.name || match?.league || '';
  return !judgeFootballLeague(league, match?.homeTeam?.name, match?.awayTeam?.name).keep;
}

/** Lọc cả danh sách + log gọn các giải bị bỏ (để chỉnh LEAGUE_ALLOW nếu lỡ tay). */
export function filterMinorLeagues(matches, source) {
  const dropped = new Map();
  const kept = (matches || []).filter((m) => {
    if (!shouldDropMatch(m, source)) return true;
    const name = m?.competition?.name || m?.leagueName || '(không tên)';
    dropped.set(name, (dropped.get(name) || 0) + 1);
    return false;
  });
  if (dropped.size) {
    const sample = [...dropped.entries()].slice(0, 12).map(([n, c]) => `${n} x${c}`).join('; ');
    console.log(`[leagueFilter:${source}] bỏ ${[...dropped.values()].reduce((a, b) => a + b, 0)} trận giải nhỏ: ${sample}${dropped.size > 12 ? '; ...' : ''}`);
  }
  return kept;
}
