import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  SPORT_TABS,
  SOURCE_TOGGLE_LIST,
  loadEnabledSources,
  saveEnabledSources,
  isSourceEnabled,
  getSourceKey,
  getSourceLabel,
  getSourceShortLabel,
  formatMatchTime
} from '@/src/utils/playerGet';
import Link from 'next/link';
import { cn } from '@/lib/utils';

// Nút ▶ trước đây mở THẲNG link .m3u8/.flv thô bằng target="_blank" —
// browser không tự phát được (đặc biệt FLV, và HLS ngoài Safari), xem
// components/VideoPlayer.jsx để biết chi tiết. Giờ trỏ vào /watch, trang có
// player thật (hls.js/flv.js).
// FIX (17/09/2026 — "you do not have permission to access the requested
// resource" khi phát nguồn Chuối Chiên): route /api/proxy/hls trước đây gắn
// CỨNG Referer theo domain Pháo Hoa cho MỌI nguồn — CDN của nguồn khác
// (edgemaxcdn.org, hdplaylink.com...) kiểm tra Referer, nhận sai nên từ
// chối. Truyền thêm `source` để proxy biết chọn đúng Referer — xem
// pages/api/proxy/hls.js.
function buildWatchHref(match, stream) {
  const params = new URLSearchParams({
    url: stream.playUrl || '',
    format: stream.format || '',
    name: stream.name || '',
    source: match.source || ''
  });
  // Trận live Gà Vàng/Xôi Lạc chưa có link resolve sẵn (xem pages/api/
  // matches.js) — truyền URL resolver qua param riêng `resolve` thay vì
  // `url`, để /watch biết cần TỰ GỌI resolver trước rồi mới phát, không
  // đưa thẳng cho hls.js (xem chú thích chi tiết trong watch.jsx).
  if (stream.needsResolve && stream.resolveUrl) {
    params.set('resolve', stream.resolveUrl);
  }
  if (match.homeTeam?.name) params.set('home', match.homeTeam.name);
  if (match.awayTeam?.name) params.set('away', match.awayTeam.name);
  return `/watch?${params.toString()}`;
}

const VIEW_MODE_STORAGE_KEY = 'player-get:view-mode:v1';

function loadViewMode() {
  if (typeof window === 'undefined') return 'grid';
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function saveViewMode(mode) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage có thể bị chặn — bỏ qua, không critical.
  }
}

// 1 dòng link playlist (input readonly + nút Copy) — dùng chung cho cả
// link "Tất cả" lẫn từng link riêng theo nguồn bên dưới, tránh lặp code.
function PlaylistLinkRow({ label, path }) {
  const [url, setUrl] = useState(path);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Link tuyệt đối (vd raw.githubusercontent.com) dùng thẳng, không ghép
    // thêm domain của trang hiện tại vào trước.
    setUrl(path.startsWith('http') ? path : `${window.location.origin}${path}`);
  }, [path]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable (http, older browsers) — người dùng
      // vẫn có thể tự bôi đen ô input và Ctrl+C.
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <input
        type="text"
        readOnly
        value={url}
        onFocus={(e) => e.target.select()}
        className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
      />
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
      >
        {copied ? 'Đã copy ✓' : 'Copy'}
      </button>
    </div>
  );
}

