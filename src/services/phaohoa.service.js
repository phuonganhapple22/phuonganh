import { createHttpClient } from '@/src/utils/httpClient';
import { buildMatchSlug, slugifyVi } from '@/src/utils/slug';

// Domain nguồn lậu này cũng đổi thường xuyên — override qua biến môi trường
// PHAOHOA_BASE_URL trên Vercel khi cần, không cần sửa code.
const PHAOHOA_BASE_URL = process.env.PHAOHOA_DOMAIN || process.env.PHAOHOA_BASE_URL || 'https://phaohoa1.live';

class PhaoHoaService {
  constructor() {
    this.client = createHttpClient({
      baseURL: PHAOHOA_BASE_URL,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${PHAOHOA_BASE_URL}/`
      }
    });
  }

  getFullUrl(url) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${PHAOHOA_BASE_URL}${url}`;
  }

  detectCdn(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('tencent') || u.includes('tlivecdn') || u.includes('liveplay')) return 'TENCENT';
    if (u.includes('alibaba') || u.includes('aliyun') || u.includes('alicdn')) return 'ALIBABA';
    if (u.includes('phaohoa')) return 'PHAOHOA';
    if (u.includes('cloudflare')) return 'CLOUDFLARE';
    return 'HLS';
  }

  normalizeMatch(m) {
    const isLive = m.status === 'live';
    const isFinished = m.status === 'finished';

    const sportInfoMap = {
      41: { name: 'BÓNG ĐÁ', icon: 'fa-futbol', slug: 'football' },
      43: { name: 'BÓNG CHUYỀN', icon: 'fa-volleyball', slug: 'bong-chuyen' },
      44: { name: 'BILLIARDS', icon: 'fa-circle-dot', slug: 'billiards' },
      45: { name: 'CẦU LÔNG', icon: 'fa-feather', slug: 'cau-long' },
      46: { name: 'ESPORTS', icon: 'fa-gamepad', slug: 'esports' },
      47: { name: 'BÓNG RỔ', icon: 'fa-basketball', slug: 'bong-ro' },
      48: { name: 'TENNIS', icon: 'fa-baseball-bat-ball', slug: 'tennis' },
      49: { name: 'BÓNG BÀN', icon: 'fa-table-tennis-paddle-ball', slug: 'bong-ban' },
      50: { name: 'BOXING', icon: 'fa-hand-fist', slug: 'boxing' }
    };

    const sportInfo = sportInfoMap[m.sport]
      || (m.sport_slug ? { name: (m.sport_name || m.sport_slug).toUpperCase(), icon: 'fa-futbol', slug: m.sport_slug } : null)
      || { name: 'BÓNG ĐÁ', icon: 'fa-futbol', slug: 'football' };

    const matchDate = m.start_time ? new Date(m.start_time) : new Date();
    const timeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD
    const dd = String(matchDate.getDate()).padStart(2, '0');
    const mm = String(matchDate.getMonth() + 1).padStart(2, '0');
    const yyyy = matchDate.getFullYear();

    const commentators = (m.commentators || []).map((c) => {
      const streamUrl = c.stream_url || c.backup_stream_url || c.flv_stream_url || '';
      return {
        id: c.id,
        name: c.name,
        avatar: this.getFullUrl(c.avatar_url),
        streamUrl,
        isLive: !!c.is_live,
        cdn: this.detectCdn(streamUrl)
      };
    }).filter((c) => c.streamUrl || c.name);

    const primaryStream = commentators.find((c) => c.streamUrl)?.streamUrl
      || m.primary_stream_url
      || m.backup_stream_url
      || '';

    const elapsed = String(m.match_time || '').trim();
    const slug = m.slug
      || `${slugifyVi(m.home_team_name)}-vs-${slugifyVi(m.away_team_name)}-ngay-${dd}-${mm}-${yyyy}`;

    return {
      matchId: `ph_${m.id}`,
      originalId: m.id,
      slug,
      source: 'phaohoa',
      sport: sportInfo.slug,
      sportName: sportInfo.name,
      sportIcon: sportInfo.icon,
      competition: {
        name: m.tournament_name || m.tournament_name_en || '',
        logo: this.getFullUrl(m.tournament_icon_url),
        icon: this.getFullUrl(m.tournament_icon_url)
      },
      homeTeam: {
        name: m.home_team_name || 'Home',
        logo: this.getFullUrl(m.home_team_logo)
      },
      awayTeam: {
        name: m.away_team_name || 'Away',
        logo: this.getFullUrl(m.away_team_logo)
      },
      score: {
        home: m.home_score ?? 0,
        away: m.away_score ?? 0
      },
      status: {
        isLive,
        isFinished,
        isHalfTime: /^HT$/i.test(elapsed),
        isUpcoming: !isLive && !isFinished,
        name: isLive
          ? (elapsed && !/^\d+$/.test(elapsed) ? elapsed : (elapsed ? 'Hiệp 1' : 'LIVE'))
          : (isFinished ? 'FT' : 'Sắp diễn ra'),
        text: isLive ? (elapsed || 'LIVE') : (isFinished ? 'Kết thúc' : 'Sắp diễn ra'),
        elapsedTime: isLive ? (elapsed && /^\d+$/.test(elapsed) ? `${elapsed}'` : elapsed) : '',
        minutes: elapsed
      },
      stats: {
        halfTimeScore: `${m.home_halftime_score ?? 0}-${m.away_halftime_score ?? 0}`,
        corners: '0-0',
        yellowCards: '0-0'
      },
      matchTime: matchDate.getTime(),
      matchTimeTimestamp: matchDate.getTime(),
      timeFormatted: `${timeStr} - ${dd}/${mm}`,
      dateStr,
      timeStr,
      isHot: !!m.is_hot,
      commentators,
      streamers: commentators,
      streamUrl: primaryStream,
      stream: {
        liveUrl: `${PHAOHOA_BASE_URL}/truc-tiep/${slug}/`,
        streamerName: commentators[0]?.name || null,
        streamerAvatar: commentators[0]?.avatar || null
      },
      odds: null
    };
  }

  mapStreams(match) {
    const list = [];
    const seen = new Set();

    for (const c of match?.commentators || []) {
      const url = c.streamUrl || '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const isFlv = /\.flv(\?|$)/i.test(url);
      const isM3u8 = /\.m3u8(\?|$)/i.test(url);
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
        format: isFlv ? 'flv' : (isM3u8 ? 'hls' : ''),
        cdn: c.cdn || this.detectCdn(url),
        quality: 'HD'
      });
    }

