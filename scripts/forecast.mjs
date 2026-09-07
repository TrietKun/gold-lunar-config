// Sinh nhận định giá vàng mỗi ngày: lấy giá công khai, tính tín hiệu bằng thống kê
// (cùng công thức với app), rồi nhờ mô hình ngôn ngữ viết 2-3 câu tiếng Việt.
// Chạy trên GitHub Actions. API key nằm trong Secrets, không bao giờ vào app.
import { writeFileSync, mkdirSync } from 'node:fs';

const TAEL_IN_TROY_OUNCE = 1.20565;
const DISCLAIMER = 'Nhận định chỉ mang tính tham khảo, không phải lời khuyên đầu tư.';

const UA = 'Mozilla/5.0 (Linux; Android 14) GoldLunar/1.0';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function vnNow() {
  const utc = new Date();
  return new Date(utc.getTime() + 7 * 3600 * 1000);
}

function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const tail = (xs, n) => (xs.length <= n ? xs : xs.slice(xs.length - n));
const dir = (pct, threshold) => (pct > threshold ? 1 : pct < -threshold ? -1 : 0);

async function yahooCloses(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
  const data = await getJson(url);
  const result = data.chart.result[0];
  return result.indicators.quote[0].close.filter((v) => v !== null);
}

/** Giá SJC (đồng/lượng) 30 ngày gần nhất từ lịch sử PNJ. */
async function domesticSeries(today) {
  const out = [];
  for (let i = 30; i >= 1; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const url = `https://edge-api.pnj.io/ecom-frontend/v1/get-gold-price-history?zone=00&date=${dateKey(d)}`;
    try {
      const data = await getJson(url);
      let best = null;
      for (const loc of data.locations ?? []) {
        for (const type of loc.gold_type ?? []) {
          for (const row of type.data ?? []) {
            if (!best || row.updated_at > best.updated_at) best = row;
          }
        }
        if (best) break;
      }
      if (best) out.push(Math.round(parseFloat(best.gia_ban) * 1_000_000));
    } catch (e) {
      console.warn(`bỏ qua ngày ${dateKey(d)}: ${e.message}`);
    }
  }
  return out;
}

/** Giá SJC hôm nay từ BTMC (đồng/chỉ -> đồng/lượng). */
async function btmcSjcToday() {
  const data = await getJson(
    'https://btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v',
  );
  let latest = null;
  for (const r of data.DataList?.Data ?? []) {
    const i = r['@row'];
    const name = r[`@n_${i}`] ?? '';
    if (!name.toUpperCase().includes('SJC')) continue;
    const at = r[`@d_${i}`] ?? '';
    if (!latest || at > latest.at) {
      latest = { at, buy: Number(r[`@pb_${i}`]) * 10, sell: Number(r[`@ps_${i}`]) * 10 };
    }
  }
  return latest;
}

function computeSignals({ domestic, gold, fx }) {
  const signals = [];
  const gMa7 = mean(tail(gold, 7));
  const gMa30 = mean(tail(gold, 30));
  const worldTrendPct = ((gMa7 - gMa30) / gMa30) * 100;
  signals.push({ kind: 'worldTrend', direction: dir(worldTrendPct, 0.5), weight: 0.35, detail: worldTrendPct.toFixed(2) });

  const g3 = tail(gold, 4);
  const momentumPct = g3.length >= 2 ? ((g3.at(-1) - g3[0]) / g3[0]) * 100 : 0;
  signals.push({ kind: 'worldMomentum', direction: dir(momentumPct, 0.3), weight: 0.2, detail: momentumPct.toFixed(2) });

  if (fx.length >= 7) {
    const fPct = ((mean(tail(fx, 7)) - mean(tail(fx, 30))) / mean(tail(fx, 30))) * 100;
    signals.push({ kind: 'fxTrend', direction: dir(fPct, 0.2), weight: 0.15, detail: fPct.toFixed(2) });
  }

  const domPct = ((domestic.at(-1) - domestic.at(-2)) / domestic.at(-2)) * 100;
  signals.push({ kind: 'domesticChange', direction: dir(domPct, 0.3), weight: 0.15, detail: domPct.toFixed(2) });

  if (fx.length) {
    const n = Math.min(gold.length, fx.length, domestic.length);
    const premiums = [];
    for (let i = 1; i <= n; i++) {
      const converted = gold.at(-i) * fx.at(-i) * TAEL_IN_TROY_OUNCE;
      premiums.push(((domestic.at(-i) - converted) / converted) * 100);
    }
    const diff = premiums[0] - mean(premiums);
    signals.push({
      kind: 'premium',
      direction: diff > 2 ? -1 : diff < -2 ? 1 : 0,
      weight: 0.15,
      detail: premiums[0].toFixed(1),
    });
  }
  return signals;
}

