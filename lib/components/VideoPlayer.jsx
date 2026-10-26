import { useEffect, useRef, useState } from 'react';
import { buildProxyStreamUrl } from '@/src/utils/proxyUrl';

/**
 * FIX "hls.js error: networkError manifestLoadError fatal=true" / CORS bị
 * chặn khi phát (28/08/2026, xem lỗi.txt): trước đây component này đưa
 * THẲNG link .m3u8 gốc của CDN nguồn (ví dụ luong.phaohoa.live) cho hls.js
 * gọi trực tiếp từ trình duyệt — CDN đó không gắn header
 * "Access-Control-Allow-Origin" nên trình duyệt tự chặn (CORS), khiến
 * manifest không tải được ngay từ đầu -> lỗi fatal, màn hình đen.
 * Sửa: mọi link đưa cho <video>/hls.js/flv.js đều đi qua
 * buildProxyStreamUrl() để bọc qua route /api/proxy/hls chạy trên server —
 * server gọi HTTP thì không bị CORS chi phối, còn trình duyệt lúc này chỉ
 * gọi về same-origin (domain của chính app) nên hết bị chặn. `url` GỐC
 * (chưa bọc proxy) vẫn được giữ nguyên ở nơi khác (pages/watch.jsx) để hiện
 * cho người dùng copy sang VLC/app IPTV ngoài trình duyệt — nơi đó không bị
 * CORS chi phối nên cứ dùng link gốc là phát bình thường, không cần proxy.
 *
 * FIX "nhiều trận flv/hls không xem được": trước đây nút ▶
 * trỏ THẲNG vào link .m3u8/.flv thô (playUrl) và mở bằng target="_blank" —
 * đó là link DỮ LIỆU STREAM, không phải trang xem, nên trình duyệt chỉ tải
 * xuống hoặc hiện trang trắng chứ không phát được (trình duyệt không tự
 * giải mã HLS trừ Safari, và KHÔNG trình duyệt nào tự phát được FLV).
 * Component này dùng hls.js để phát .m3u8 và flv.js để phát .flv ngay
 * trong thẻ <video>, đúng cách 1 trang xem trực tiếp cần làm.
 *
 * FIX "màn hình đen, không nút bấm, không lỗi gì cả" (26/08/2026): trước
 * đây CHỈ hiện lỗi khi hls.js báo data.fatal === true — lỗi KHÔNG-fatal và
 * lỗi từ video.play() (bị trình duyệt chặn autoplay) đều bị NUỐT ÂM THẦM.
 * Thêm log đầy đủ + nút "▶ Bấm để phát" thủ công sau 8 giây treo.
 *
 * FIX "nút bấm bị ẩn" (27/08/2026, lần 1): video THỰC RA đã tải xong, chỉ
 * bị chặn autoplay nên dừng ở trạng thái tạm dừng — nút ▶ MẶC ĐỊNH của
 * trình duyệt quá nhỏ, dễ tưởng là "ẩn". Cho hiện NGAY nút to giữa màn
 * hình khi video.play() bị từ chối, không cần đợi 8 giây.
 *
 * FIX "pháo hoa: bấm nút ▶ thì nút BIẾN MẤT" (27/08/2026, lần 2): bug ở
 * `manualStartKey` — bấm nút vừa gọi play() vừa tăng key để "buộc" effect
 * chạy lại, khiến TOÀN BỘ player bị HỦY và TẠO LẠI TỪ ĐẦU ngay sau khi vừa
 * play() thành công. Đã bỏ hẳn manualStartKey, nút giờ chỉ gọi play() trên
 * player đang có sẵn, không rebuild.
 *
 * FIX "vẫn bị y hệt, nút play vẫn ẩn" (27/08/2026, lần 3 — NGUYÊN NHÂN GỐC
 * THỰC SỰ): sự kiện 'playing' trước giờ chỉ được lắng nghe ĐÚNG MỘT LẦN
 * (`{ once: true }`), và cờ `startedPlaying` một khi đã true thì KHÔNG BAO
 * GIỜ được đặt lại false. Hệ quả: video phát được một đoạn đầu (nút ẩn đi,
 * đúng như mong đợi) — nhưng nguồn pháo hoa/live free rất hay bị đứt giữa
 * chừng (mất kết nối CDN, token hết hạn, buffer treo...). Khi đó video tự
 * dừng lại, nhưng vì `startedPlaying` đã là true nên KHÔNG có bất kỳ đoạn
 * code nào set `stuck = true` lại được nữa — nút biến mất vĩnh viễn, màn
 * hình đen treo, không cách nào bấm lại. Đây chính là gốc rễ khiến các bản
 * fix trước (chỉ sửa lần bấm nút đầu tiên) không giải quyết được vấn đề.
 *
 * Sửa triệt để: bỏ hẳn cờ `startedPlaying` một-lần, chuyển sang theo dõi
 * LIÊN TỤC trạng thái phát của thẻ <video> trong suốt vòng đời component:
 *   - 'playing'  -> video CÓ dữ liệu và đang chạy thật -> ẩn nút
 *   - 'pause' / 'waiting' / 'stalled' / 'error' (video, không phải hls.js/
 *     flv.js) -> đặt lại đồng hồ đếm 8 giây; nếu sau 8 giây vẫn chưa quay
 *     lại trạng thái 'playing' thì hiện nút ▶ lại — bất kể trước đó đã
 *     từng phát qua hay chưa, và bất kể là do chặn autoplay, mất mạng, hay
 *     nguồn tự ngắt giữa chừng.
 * Nhờ vậy nút ▶ sẽ hiện lại BẤT CỨ LÚC NÀO stream bị gián đoạn quá 8 giây,
 * không chỉ ở lần đầu tiên.
 *
 * FIX "play() bị từ chối: Failed to load because no supported source was
 * found" (28/08/2026 — NGUYÊN NHÂN GỐC THẬT SỰ, xác nhận qua log Console):
 * đây KHÔNG PHẢI lỗi trình duyệt chặn autoplay như dòng cảnh báo (bị gắn
 * nhầm nhãn) — đây là MediaError thật, nghĩa là tại thời điểm gọi
 * video.play(), thẻ <video> CHƯA CÓ nguồn phát nào cả. Lý do: code cũ gọi
 * video.play() NGAY SAU hls.attachMedia(video)/flvPlayer.attachMediaElement
 * (video) — nhưng attachMedia chạy BẤT ĐỒNG BỘ, phải đợi hls.js bắn sự kiện
 * MANIFEST_PARSED (đã tải + phân tích xong danh sách segment) thì thẻ
 * <video> mới thật sự có dữ liệu để phát. Gọi play() sớm hơn mốc đó thì
 * đúng là "chưa có nguồn nào" theo góc nhìn của trình duyệt → lỗi trên. Tài
 * liệu chính thức của hls.js cũng khuyến cáo CHỈ gọi play() sau
 * MANIFEST_PARSED, không phải ngay sau attachMedia().
 * Sửa: chỉ gọi play() sau khi thẻ <video> bắn 'loadedmetadata' (áp dụng
 * chung cho cả 3 nhánh flv/native-HLS/hls.js — không phụ thuộc riêng vào
 * sự kiện nội bộ của từng thư viện).
 *
 * FIX "nguồn Chuối Chiên: 403 (Forbidden) mọi trận, kể cả sau khi
 * /api/proxy/hls đã thử nhiều Referer/Origin khác nhau" (17/09/2026 —
 * xem chú thích "FIX 3" trong pages/api/proxy/hls.js để rõ toàn bộ quá
 * trình chẩn đoán): dữ liệu debug lấy trực tiếp từ CDN xác nhận request
 * bị chặn GIỐNG HỆT nhau (403, không header phân biệt, không body) bất kể
 * gửi Referer nào hay không gửi — tức đây RẤT có thể là chặn theo
 * IP/mạng của server (Vercel) hoặc theo kiểu kết nối (dấu vân tay TLS của
 * Node khác hẳn trình duyệt thật), không phải chặn theo Referer như 2 lần
 * sửa trước từng đoán — nghĩa là ĐỔI HEADER TỪ PHÍA SERVER PROXY KHÔNG THỂ
 * CỨU ĐƯỢC, vì chặn xảy ra trước khi request tới được code app.
 * Hướng còn lại CÓ THỂ thử ở phía TRÌNH DUYỆT (nơi request tới từ 1 kết nối
 * mạng dân dụng thật + TLS/JA3 của trình duyệt thật — khác hẳn Node) là:
 * để hls.js thử gọi TRỰC TIẾP link gốc CDN (bỏ qua proxy) TRƯỚC, chỉ
 * fallback về link qua proxy (`/api/proxy/hls`) nếu bản trực tiếp thất bại
 * vì lỗi mạng (đa số là do CDN không gắn CORS — network/manifestLoadError —
 * chứ không phải do trình duyệt "không biết phát"). CHƯA CHẮC hết bị chặn
 * (nếu CDN chặn theo IP/ASN của người xem chứ không phải của Vercel thì
 * vẫn dính y hệt), nhưng vì nguyên nhân thật sự nằm ngoài tầm với của code
 * app (hạ tầng mạng của CDN nguồn), đây là hướng duy nhất còn lại đáng thử
 * bằng code trước khi phải đổi sang giải pháp hạ tầng (đổi nhà cung cấp
 * server / dùng proxy dân dụng trả phí...). Chỉ áp dụng thử-trực-tiếp-
 * trước cho các `source` nằm trong DIRECT_FIRST_SOURCES bên dưới — các
 * nguồn khác (phaohoa...) ĐÃ XÁC NHẬN cần proxy vì lỗi CORS thật sự (xem
 * FIX 28/08/2026 phía trên), không đổi hành vi của các nguồn đó.
 */
