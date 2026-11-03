import { createHttpClient } from '@/src/utils/httpClient';

// FIX (27/09/2026 — theo yêu cầu, thêm nguồn GaVang33TV): trang
// https://gavang33.me/ là 1 SPA (React/Vue, xem file build index-*.js) —
// HTML gốc rỗng, không dò được bằng cheerio như gavang.service.js. Người
// dùng tự bắt bằng DevTools ra đúng API JSON thật mà trang gọi:
//   GET https://gavangtv-api.adviceme.io/api/v1/matches?webType=gavang
// trả về TOÀN BỘ trận (live + sắp đá) trong 1 lần gọi DUY NHẤT, đã kèm sẵn
// link .m3u8/.flv theo từng BLV ngay trong danh sách (không cần gọi thêm
// trang/API chi tiết riêng như saoke/gavang) — object `data` là map
// slug -> match, không phải mảng.
//
// Domain API này CHUNG cho cả họ site "GaVangTV" nhái (gavang33.me chỉ là
// 1 trong rất nhiều domain clone cùng thương hiệu/gtag) nên khả năng cao
// domain API này ổn định hơn domain xem — vẫn cho override qua env phòng
// khi đổi.
const GAVANG33_API_BASE_URL = process.env.GAVANG33_API_DOMAIN || 'https://gavangtv-api.adviceme.io';
const GAVANG33_SITE_URL = process.env.GAVANG33_DOMAIN || 'https://gavang33.me';

const client = createHttpClient(
  {
    baseURL: GAVANG33_API_BASE_URL,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
      // KHÔNG cần Referer/Origin — đã tự fetch thử thẳng link .m3u8 CDN
      // (live2.zktsva.app) không kèm Referer nào, CDN vẫn trả về bình
      // thường (khác hẳn Chuối Chiên/Sao Kê, xem chuoichientv.service.js).
    },
    timeout: 10000
  },
  { maxAttempts: 3, retryDelayMs: 1000 }
);

/** Mỗi phần tử anchorAppointmentVoList = 1 BLV, kèm sẵn streamUrls [m3u8, flv]. */
function buildCommentators(anchorList) {
  const list = [];
  for (const a of Array.isArray(anchorList) ? anchorList : []) {
    const urls = Array.isArray(a?.streamUrls) ? a.streamUrls.filter(Boolean) : [];
    // Ưu tiên .m3u8 (HLS) lên trước, .flv dự phòng — cùng cách xếp hạng
    // gavang.service.js đã dùng cho lý do tương tự (app/player xử lý HLS
    // tốt hơn hẳn FLV).
    const url = urls.find((u) => /\.m3u8(\?|$)/i.test(u)) || urls[0] || '';
    if (!url) continue;
    list.push({
      id: a?.id || a?.slug || `blv_${list.length}`,
      name: a?.nickName || a?.slug || 'BLV',
      avatar: a?.userImage || null,
      streamUrl: url,
      isLive: true,
      cdn: 'HLS'
      // Không set field `referer` — nguồn này không cần Referer (xem ghi
      // chú ở client phía trên), m3uPlaylist.js sẽ để trống #EXTVLCOPT
      // Referer cho nguồn này thay vì đoán bừa 1 domain không cần thiết.
    });
  }
  return list;
}

function mapStreams(match) {
  const list = [];
  const seen = new Set();
  for (const c of match?.commentators || []) {
    const url = c.streamUrl || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    list.push({
      id: c.id,
      streamerId: c.id,
      name: c.name,
      streamerName: c.name,
      avatar: c.avatar,
      streamerAvatar: c.avatar,
      link: url,
      m3u8Url: url,
      playUrl: url,
      format: 'hls',
      cdn: c.cdn,
      quality: 'HD'
    });
  }
  return list;
}

