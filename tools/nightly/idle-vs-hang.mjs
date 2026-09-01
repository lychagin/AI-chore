#!/usr/bin/env node
// Проверяет связь «простой соединения → зависание следующего вызова».
// Для каждого вызова считает паузу с момента предыдущего вызова того же сервиса
// и сопоставляет с его длительностью. Если зависают именно вызовы после долгой
// паузы — дело в переустановлении соединения, а не в самой внешней системе.
//
//   node idle-vs-hang.mjs <svc.log> [...]
//
// Вход — лог инструментации (формат описан в README и в hang-window.mjs).
// Порог «зависшего» вызова: NIGHTLY_SLOW_SEC, по умолчанию 5 секунд.
import { readFileSync } from 'node:fs';

const SLOW_SEC = Number(process.env.NIGHTLY_SLOW_SEC || 5);

const secOf = (l) => {
  const t = l.slice(11, 23);
  return +t.slice(0, 2) * 3600 + +t.slice(3, 5) * 60 + +t.slice(6, 8) + +t.slice(9, 12) / 1000;
};

for (const f of process.argv.slice(2)) {
  const calls = [];
  const open = new Map();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/L1 (START|END|THROW) (\w+) #(\d+)(?: (\d+)ms)?/);
    if (!m) continue;
    const [, kind, meth, id, ms] = m;
    const s = secOf(line);
    if (kind === 'START') open.set(id, { id, meth, start: s });
    else {
      const o = open.get(id); open.delete(id);
      if (o) calls.push({ ...o, dur: ms ? +ms / 1000 : s - o.start, end: s });
    }
  }
  calls.sort((a, b) => a.start - b.start);
  // пауза = сколько канал простаивал перед стартом вызова (нет активных и завершённых вызовов)
  let lastEnd = null;
  const rows = [];
  for (const c of calls) {
    const idle = lastEnd === null ? null : c.start - lastEnd;
    rows.push({ ...c, idle });
    lastEnd = Math.max(lastEnd ?? 0, c.end);
  }
  const slow = rows.filter((r) => r.dur >= SLOW_SEC);
  const fast = rows.filter((r) => r.dur < SLOW_SEC);
  const q = (arr, k) => {
    const v = arr.map((r) => r[k]).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    return v.length ? `n=${v.length} median=${v[Math.floor(v.length / 2)].toFixed(1)}с max=${v.at(-1).toFixed(1)}с` : 'нет данных';
  };
  console.log(`\n=== ${f.split('/').pop()} ===`);
  console.log(`вызовов: ${rows.length}, из них зависших (>=${SLOW_SEC}с): ${slow.length}`);
  console.log(`пауза перед БЫСТРЫМИ вызовами:  ${q(fast, 'idle')}`);
  console.log(`пауза перед ЗАВИСШИМИ вызовами: ${q(slow, 'idle')}`);
  if (slow.length) {
    console.log('зависшие подробно:');
    for (const r of slow.slice(0, 15)) {
      const at = new Date(r.start * 1000).toISOString().slice(11, 19);
      console.log(`  #${r.id} ${r.meth} старт ${at} пауза до него=${r.idle === null ? '—' : r.idle.toFixed(1) + 'с'} длительность=${r.dur.toFixed(1)}с`);
    }
  }
  // самые длинные простои и что было после них
  const idles = rows.filter((r) => r.idle !== null).sort((a, b) => b.idle - a.idle).slice(0, 8);
  console.log('самые длинные простои канала → длительность следующего вызова:');
  for (const r of idles) {
    const at = new Date(r.start * 1000).toISOString().slice(11, 19);
    console.log(`  простой ${r.idle.toFixed(0).padStart(4)}с → вызов #${r.id} в ${at}: ${r.dur.toFixed(2)}с`);
  }
}