function summarize(signals) {
  const score = signals.reduce((s, x) => s + x.direction * x.weight, 0);
  const trend = score > 0.3 ? 'up' : score < -0.3 ? 'down' : 'flat';
  const confidence = Math.min(85, Math.max(50, Math.round(50 + Math.abs(score) * 50)));
  return { score, trend, confidence };
}

const TREND_LABEL = { up: 'tăng', down: 'giảm', flat: 'đi ngang' };
const SIGNAL_LABEL = {
  worldTrend: 'xu hướng vàng thế giới (trung bình 7 ngày so với 30 ngày)',
  worldMomentum: 'đà 3 phiên gần nhất của vàng thế giới',
  fxTrend: 'xu hướng tỷ giá USD/VND',
  domesticChange: 'thay đổi giá SJC trong nước so với hôm qua',
  premium: 'chênh lệch giá trong nước so với giá thế giới quy đổi',
};

function buildPrompt({ trend, confidence, signals, sjc }) {
  const lines = signals
    .map((s) => `- ${SIGNAL_LABEL[s.kind]}: ${s.detail}%, hướng ${s.direction > 0 ? 'tăng' : s.direction < 0 ? 'giảm' : 'trung tính'}`)
    .join('\n');
  return `Bạn viết bản tin ngắn về giá vàng cho người Việt đọc trên điện thoại.

Số liệu hôm nay:
- Vàng miếng SJC: mua ${sjc.buy.toLocaleString('vi-VN')} đ/lượng, bán ${sjc.sell.toLocaleString('vi-VN')} đ/lượng.
- Kết luận đã tính sẵn: giá ngày mai nghiêng về ${TREND_LABEL[trend]}, độ tin cậy ${confidence}%.
- Các tín hiệu:
${lines}

Yêu cầu:
- Viết 2 đến 3 câu tiếng Việt, ngắn gọn, mỗi câu một ý.
- Giải thích vì sao nghiêng về ${TREND_LABEL[trend]}, dựa trên các tín hiệu ở trên.
- Không được kết luận khác với "${TREND_LABEL[trend]}".
- Không bịa thêm số liệu nào ngoài các số đã cho.
- Không khuyên mua hay bán. Không dùng dấu gạch ngang dài. Không dùng emoji.
- Chỉ trả về đoạn văn, không thêm tiêu đề hay dấu ngoặc kép.`;
}

// Bí danh "latest" đứng đầu để script không chết khi Google ngừng một phiên bản cụ thể.
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'];

async function askGemini(prompt, key) {
  const problems = [];
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text.trim()) throw new Error(`trả về rỗng (finishReason=${data.candidates?.[0]?.finishReason})`);
      const bad = validate(text);
      if (bad) throw new Error(`đầu ra không đạt: ${bad}`);
      return { text: text.trim(), model: 'Gemini Flash' };
    } catch (e) {
      problems.push(`${model}: ${e.message}`);
    }
  }
  throw new Error(problems.join(' | '));
}

