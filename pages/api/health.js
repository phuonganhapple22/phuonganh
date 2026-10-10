export default function handler(req, res) {
  return res.status(200).json({
    status: 'UP',
    timestamp: new Date(),
    service: 'crawl-bong-get-player'
  });
}