    if (!list.length && match?.streamUrl) {
      const isFlv = /\.flv(\?|$)/i.test(match.streamUrl);
      const isM3u8 = /\.m3u8(\?|$)/i.test(match.streamUrl);
      list.push({
        id: 'primary',
        streamerId: 'primary',
        name: 'Server 1',
        streamerName: 'Server 1',
        avatar: '',
        streamerAvatar: '',
        link: match.streamUrl,
        m3u8Url: match.streamUrl,
        playUrl: match.streamUrl,
        format: isFlv ? 'flv' : (isM3u8 ? 'hls' : ''),
        cdn: this.detectCdn(match.streamUrl),
        quality: 'HD'
      });
    }

    return list;
  }

  async fetchMatchesQuery(query = '') {
    const url = `/api/matches/?${query}${query.includes('_t=') ? '' : `${query ? '&' : ''}_t=${Date.now()}`}`;
    const response = await this.client.get(url);
    return response.data || {};
  }

  /**
   * Find raw upstream match by numeric id or slug (list APIs don't filter by id).
   */
  async findRawMatch(slugOrId, sportHint = 'football') {
    if (!slugOrId) return null;
    const key = decodeURIComponent(String(slugOrId)).replace(/\/+$/, '').trim();
    const cleanId = key.replace(/^ph_/, '');

    const sportMap = {
      football: 41,
      'bong-chuyen': 43,
      volleyball: 43,
      billiards: 44,
      'cau-long': 45,
      esports: 46,
      'bong-ro': 47,
      basketball: 47,
      tennis: 48,
      'bong-ban': 49,
      boxing: 50
    };
    const sportId = sportMap[sportHint] || null;

    const queries = [
      'ordering=smart&status=live&page_size=100',
      'ordering=smart&status=scheduled&page_size=50',
      'ordering=smart&is_hot=true&page_size=50',
      'ordering=smart&has_commentators=true&page_size=50'
    ];
    if (sportId) {
      queries.unshift(`ordering=smart&status=live&sport=${sportId}&page_size=100`);
      queries.push(`ordering=smart&sport=${sportId}&page_size=100`);
    }

    const settled = await Promise.allSettled(
      queries.map((q) => this.fetchMatchesQuery(q))
    );

    const seen = new Set();
    const all = [];
    for (const res of settled) {
      if (res.status !== 'fulfilled') continue;
      for (const m of res.value.results || []) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        all.push(m);
      }
    }

    return all.find((m) =>
      String(m.id) === cleanId
      || m.slug === key
      || m.slug === cleanId
    ) || null;
  }

  async getAllMatches(sport = 'football') {
    try {
      const sportId = sport === 'basketball' || sport === 'bong-ro' ? 47 : 41;
      const data = await this.fetchMatchesQuery(`sport=${sportId}&page_size=100`);
      return (data.results || []).map((m) => this.normalizeMatch(m));
    } catch (error) {
      console.error('Error fetching PhaoHoa matches:', error.message);
      return [];
    }
  }

  async getMatchesByTab(tab, sport = 'football', page = 1, pageSize = 18) {
    try {
      const sportMap = {
        all: null,
        football: 41,
        'bong-chuyen': 43,
        billiards: 44,
        'cau-long': 45,
        'bong-ro': 47,
        esports: 46,
        tennis: 48,
        'bong-ban': 49,
        boxing: 50
      };

      let url = `ordering=smart&page=${page}&page_size=${pageSize}`;

      const targetSportId = sportMap[tab] !== undefined
        ? sportMap[tab]
        : (sportMap[sport] !== undefined
          ? sportMap[sport]
          : (sport === 'basketball' || sport === 'bong-ro' ? 47 : 41));

      if (targetSportId) url += `&sport=${targetSportId}`;

      if (tab === 'live') url += '&status=live';
      else if (tab === 'upcoming') url += '&status=scheduled';
      else if (tab === 'hot') url += '&is_hot=true';
      else if (tab === 'commentator' || tab === 'with-stream') url += '&has_commentators=true';

      const data = await this.fetchMatchesQuery(url);
      const matches = (data.results || []).map((m) => this.normalizeMatch(m));
      const hasMore = !!data.next;
      const totalCount = data.count || matches.length;

      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

      let filtered = matches;
      if (tab === 'today') filtered = matches.filter((m) => m.dateStr === todayStr);
      else if (tab === 'tomorrow') filtered = matches.filter((m) => m.dateStr === tomorrowStr);

      return { matches: filtered, hasMore, totalCount };
    } catch (error) {
      console.error(`Error fetching PhaoHoa tab ${tab} page ${page}:`, error.message);
      return { matches: [], hasMore: false, totalCount: 0 };
    }
  }

  /** Fetch every page for a tab (used by /live aggregator). */
  async getAllMatchesByTab(tab, sport = 'all', pageSize = 50) {
    const all = [];
    const seen = new Set();
    let page = 1;
    const maxPages = 30;

    while (page <= maxPages) {
      const { matches, hasMore, totalCount } = await this.getMatchesByTab(
        tab,
        sport,
        page,
        pageSize
      );

      for (const m of matches || []) {
        const key = m.matchId || m.originalId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(m);
      }

      if (!hasMore || !(matches || []).length) {
        return { matches: all, hasMore: false, totalCount: totalCount || all.length };
      }
      page += 1;
    }

    return { matches: all, hasMore: false, totalCount: all.length };
  }

  async getCounts(sport = 'football') {
    try {
      const sportId = sport === 'basketball' || sport === 'bong-ro' ? 47 : 41;
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const tomorrowStr = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

      const [liveRes, scheduledRes, hotRes, allRes] = await Promise.allSettled([
        this.fetchMatchesQuery(`sport=${sportId}&status=live`),
        this.fetchMatchesQuery(`sport=${sportId}&status=scheduled`),
        this.fetchMatchesQuery(`sport=${sportId}&is_hot=true`),
        this.fetchMatchesQuery(`sport=${sportId}&page_size=100`)
      ]);

      const liveCount = liveRes.status === 'fulfilled' ? (liveRes.value.count || 0) : 0;
      const upcomingCount = scheduledRes.status === 'fulfilled' ? (scheduledRes.value.count || 0) : 0;
      const hotCount = hotRes.status === 'fulfilled' ? (hotRes.value.count || 0) : 0;

      const allMatches = allRes.status === 'fulfilled' ? (allRes.value.results || []) : [];
      const normalized = allMatches.map((m) => this.normalizeMatch(m));

      const todayCount = normalized.filter((m) => m.dateStr === todayStr).length || allMatches.length;
      const tomorrowCount = normalized.filter((m) => m.dateStr === tomorrowStr).length;
      const commentatorCount = normalized.filter((m) => m.commentators.length > 0).length;

      return {
        live: liveCount,
        upcoming: upcomingCount,
        hot: hotCount,
        commentator: commentatorCount,
        today: todayCount,
        tomorrow: tomorrowCount,
        tomorrow_date: tomorrowStr
      };
    } catch (error) {
      console.error('Error fetching PhaoHoa counts:', error.message);
      return { live: 0, upcoming: 0, hot: 0, commentator: 0, today: 0, tomorrow: 0 };
    }
  }

  async getStreamLinks(matchId, sport = 'football') {
    try {
      const raw = await this.findRawMatch(matchId, sport);
      if (!raw) return [];
      return this.mapStreams(this.normalizeMatch(raw));
    } catch (error) {
      console.error('Error fetching PhaoHoa stream links:', error.message);
      return [];
    }
  }

  async getMatchDetail(slugOrId, sport = 'football') {
    const raw = await this.findRawMatch(slugOrId, sport);
    if (!raw) return null;
    const match = this.normalizeMatch(raw);
    if (!match.slug) match.slug = buildMatchSlug(match) || match.matchId;
    const streams = this.mapStreams(match);
    return { match, streams, matchId: match.matchId };
  }

  async getMatchLiveSnapshot(slugOrId, sport = 'football') {
    const raw = await this.findRawMatch(slugOrId, sport);
    return raw ? this.normalizeMatch(raw) : null;
  }
}

const phaohoaService = new PhaoHoaService();
export default phaohoaService;