// Groq thay model khá thường xuyên nên thử lần lượt vài cái.
const GROQ_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];

async function askGroq(prompt, key) {
  const problems = [];
  for (const model of GROQ_MODELS) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('trả về rỗng');
      const bad = validate(text);
      if (bad) throw new Error(`đầu ra không đạt: ${bad}`);
      return { text: text.trim(), model: 'Groq' };
    } catch (e) {
      problems.push(`${model}: ${e.message}`);
    }
  }
  throw new Error(problems.join(' | '));
}

/**
 * Chặn đầu ra hỏng trước khi ghi file. Từng gặp trường hợp mô hình tự đánh số
 * từng từ rồi bị cắt giữa câu, nên phải kiểm tra thay vì tin tưởng mù quáng.
 */
function validate(text) {
  const t = text.trim();
  if (t.length < 60) return 'quá ngắn';
  if (t.length > 700) return 'quá dài';
  if (/\(\s*\d+\s*\)/.test(t)) return 'có đánh số từ, mô hình đi lạc';
  if (/[(\[]\s*$/.test(t)) return 'bị cắt giữa chừng';
  if (!/[.!?]$/.test(t)) return 'không kết thúc bằng dấu câu';
  const sentences = t.split(/[.!?]+/).filter((x) => x.trim().length > 10);
  if (sentences.length < 2) return 'ít hơn 2 câu';
  if (sentences.length > 6) return 'nhiều hơn 6 câu';
  if (!/[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(t)) {
    return 'không phải tiếng Việt';
  }
  return null;
}

/** Bỏ ngoặc kép bao ngoài, gạch ngang dài, và bảo đảm có dòng miễn trừ trách nhiệm. */
function clean(text) {
  let out = text.replace(/^["'"']|["'"']$/g, '').replace(/[—–‑]/g, '-').trim();
  if (!out.includes('tham khảo')) out = `${out} ${DISCLAIMER}`;
  return out.replace(/\s+/g, ' ');
}

async function main() {
  const today = vnNow();
  const todayKey = dateKey(today);

  const [gold, fx, domestic, sjc] = await Promise.all([
    yahooCloses('GC=F'),
    yahooCloses('VND=X'),
    domesticSeries(today),
    btmcSjcToday(),
  ]);

  if (!sjc) throw new Error('Không lấy được giá SJC hôm nay từ BTMC');
  domestic.push(sjc.sell);

  if (gold.length < 7 || domestic.length < 7) {
    throw new Error(`Thiếu dữ liệu: gold=${gold.length}, domestic=${domestic.length}`);
  }

  const signals = computeSignals({ domestic, gold, fx });
  const { trend, confidence } = summarize(signals);
  const prompt = buildPrompt({ trend, confidence, signals, sjc });

  if (process.env.DRY_RUN) {
    // Kiểm tra phần lấy dữ liệu và tính tín hiệu mà không cần API key.
    console.log(JSON.stringify({ date: todayKey, trend, confidence, sjc, signals }, null, 2));
    console.log('\n--- prompt gửi cho mô hình ---\n' + prompt);
    return;
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  let written = null;
  const problems = [];

  for (const [name, run] of [
    ['Gemini', geminiKey ? () => askGemini(prompt, geminiKey) : null],
    ['Groq', groqKey ? () => askGroq(prompt, groqKey) : null],
  ]) {
    if (!run) {
      problems.push(`${name}: thiếu API key`);
      continue;
    }
    try {
      written = await run();
      break;
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }

  if (!written) throw new Error(`Mọi mô hình đều lỗi. ${problems.join(' | ')}`);

  const payload = {
    date: todayKey,
    trend,
    confidence,
    narrative: clean(written.text),
    model: written.model,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync('forecast', { recursive: true });
  writeFileSync('forecast/v1.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload, null, 2));
  if (problems.length) console.warn(`Cảnh báo: ${problems.join(' | ')}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