const STUCK_TIMEOUT_MS = 8000;

// Các nguồn nên thử gọi TRỰC TIẾP (không qua /api/proxy/hls) trước tiên —
// xem chú thích FIX 17/09/2026 ở trên. Chỉ thêm 1 source vào đây khi có
// bằng chứng cụ thể (như debug 403 của Chuối Chiên) cho thấy proxy hiện
// tại không cứu được nguồn đó; KHÔNG thêm tùy tiện vì sẽ làm sống lại lỗi
// CORS gốc (28/08/2026) cho các nguồn vốn đang chạy tốt qua proxy.
const DIRECT_FIRST_SOURCES = ['chuoichientv'];

export default function VideoPlayer({ url, format, source }) {
  const videoRef = useRef(null);
  const playerRef = useRef(null); // { play: () => Promise } — điều khiển player đang hoạt động (video hoặc flvPlayer)
  const [error, setError] = useState('');
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!url) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;

    let hls;
    let flvPlayer;
    let cancelled = false;
    let watchdogTimer = null;
    setError('');
    setStuck(false);

    const clearWatchdog = () => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    // Đặt lại đồng hồ đếm 8 giây mỗi khi video dừng/đứng hình vì bất kỳ lý
    // do gì. Nếu trong 8 giây đó video không tự phục hồi (không có sự kiện
    // 'playing' nào xảy ra để hủy đồng hồ này), hiện nút ▶ để người xem
    // bấm lại thủ công.
    const scheduleWatchdog = () => {
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        if (!cancelled) setStuck(true);
      }, STUCK_TIMEOUT_MS);
    };

    const handlePlaying = () => {
      if (cancelled) return;
      setStuck(false);
      clearWatchdog();
    };
    const handleStall = () => {
      if (cancelled) return;
      scheduleWatchdog();
    };
    // FIX 28/08/2026: sự kiện 'error' gốc của <video> (khác với lỗi riêng
    // của hls.js/flv.js) trước đây bị nuốt âm thầm, không log gì — khiến
    // không tài nào biết vì sao video treo đen. Log rõ mã lỗi MediaError
    // (1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED) để dễ chẩn đoán.
    const handleVideoError = () => {
      if (cancelled) return;
      console.error('[VideoPlayer] <video> error:', video.error?.code, video.error?.message);
      scheduleWatchdog();
    };

    // Theo dõi LIÊN TỤC trong suốt vòng đời player (không phải { once: true })
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('pause', handleStall);
    video.addEventListener('waiting', handleStall);
    video.addEventListener('stalled', handleStall);
    video.addEventListener('error', handleVideoError);

    scheduleWatchdog(); // đếm ngay từ lúc mount / mỗi khi đổi nguồn (url/format)

    // Gọi CHUNG cho cả 3 nhánh phát (flv.js/native HLS/hls.js) — nếu
    // video.play() bị trình duyệt TỪ CHỐI (autoplay policy hoặc MediaError
    // khác), hiện NGAY nút "▶ Bấm để phát" to giữa màn hình thay vì đợi
    // watchdog 8 giây.
    const tryAutoplay = (playFn) => {
      const result = playFn();
      if (result?.catch) {
        result.catch((err) => {
          console.warn('[VideoPlayer] play() bị từ chối:', err?.name, err?.message);
          if (!cancelled) setStuck(true);
        });
      }
    };

    // CHỈ gọi play() sau khi thẻ <video> thật sự có dữ liệu ('loadedmetadata')
    // — xem chú thích FIX "Failed to load because no supported source was
    // found" ở đầu file. Dùng chung cho cả 3 nhánh thay vì gọi play() ngay
    // sau attachMedia/attachMediaElement/gán src.
    const playWhenReady = () => {
      if (cancelled) return;
      if (video.readyState >= 1) {
        // readyState >= HAVE_METADATA: đã có dữ liệu ngay lúc này rồi.
        tryAutoplay(() => video.play());
      } else {
        video.addEventListener(
          'loadedmetadata',
          () => {
            if (!cancelled) tryAutoplay(() => video.play());
          },
          { once: true }
        );
      }
    };

    async function setup() {
      const isFlv = format === 'flv' || /\.flv(\?|$)/i.test(url);
      // Nhận diện định dạng dựa trên URL GỐC (url) như cũ — chỉ đổi sang
      // link đã bọc proxy tại đúng điểm đưa cho player thực sự phát
      // (playbackUrl), tránh làm sai logic nhận diện .flv/.m3u8 ở trên.
      const proxiedUrl = buildProxyStreamUrl(url, source);
      // Danh sách link thử theo THỨ TỰ ƯU TIÊN cho nhánh hls.js — xem chú
      // thích FIX 17/09/2026 ở đầu file. Với nguồn KHÔNG nằm trong
      // DIRECT_FIRST_SOURCES, hành vi giữ NGUYÊN như cũ (chỉ 1 phần tử,
      // luôn qua proxy) — không ảnh hưởng các nguồn đang chạy ổn định.
      const hlsUrlCandidates =
        DIRECT_FIRST_SOURCES.includes(source) && url !== proxiedUrl ? [url, proxiedUrl] : [proxiedUrl];

      if (isFlv) {
        const mod = await import('flv.js');
        const flvjs = mod.default || mod;
        if (cancelled) return;
        if (!flvjs.isSupported()) {
          setError('Trình duyệt này không hỗ trợ phát FLV — thử Chrome/Edge trên máy tính, hoặc dùng link trong VLC.');
          return;
        }
        flvPlayer = flvjs.createPlayer({ type: 'flv', url: proxiedUrl, isLive: true, hasAudio: true, hasVideo: true });
        flvPlayer.attachMediaElement(video);
        flvPlayer.load();
        flvPlayer.on(flvjs.Events.ERROR, (errType, errDetail) => {
          console.error('[VideoPlayer] flv.js error:', errType, errDetail);
          if (!cancelled) {
            // Lỗi từ flv.js (mất kết nối, nguồn die...) — không hiện error
            // chặn cứng ngay, cho watchdog cơ hội hiện lại nút ▶ trước
            // (nhiều nguồn tự nối lại được sau vài giây).
            scheduleWatchdog();
          }
        });
        playerRef.current = { play: () => video.play() };
        playWhenReady();
        return;
      }

      // FIX 28/08/2026 (xác nhận qua Network tab: request .m3u8 có type
      // "media" — nghĩa là <video> tự lấy thẳng link, KHÔNG qua hls.js —
      // và bị (failed)): trước đây code kiểm tra
      // video.canPlayType('application/vnd.apple.mpegurl') TRƯỚC TIÊN, chỉ
      // dùng hls.js nếu check đó falsy. Nhưng 1 số trình duyệt Chromium nội
      // địa (ví dụ Cốc Cốc trên Windows có cài codec pack) trả lời DƯƠNG
      // TÍNH GIẢ cho check này — tưởng phát native được (giống Safari) rồi
      // gán thẳng video.src = url — nhưng thực ra KHÔNG phát được (chỉ
      // Safari/WebKit thật mới có engine native HLS), nên request thất bại
      // ngay, và video.play() sau đó ném "Failed to load because no
      // supported source was found".
      // Sửa: đảo thứ tự — LUÔN ưu tiên hls.js (dùng MediaSource Extensions,
      // hoạt động nhất quán trên mọi trình duyệt Chromium) nếu
      // Hls.isSupported() === true. Chỉ dùng nhánh native (gán thẳng src)
      // làm phương án CUỐI CÙNG khi hls.js thật sự không chạy được trên
      // trình duyệt đó (chủ yếu chỉ còn Safari/iOS, nơi hls.js không hoạt
      // động vì thiếu MSE cho HLS nhưng có sẵn engine native).
      const mod = await import('hls.js');
      const Hls = mod.default || mod;
      if (cancelled) return;

      if (Hls.isSupported()) {
        let candidateIndex = 0;

        // FIX 17/09/2026: khi có nhiều link ứng viên (direct trước, proxy
        // sau — xem DIRECT_FIRST_SOURCES), thử TỪNG link một; nếu 1 link bị
        // lỗi mạng FATAL (loại networkError — đúng dạng lỗi CORS/403/kết
        // nối bị chặn đang gặp phải), HỦY hls instance hiện tại và tạo lại
        // với link kế tiếp thay vì báo lỗi ngay. Lỗi fatal loại KHÁC (vd
        // mediaError — hỏng dữ liệu, không liên quan tới việc link nào)
        // thì không có ích gì khi đổi link, báo lỗi như cũ.
        const startHls = (playbackUrl) => {
          hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hls.loadSource(playbackUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            // Log MỌI lỗi (kể cả không-fatal) — hls.js tự thử phục hồi lỗi
            // không-fatal nhưng không phải lúc nào cũng thành công.
            console.error(
              '[VideoPlayer] hls.js error:',
              data?.type,
              data?.details,
              'fatal=',
              data?.fatal,
              '| link đang thử:',
              playbackUrl
            );
            if (!data?.fatal || cancelled) {
              if (!cancelled && !data?.fatal) scheduleWatchdog();
              return;
            }
            const canTryNext = data.type === Hls.ErrorTypes.NETWORK_ERROR && candidateIndex + 1 < hlsUrlCandidates.length;
            if (canTryNext) {
              candidateIndex += 1;
              console.warn('[VideoPlayer] Link hiện tại lỗi mạng fatal, thử link dự phòng:', hlsUrlCandidates[candidateIndex]);
              hls.destroy();
              startHls(hlsUrlCandidates[candidateIndex]);
              return;
            }
            setError('Nguồn này hiện không phát được — thử server khác hoặc bấm làm mới trận.');
          });
          playerRef.current = { play: () => video.play() };
          // hls.js khuyến cáo chính thức: gọi play() sau MANIFEST_PARSED,
          // không phải ngay sau attachMedia(). Vẫn giữ thêm playWhenReady()
          // làm lưới an toàn cho trường hợp MANIFEST_PARSED không bắn nhưng
          // <video> vẫn có dữ liệu qua đường khác.
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (!cancelled) tryAutoplay(() => video.play());
          });
        };

        startHls(hlsUrlCandidates[candidateIndex]);
        playWhenReady();
        return;
      }

      // hls.js không hỗ trợ được trình duyệt này (thiếu MediaSource
      // Extensions) — fallback native, chỉ thật sự hoạt động trên Safari.
      const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
      if (nativeHls) {
        video.src = proxiedUrl;
        playerRef.current = { play: () => video.play() };
        playWhenReady();
        return;
      }

      setError('Trình duyệt này không hỗ trợ phát HLS — thử trình duyệt khác, hoặc dùng link trong VLC.');
    }

    setup().catch((err) => {
      console.error('[VideoPlayer] setup() lỗi:', err);
      if (!cancelled) setError('Có lỗi khi khởi tạo trình phát — thử tải lại trang.');
    });

    return () => {
      cancelled = true;
      clearWatchdog();
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('pause', handleStall);
      video.removeEventListener('waiting', handleStall);
      video.removeEventListener('stalled', handleStall);
      video.removeEventListener('error', handleVideoError);
      playerRef.current = null;
      if (hls) hls.destroy();
      if (flvPlayer) {
        flvPlayer.pause();
        flvPlayer.unload();
        flvPlayer.detachMediaElement();
        flvPlayer.destroy();
      }
    };
    // Chỉ rebuild player khi URL/format thực sự đổi (đổi trận/đổi server) —
    // KHÔNG rebuild chỉ vì bấm nút "play thủ công" (xem nút ▶ bên dưới).
  }, [url, format, source]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      <video
        ref={videoRef}
        controls
        autoPlay
        playsInline
        className="h-full w-full"
      />
      {stuck && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center text-sm text-white">
          <p>Trình duyệt đang chặn tự động phát / luồng bị gián đoạn.</p>
          <button
            type="button"
            onClick={() => {
              const player = playerRef.current;
              if (!player) return;
              // Chỉ gọi play() trên player đang có sẵn — KHÔNG rebuild lại
              // player. 'playing' event sẽ tự ẩn nút khi thực sự phát được.
              player.play().catch((err) => {
                console.warn('[VideoPlayer] Bấm play thủ công vẫn bị trình duyệt từ chối:', err?.message);
              });
            }}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-2xl text-primary-foreground shadow-lg hover:opacity-90"
            aria-label="Bấm để phát"
          >
            ▶
          </button>
          <p className="text-xs text-white/70">Bấm nút ▶ ở trên để bắt đầu/tiếp tục xem</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 px-6 text-center text-sm text-white">
          {error}
        </div>
      )}
    </div>
  );
}