function normalizeMatch(m) {
  const matchDate = new Date((Number(m?.matchTime) || 0) * 1000);
  const isLive = m?.matchStatus === 'live';
  const isUpcoming = m?.matchStatus === 'scheduled';
  const isFinished = !isLive && !isUpcoming; // mọi giá trị khác (kể cả lạ/chưa gặp) coi là đã kết thúc, không hiện trong live/upcoming
  const commentators = isLive ? buildCommentators(m?.anchorAppointmentVoList) : [];

  const timeStr = matchDate.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Ho_Chi_Minh'
  });
  const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const dd = String(matchDate.getDate()).padStart(2, '0');
  const mm = String(matchDate.getMonth() + 1).padStart(2, '0');
  const slug = m?.slug || m?.matchId || '';
  const detailUrl = slug ? `${GAVANG33_SITE_URL}/truc-tiep/${slug}` : GAVANG33_SITE_URL;

  return {
    matchId: `gv33_${m?.matchId || slug}`,
    originalId: m?.matchId || slug,
    slug,
    detailUrl,
    source: 'gavang33',
    sport: 'football',
    sportName: 'BÓNG ĐÁ',
    sportIcon: 'fa-futbol',
    competition: { name: m?.competition?.name || '', logo: m?.competition?.logo || '', icon: m?.competition?.logo || '' },
    homeTeam: { name: m?.homeTeam?.name || 'Home', logo: m?.homeTeam?.logo || '' },
    awayTeam: { name: m?.awayTeam?.name || 'Away', logo: m?.awayTeam?.logo || '' },
    // FIX (27/09/2026): homeScores/awayScores API trả về là MẢNG nhiều số
    // không rõ ý nghĩa từng phần tử (không khớp kiểu tỉ số bóng đá thông
    // thường khi đối chiếu mẫu thật — có trận đang HT mà mảng toàn số 2-3),
    // có thể là dữ liệu thống kê khác (theSports) bị chuyển tiếp nguyên
    // dạng chứ không phải tỉ số hiệp — KHÔNG suy đoán bừa, để mặc định 0-0
    // giống saoke.service.js.
    score: { home: 0, away: 0 },
    status: {
      isLive,
      isFinished,
      isHalfTime: /^HT$/i.test(String(m?.matchNormalizedTime || '')),
      isUpcoming,
      name: isLive ? (m?.matchNormalizedTime || 'LIVE') : (isFinished ? 'FT' : 'Sắp diễn ra'),
      text: isLive ? (m?.matchNormalizedTime || 'LIVE') : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
      elapsedTime: isLive ? (m?.matchNormalizedTime || '') : '',
      minutes: m?.matchNormalizedTime || ''
    },
    stats: { halfTimeScore: '0-0', corners: '0-0', yellowCards: '0-0' },
    matchTime: matchDate.getTime(),
    matchTimeTimestamp: matchDate.getTime(),
    timeFormatted: `${timeStr} - ${dd}/${mm}`,
    dateStr,
    timeStr,
    isHot: !!m?.pinHot || !!m?.pinHome,
    commentators,
    streamers: commentators,
    streamUrl: commentators[0]?.streamUrl || '',
    stream: {
      // Trận chưa live/chưa có BLV -> vẫn khác rỗng (trỏ trang chi tiết),
      // xem FIX 23/09/2026 trong phalang.service.js — cùng lý do, cùng cách sửa.
      liveUrl: detailUrl,
      streamerName: commentators[0]?.name || null,
      streamerAvatar: commentators[0]?.avatar || null
    },
    odds: null
  };
}

class GaVang33Service {
  async fetchAllMatches() {
    const { data } = await client.get('/api/v1/matches', { params: { webType: 'gavang' } });
    const map = data?.data;
    if (!map || typeof map !== 'object') return [];
    return Object.values(map).map((m) => normalizeMatch(m));
  }

  async getAllMatchesByTab(tab, sport = 'all') {
    try {
      const all = await this.fetchAllMatches();
      let filtered = all;
      if (tab === 'live') filtered = all.filter((m) => m.status.isLive);
      else if (tab === 'upcoming') filtered = all.filter((m) => m.status.isUpcoming);
      if (sport !== 'all') filtered = filtered.filter((m) => m.sport === sport);

      // Chỉ lấy trận LIVE có ít nhất 1 BLV kèm link — giống quy tắc đã áp
      // dụng cho mọi nguồn khác trong project (saoke/gavang/phalang).
      filtered = filtered.filter((m) => !m.status.isLive || m.commentators.length > 0);

      return { matches: filtered, hasMore: false, totalCount: filtered.length };
    } catch (error) {
      console.error(`Error fetching GaVang33 tab ${tab}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  async getStreamLinks(matchId) {
    try {
      const all = await this.fetchAllMatches();
      const cleanId = String(matchId).replace(/^gv33_/, '');
      const match = all.find((m) => m.originalId === cleanId || m.matchId === matchId || m.slug === matchId);
      if (!match) return [];
      return mapStreams(match);
    } catch (error) {
      console.error('Error fetching GaVang33 stream links:', error.message);
      return [];
    }
  }
}

const gavang33Service = new GaVang33Service();
export default gavang33Service;