// Link playlist tổng ("Tất cả") + danh sách link riêng từng nguồn (Pháo
// Hoa, Giờ Vàng), thu gọn sau 1 nút bấm để không chiếm chỗ
// mặc định — chỉ ai cần theo dõi riêng 1 nguồn mới cần mở ra.
function PlaylistLink() {
  const [showBySource, setShowBySource] = useState(false);
  const [showStatic, setShowStatic] = useState(false);
  // null = chưa tải xong /api/config -> tạm coi như chưa có (dùng link cục
  // bộ /playlists/... để không chớp nháy đổi link ngay khi trang vừa mở).
  const [staticBase, setStaticBase] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setStaticBase(data?.staticPlaylistBase || null);
      })
      .catch(() => {
        // Không lấy được cấu hình -> giữ nguyên, các link tĩnh bên dưới tự
        // rơi về đường dẫn cục bộ /playlists/... như trước đây.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // FIX (22/09/2026 — "all.m3u hiện ra dạng file text trên app IPTV"): link
  // KHÔNG còn trỏ thẳng ra raw.githubusercontent.com nữa (GitHub luôn trả
  // Content-Type: text/plain cho mọi file, khiến app hiểu nhầm là file text
  // — xem giải thích đầy đủ trong pages/api/static-playlist/[file].js).
  // Mọi link playlist tĩnh giờ luôn đi qua route proxy trên chính domain
  // của mình — route đó TỰ quyết định lấy nội dung từ GitHub (nếu đã khai
  // báo GITHUB_REPO) hay từ file cục bộ, rồi trả lại với Content-Type
  // playlist đúng chuẩn. `staticBase` (từ /api/config) giờ chỉ còn dùng để
  // hiển thị chú thích "lấy thẳng bản mới nhất trên GitHub" bên dưới, không
  // còn dùng để dựng URL nữa.
  const staticPath = (filename) => `/api/static-playlist/${filename}`;

  return (
    <div className="space-y-2">
      <PlaylistLinkRow label="Link playlist (dán vào VLC/app IPTV):" path="/playlist.m3u?refresh=1" />

      <button
        type="button"
        onClick={() => setShowBySource((v) => !v)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {showBySource ? '▾ Ẩn link playlist riêng từng nguồn' : '▸ Link playlist riêng từng nguồn'}
      </button>

      {showBySource && (
        <div className="space-y-2 border-l-2 border-border pl-3">
          {SOURCE_TOGGLE_LIST.map((s) => (
            <PlaylistLinkRow
              key={s.key}
              label={`${s.label}:`}
              path={`/playlist.m3u?source=${s.key}&refresh=1`}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowStatic((v) => !v)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {showStatic ? '▾ Ẩn link playlist tĩnh (cập nhật mỗi 2 phút)' : '▸ Link playlist tĩnh (cập nhật mỗi 2 phút)'}
      </button>

      {showStatic && (
        <div className="space-y-2 border-l-2 border-border pl-3">
          <p className="px-1 text-xs text-muted-foreground">
            Playlist tạo sẵn qua GitHub Actions{staticBase ? ' — lấy thẳng bản mới nhất trên GitHub' : ''}, nhẹ hơn
            link phía trên (không tự tổng hợp lại lúc mở), phù hợp dán vào app IPTV không cần dữ liệu tức thời.
          </p>
          {SPORT_TABS.map((sport) => (
            <PlaylistLinkRow key={sport.id} label={`${sport.label}:`} path={staticPath(`${sport.id}.m3u`)} />
          ))}
          {SOURCE_TOGGLE_LIST.map((s) => (
            <PlaylistLinkRow key={s.key} label={`${s.label}:`} path={staticPath(`source-${s.key}.m3u`)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Thời điểm GitHub Actions chạy làm mới kế tiếp
// (.github/workflows/validate-and-generate.yml, cron "*/2 * * * *" — chạy
// theo giờ UTC, tức mỗi khi phút UTC chạm mốc chia hết cho 2).
// FIX (22/09/2026): trước đây đây chỉ là lịch KIỂM TRA — script bên trong
// có thể tự giãn ra (tối đa 2 tiếng) và bỏ qua lần chạy khi không có trận
// live. Giờ script LUÔN làm mới thật ở đúng mỗi lần cron này, không còn
// giãn cách nữa, nên thời gian hiện ở đây chính là thời gian làm mới thật.
function nextCronRunUtc(intervalMinutes = 2) {
  const next = new Date();
  next.setUTCSeconds(0, 0);
  const utcMinutes = next.getUTCMinutes();
  const add = intervalMinutes - (utcMinutes % intervalMinutes);
  next.setUTCMinutes(utcMinutes + add);
  return next;
}

function AutoGenerateNote() {
  const [label, setLabel] = useState('');

  useEffect(() => {
    function update() {
      const next = nextCronRunUtc(2);
      const diffMin = Math.max(0, Math.ceil((next.getTime() - Date.now()) / 60000));
      setLabel(diffMin <= 1 ? '~1 phút nữa' : `~${diffMin} phút nữa`);
    }
    update();
    const timer = setInterval(update, 15000);
    return () => clearInterval(timer);
  }, []);

  return (
    <p className="px-1 text-xs text-muted-foreground">
      File playlist tĩnh (<code className="font-mono">public/playlists/</code>) được GitHub Actions làm mới đều đặn
      mỗi 2 phút, liên tục, không giãn cách kể cả khi ít/không có trận live — lần làm mới kế tiếp {label || '…'} (giờ
      UTC, có thể trễ vài phút do hàng đợi của GitHub).
    </p>
  );
}

function StatusBar({ generatedAt, count, onRefresh, refreshing }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-baseline gap-2.5">
        <span className="font-display text-3xl leading-none tracking-wide text-primary">
          {String(count).padStart(2, '0')}
        </span>
        <div className="leading-tight">
          <div className="text-sm font-medium text-foreground">trận đang phát</div>
          {generatedAt && (
            <div className="text-xs text-muted-foreground">
              cập nhật lúc {new Date(generatedAt).toLocaleTimeString('vi-VN')}
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent hover:border-primary/40 disabled:opacity-50 transition-colors"
      >
        <span className={cn('inline-block', refreshing && 'animate-spin')}>↻</span>
        {refreshing ? 'Đang làm mới…' : 'Làm mới'}
      </button>
    </div>
  );
}

function SourceToggles({ enabledSources, onToggle }) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-foreground">Bật/Tắt Nguồn</h3>
      <div className="flex flex-wrap gap-2">
        {SOURCE_TOGGLE_LIST.map((s) => {
          const on = enabledSources[s.key] !== false;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onToggle(s.key)}
              className={cn(
                'rounded-md border px-4 py-2.5 text-sm font-medium transition-all hover:shadow-md',
                on
                  ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                  : 'border-border bg-muted text-muted-foreground hover:bg-accent'
              )}
              aria-pressed={on}
            >
              {on ? '✓' : '○'} {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ViewModeToggle({ mode, onChange }) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {[
        { id: 'grid', label: '▦ Lưới' },
        { id: 'list', label: '☰ Danh sách' }
      ].map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={cn(
            'rounded px-2.5 py-1 text-xs transition-colors',
            mode === opt.id
              ? 'bg-primary text-primary-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent'
          )}
          aria-pressed={mode === opt.id}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const SOURCE_META = {
  giovang: { color: '#F5B301', icon: '🥇' },
  khandaitv: { color: '#4F8EF7', icon: '🏟️' },
  chuoichientv: { color: '#FFD23F', icon: '🍌' },
  phalang: { color: '#8E5CF7', icon: '⚡' },
  // FIX (20/09/2026): trước đây dùng SOURCE_META.phaohoa làm giá trị
  // dự phòng (fallback) mỗi khi gặp match.source lạ — Pháo Hoa đã bị loại
  // bỏ khỏi pipeline (domain chết) nên không còn hợp lý làm fallback nữa.
  // Thêm 1 mục "default" trung tính riêng cho việc này.
  default: { color: '#9CA3AF', icon: '📺' }
};

function TeamLogo({ name, logo, small = false }) {
  const [broken, setBroken] = useState(false);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const sizeClass = small ? 'h-6 w-6 text-xs' : 'h-10 w-10 text-sm';

  if (!logo || broken) {
    return (
      <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground', sizeClass)}>
        {initial}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={logo}
      alt={name || ''}
      onError={() => setBroken(true)}
      className={cn('shrink-0 rounded-full bg-muted object-contain', sizeClass)}
      loading="lazy"
    />
  );
}

function MatchCard({ match }) {
  const meta = SOURCE_META[match.source] || SOURCE_META.default;
  const isLive = !!match.status?.isLive;

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-lg border bg-card transition-shadow',
        isLive ? 'border-destructive/30 hover:shadow-live' : 'border-border hover:shadow-glow'
      )}
    >
      {/* Nhãn nguồn kiểu "bug" đài truyền hình — cắt góc chéo, màu riêng theo nguồn */}
      <div
        className="absolute left-0 top-0 flex items-center gap-1 rounded-br-lg px-2.5 py-1 text-[11px] font-semibold text-background"
        style={{ backgroundColor: meta.color }}
      >
        <span>{meta.icon}</span>
        {getSourceShortLabel(match.source)}
      </div>

      <div className="flex items-center justify-end px-3 pt-3 text-xs">
        {isLive ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/15 px-2 py-0.5 font-semibold text-destructive">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-destructive" />
            </span>
            LIVE · {formatMatchTime(match) || 'đang phát'}
          </span>
        ) : (
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            {formatMatchTime(match) || 'Sắp diễn ra'}
          </span>
        )}
      </div>

      {match.competition?.name && (
        <div className="truncate px-4 pt-2 text-center text-xs text-muted-foreground">{match.competition.name}</div>
      )}

      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
          <TeamLogo name={match.homeTeam?.name} logo={match.homeTeam?.logo} />
          <span className="line-clamp-2 text-xs font-medium leading-tight">{match.homeTeam?.name || 'Home'}</span>
        </div>
        <div className="shrink-0 px-1 font-display text-lg leading-none text-muted-foreground/70">
          VS
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
          <TeamLogo name={match.awayTeam?.name} logo={match.awayTeam?.logo} />
          <span className="line-clamp-2 text-xs font-medium leading-tight">{match.awayTeam?.name || 'Away'}</span>
        </div>
      </div>

      {!!match.streams?.length && (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
          {match.streams.map((s, i) => (
            <Link
              key={`${s.playUrl}-${i}`}
              href={buildWatchHref(match, s)}
              target="_blank"
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:border-primary/50 hover:bg-primary/10 hover:text-primary transition-colors"
            >
              ▶ {s.name}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function MatchListRow({ match }) {
  const meta = SOURCE_META[match.source] || SOURCE_META.default;
  const isLive = !!match.status?.isLive;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <div className="w-24 shrink-0 text-xs">
        {isLive ? (
          <span className="flex flex-col items-start gap-0.5">
            <span className="text-muted-foreground">{formatMatchTime(match) || 'Sắp diễn ra'}</span>
            <span className="inline-flex items-center gap-1 font-semibold text-destructive">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-destructive" />
              </span>
              LIVE
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">{formatMatchTime(match) || 'Sắp diễn ra'}</span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <TeamLogo name={match.homeTeam?.name} logo={match.homeTeam?.logo} small />
        <span className="truncate text-sm font-medium">{match.homeTeam?.name || 'Home'}</span>
        <span className="shrink-0 text-xs text-muted-foreground">vs</span>
        <span className="truncate text-sm font-medium">{match.awayTeam?.name || 'Away'}</span>
        <TeamLogo name={match.awayTeam?.name} logo={match.awayTeam?.logo} small />
      </div>

      {match.competition?.name && (
        <span className="hidden max-w-[160px] shrink-0 truncate text-xs text-muted-foreground md:block">
          {match.competition.name}
        </span>
      )}

      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {meta.icon} {getSourceShortLabel(match.source)}
      </span>

      <div className="flex shrink-0 flex-wrap gap-1.5">
        {(match.streams || []).map((s, i) => (
          <Link
            key={`${s.playUrl}-${i}`}
            href={buildWatchHref(match, s)}
            target="_blank"
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
          >
            ▶ {s.name}
          </Link>
        ))}
      </div>
    </div>
  );
}

function SourceGroupHeader({ source, count }) {
  const meta = SOURCE_META[source] || SOURCE_META.default;
  return (
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <span
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs"
        style={{ backgroundColor: `${meta.color}33` }}
      >
        {meta.icon}
      </span>
      <h2 className="text-sm font-semibold text-foreground">{getSourceLabel(source)}</h2>
      <span className="text-xs text-muted-foreground">({count} trận)</span>
    </div>
  );
}

export default function Home() {
  const [enabledSources, setEnabledSources] = useState(() => loadEnabledSources());
  const [viewMode, setViewMode] = useState(() => loadViewMode());
  const [activeSport, setActiveSport] = useState('all');
  const [matches, setMatches] = useState([]);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const fetchMatches = useCallback(async (opts = {}) => {
    const { refresh } = opts;
    refresh ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ sport: activeSport });
      if (refresh) qs.set('refresh', '1');
      const res = await fetch(`/api/matches?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.message || 'Không tải được danh sách trận');
      setMatches(json.matches || []);
      setGeneratedAt(json.generatedAt);
    } catch (err) {
      setError(err.message || 'Có lỗi xảy ra');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeSport]);

  useEffect(() => {
    fetchMatches();
    const timer = setInterval(() => fetchMatches(), 60000);
    return () => clearInterval(timer);
  }, [fetchMatches]);

  const toggleSource = (key) => {
    setEnabledSources((prev) => {
      const next = { ...prev, [key]: prev[key] === false ? true : false };
      saveEnabledSources(next);
      return next;
    });
  };

  const changeViewMode = (mode) => {
    setViewMode(mode);
    saveViewMode(mode);
  };

  const visibleMatches = useMemo(
    // /api/matches (qua playlistBuilder.service.js:sortPlayable) đã trả về
    // đúng thứ tự thời gian toàn cục — CHỈ lọc theo nguồn đang bật, KHÔNG
    // gom nhóm lại theo nguồn ở đây nữa, để không phá vỡ thứ tự ngày/giờ
    // chung của cả trang (gom theo nguồn từng khiến trận ở khối nguồn A
    // hiện trước trận sớm hơn ở khối nguồn B, nhìn như bị lộn ngày).
    () => matches.filter((m) => isSourceEnabled(m, enabledSources)),
    [matches, enabledSources]
  );
  const visibleCount = visibleMatches.length;

  // FIX: người dùng muốn khi bật NHIỀU nguồn cùng lúc, mỗi nguồn hiển thị
  // thành 1 khối riêng — không muốn trận của các nguồn khác nhau xen kẽ
  // lẫn lộn theo thời gian như trước (xem comment ở visibleMatches). Gom
  // nhóm CHỈ ở bước hiển thị (giữ nguyên thứ tự thời gian trong từng
  // khối, vì visibleMatches đã sort theo giờ toàn cục — filter theo nguồn
  // không làm mất thứ tự đó); playlist .m3u (dùng cho VLC/IPTV) không đụng
  // tới, vẫn phẳng theo thời gian như cũ.
  const groupedMatches = useMemo(() => {
    const order = SOURCE_TOGGLE_LIST.map((s) => s.key);
    const groups = new Map();
    for (const m of visibleMatches) {
      const key = getSourceKey(m);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    return [...groups.entries()].sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    });
  }, [visibleMatches]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="h-1.5 bg-turf" />
        <div className="container py-6 space-y-4">
          <div>
            <h1 className="font-display text-4xl leading-none tracking-wide text-foreground">
              NGUỒN THỂ THAO <span className="text-primary">VIP</span>
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Danh sách trận trực tiếp tổng hợp từ nhiều nguồn — bật/tắt nguồn tuỳ ý.
            </p>
          </div>

          <PlaylistLink />
          <AutoGenerateNote />

          <StatusBar
            generatedAt={generatedAt}
            count={visibleCount}
            onRefresh={() => fetchMatches({ refresh: true })}
            refreshing={refreshing}
          />

          <SourceToggles enabledSources={enabledSources} onToggle={toggleSource} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {SPORT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveSport(tab.id)}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-sm transition-colors',
                    activeSport === tab.id
                      ? 'bg-primary text-primary-foreground font-semibold shadow-glow'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <ViewModeToggle mode={viewMode} onChange={changeViewMode} />
            </div>
          </div>
        </div>
      </header>

      <section className="container py-8 space-y-8">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
            Đang tải danh sách trận…
          </div>
        )}
        {!loading && error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Không tải được danh sách trận: {error}
          </div>
        )}
        {!loading && !error && visibleCount === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Không có trận nào đang phát — thử bật thêm nguồn ở trên, hoặc bấm &quot;Làm mới&quot;.
          </div>
        )}

        {viewMode === 'list' ? (
          <div className="space-y-6">
            {groupedMatches.map(([source, list]) => (
              <div key={source} className="space-y-2">
                <SourceGroupHeader source={source} count={list.length} />
                <div className="space-y-2">
                  {list.map((m) => (
                    <MatchListRow key={m.matchId} match={m} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-6">
            {groupedMatches.map(([source, list]) => (
              <div key={source} className="space-y-3">
                <SourceGroupHeader source={source} count={list.length} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((m) => (
                    <MatchCard key={m.matchId} match={m} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
