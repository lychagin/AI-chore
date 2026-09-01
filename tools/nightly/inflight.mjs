#!/usr/bin/env node
// Сколько вызовов к внешней системе одновременно «в полёте» (L3 = уровень транспорта).
// Проверяет версию «исчерпание одновременных стримов одного соединения»: если в момент
// зависания число in-flight упирается в потолок (у HTTP/2 типично 100), это и есть механизм.
//
//   node inflight.mjs <svc.log> [...]
//
// Вход — лог инструментации (формат описан в README и в hang-window.mjs).
// Порог «медленного» вызова: NIGHTLY_SLOW_SEC, по умолчанию 5 секунд.
import { readFileSync } from 'node:fs';

const SLOW_SEC = Number(process.env.NIGHTLY_SLOW_SEC || 5);

const secOf = (l) => {
  const t = l.slice(11, 23);
  return +t.slice(0, 2) * 3600 + +t.slice(3, 5) * 60 + +t.slice(6, 8) + +t.slice(9, 12) / 1000;
};

for (const f of process.argv.slice(2)) {
  const lines = readFileSync(f, 'utf8').split('\n');
  const open = new Map();
  let peak = 0; let peakAt = ''; const hist = [];
  const hangs = [];
  for (const line of lines) {
    const m = line.match(/L3 (START|END|THROW) \S+ #(\d+)(.*)$/);
    if (!m) continue;
    const [, kind, id, rest] = m;
    const s = secOf(line);
    if (kind === 'START') open.set(id, s);
    else {
      const st = open.get(id);
      open.delete(id);
      if (st !== undefined && s - st >= SLOW_SEC) hangs.push({ id, st, dur: s - st, kind, rest: rest.trim() });
    }
    if (open.size > peak) { peak = open.size; peakAt = line.slice(11, 23); }
    hist.push([s, open.size]);
  }
  // распределение
  const buckets = new Map();
  for (const [, n] of hist) buckets.set(n, (buckets.get(n) || 0) + 1);
  const top = [...buckets].sort((a, b) => b[0] - a[0]).slice(0, 8).map(([n, c]) => `${n}:${c}`).join(' ');
  console.log(`\n=== ${f} ===`);
  console.log(`пик одновременных вызовов: ${peak} (в ${peakAt}); распределение сверху: ${top}`);
  console.log(`не завершились к концу лога: ${open.size}` + (open.size ? ` (старты: ${[...open.values()].map((v) => v.toFixed(1)).slice(0, 10).join(', ')})` : ''));
  if (hangs.length) {
    console.log(`медленные (>=${SLOW_SEC}с): ${hangs.length}`);
    for (const h of hangs.slice(0, 20)) {
      const at = new Date(h.st * 1000).toISOString().slice(11, 19);
      const inflight = hist.find(([s]) => s >= h.st)?.[1];
      console.log(`  #${h.id} старт ${at} длит ${h.dur.toFixed(1)}с in-flight-на-старте≈${inflight} ${h.kind} ${h.rest}`);
    }
  }
}
