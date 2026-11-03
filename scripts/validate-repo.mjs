// Kiểm tra nhanh repo (chạy trong workflow "CI Check", cũng chạy tay được):
//   npm install --no-save js-yaml@4.1.0 && node scripts/validate-repo.mjs
// Bắt các lỗi "im lặng" hay gặp khi sửa tay file trên GitHub: YAML workflow sai thụt lề / thiếu `on:`
// (workflow đó sẽ KHÔNG BAO GIỜ chạy mà không báo gì), cron sai định dạng, JSON cấu hình hỏng.
// Thoát mã 1 nếu có lỗi (run báo đỏ), 0 nếu ổn.
import fs from 'node:fs';
import path from 'node:path';

let yaml;
try {
  yaml = (await import('js-yaml')).default;
} catch {
  console.error('Thiếu thư viện js-yaml. Chạy: npm install --no-save js-yaml@4.1.0 rồi chạy lại.');
  process.exit(2);
}

let errors = 0;
const fail = (file, msg) => {
  errors += 1;
  console.log(`::error file=${file}::${msg}`);
};
const firstLine = (e) => String(e?.message || e).split('\n')[0];

// 1) Workflow YAML
const WF_DIR = '.github/workflows';
const workflows = fs.readdirSync(WF_DIR).filter((n) => /\.ya?ml$/i.test(n)).sort();
for (const name of workflows) {
  const file = path.posix.join(WF_DIR, name);
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object') throw new Error('file rỗng hoặc không phải YAML hợp lệ');
    const on = doc.on ?? doc[true]; // `on` có thể bị đọc thành khóa boolean tùy bộ đọc YAML
    if (!on) throw new Error('thiếu khối `on:` — workflow này sẽ không bao giờ chạy');
    if (!doc.jobs || typeof doc.jobs !== 'object' || !Object.keys(doc.jobs).length) {
      throw new Error('thiếu khối `jobs:`');
    }
    for (const [jobId, job] of Object.entries(doc.jobs)) {
      const ok = job && (job.uses || (job['runs-on'] && Array.isArray(job.steps) && job.steps.length));
      if (!ok) throw new Error(`job "${jobId}" thiếu runs-on/steps (hoặc uses)`);
    }
    const schedules = typeof on === 'object' && !Array.isArray(on) ? on.schedule : null;
    for (const s of Array.isArray(schedules) ? schedules : []) {
      const cron = String(s?.cron || '').trim();
      if (cron.split(/\s+/).length !== 5) throw new Error(`cron không hợp lệ (cần đúng 5 trường): '${cron}'`);
    }
    console.log(`OK   ${file}`);
  } catch (e) {
    fail(file, firstLine(e));
  }
}

// 2) File JSON cấu hình
for (const file of ['package.json', 'jsconfig.json', 'vercel.json', 'data/sources.json', 'data/sources.schema.json']) {
  if (!fs.existsSync(file)) continue;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`OK   ${file}`);
  } catch (e) {
    fail(file, `JSON hỏng: ${firstLine(e)}`);
  }
}

// 3) Công tắc auto-rerun: chỉ nên là on/off (giá trị lạ vẫn được coi là "on" nhưng dễ gây nhầm)
const flagFile = 'data/auto-rerun.txt';
if (fs.existsSync(flagFile)) {
  const flag = fs.readFileSync(flagFile, 'utf8').replace(/\s+/g, '').toLowerCase();
  if (flag && !['on', 'off'].includes(flag)) {
    fail(flagFile, `giá trị "${flag}" lạ — chỉ nên là "on" hoặc "off"`);
  } else {
    console.log(`OK   ${flagFile} (${flag || 'trống = on'})`);
  }
}

console.log(errors ? `\n${errors} lỗi.` : `\nTất cả hợp lệ (${workflows.length} workflow).`);
process.exit(errors ? 1 : 0);
