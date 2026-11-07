import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useEffect, useState } from 'react';

// hls.js/flv.js đụng tới window/MediaSource — chỉ được chạy phía client,
// tắt SSR cho component player để tránh lỗi build/render trên server.
const VideoPlayer = dynamic(() => import('@/components/VideoPlayer'), { ssr: false });

/**
 * FIX "Gà Vàng/Xôi Lạc: bấm 'Đang tải link...' không xem được trên web":
 * trước đây trang này đưa THẲNG URL /api/playlist/resolve cho hls.js coi
 * như đã là link .m3u8 thật — nhưng route đó cần thời gian dò link (retry,
 * xác minh...) có thể tới vài chục giây, trong khi hls.js có timeout tải
 * "manifest" mặc định chỉ ~10s nên luôn báo lỗi trước khi kịp có link.
 *
 * Giờ tách 2 bước: nếu link đến từ query `resolve` (xem buildWatchHref
 * trong pages/index.jsx), trang này TỰ fetch() route resolver trước (bằng
 * fetch() thường, không qua hls.js nên không bị giới hạn ~10s đó — có thể
 * đợi kiên nhẫn hơn nhiều), hiện trạng thái "đang dò link", rồi mới đưa
 * link THẬT (đã có sẵn, tải nhanh bình thường) cho VideoPlayer.
 */
function useResolvedStream(resolveUrl) {
  const [state, setState] = useState({ loading: !!resolveUrl, url: '', format: '', error: '' });

  useEffect(() => {
    if (!resolveUrl) return undefined;
    let cancelled = false;
    setState({ loading: true, url: '', format: '', error: '' });

    const sep = resolveUrl.includes('?') ? '&' : '?';
    fetch(`${resolveUrl}${sep}json=1`)
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !json?.success || !json?.playUrl) {
          setState({ loading: false, url: '', format: '', error: json?.message || 'Trận chưa phát — thử lại gần giờ bóng lăn.' });
          return;
        }
        setState({ loading: false, url: json.playUrl, format: json.format || '', error: '' });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, url: '', format: '', error: err.message || 'Lỗi kết nối, thử lại sau.' });
      });

    return () => {
      cancelled = true;
    };
  }, [resolveUrl]);

  return state;
}

export default function WatchPage() {
  const router = useRouter();
  const { url, format, name, home, away, resolve, source } = router.query;
  const directUrl = typeof url === 'string' ? url : '';
  const resolveUrl = typeof resolve === 'string' ? resolve : '';
  const streamSource = typeof source === 'string' ? source : '';

  const resolved = useResolvedStream(resolveUrl);
  const streamUrl = resolveUrl ? resolved.url : directUrl;
  const streamFormat = resolveUrl ? resolved.format : (typeof format === 'string' ? format : '');

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="h-1.5 bg-turf" />
        <div className="container flex items-center justify-between gap-3 py-4">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Về danh sách trận
          </Link>
          {(home || away) && (
            <div className="truncate text-sm font-medium">
              {home || 'Home'} <span className="text-muted-foreground">vs</span> {away || 'Away'}
            </div>
          )}
        </div>
      </header>

      <section className="container space-y-4 py-6">
        {resolveUrl && resolved.loading ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Đang dò link phát trực tiếp... (có thể mất vài chục giây, đừng tắt trang)
          </div>
        ) : resolveUrl && resolved.error ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {resolved.error}
          </div>
        ) : !streamUrl ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Thiếu link stream để phát — quay lại danh sách trận và bấm ▶ ở một server khác.
          </div>
        ) : (
          <>
            <VideoPlayer url={streamUrl} format={streamFormat} source={streamSource} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {name ? `Server: ${name} · ` : ''}Không xem được trên trình duyệt? Dán link này vào VLC/app IPTV:
              </span>
              <code className="max-w-full truncate rounded border border-border bg-card px-2 py-1 font-mono">
                {streamUrl}
              </code>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
