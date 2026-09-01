#!/usr/bin/env node
// Находит зависшие и медленные вызовы к внешней системе по логам инструментации
// и печатает окна зависаний — вход для анализа дампов на стороне этой системы.
//
//   node hang-window.mjs <since ISO|HH:MM:SS|30m> [сервис ...]
//
// Ожидаемый формат строк в логе контейнера (его даёт твоя инструментация, см. README):
//   <ISO-timestamp> ... L1 START <method> #<id> q=<текст запроса>
//   <ISO-timestamp> ... L1 END   <method> #<id> <ms>ms
//   <ISO-timestamp> ... L1 THROW <method> #<id> <текст ошибки>
// L1 — уровень клиента приложения, L3 — уровень транспорта; уровни независимы.
//
// Окружение:
//   NIGHTLY_CONTAINER_FMT  шаблон имени контейнера, {svc} подставляется
//                          (по умолчанию "nightly-{svc}-1")
//   NIGHTLY_SERVICES       список сервисов по умолчанию через запятую
//   NIGHTLY_SLOW_MS        порог «медленного» вызова, мс (по умолчанию 5000)
import { execSync } from 'node:child_process';

const since = process.argv[2] ?? '30m';
const defaults = (process.env.NIGHTLY_SERVICES || 'orders,catalog,delivery').split(',').map((x) => x.trim());
const svcs = process.argv.slice(3).length ? process.argv.slice(3) : defaults;
const SLOW = Number(process.env.NIGHTLY_SLOW_MS || 5000);
const CONTAINER_FMT = process.env.NIGHTLY_CONTAINER_FMT || 'nightly-{svc}-1';

const all = [];
for (const svc of svcs) {
  let out = '';
  try {
    out = execSync(
      `docker logs -t --since '${since}' ${CONTAINER_FMT.replace('{svc}', svc)} 2>&1 | grep -aE 'L1 (START|END|THROW)|L3 (START|END|THROW)' || true`,
      { maxBuffer: 1024 * 1024 * 1024 },
    ).toString();
  } catch { continue; }
  const open = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+.*?(L1|L3) (START|END|THROW) (\S+) #(\d+)(.*)$/);
    if (!m) continue;
    const [, ts, lvl, kind, meth, id, rest] = m;
    const t = Date.parse(ts);
    const key = `${lvl}#${id}`;
    if (kind === 'START') {
      open.set(key, { svc, lvl, meth, id: +id, start: t, q: (rest.match(/q=(.*)$/) || [, ''])[1].slice(0, 150) });
    } else {
      const o = open.get(key);
      if (!o) continue;
      open.delete(key);
      o.end = t; o.ms = t - o.start; o.kind = kind; o.err = kind === 'THROW' ? rest.trim() : '';
      if (o.ms >= SLOW) all.push(o);
    }
  }
  for (const o of open.values()) { o.kind = 'NO-END'; o.ms = null; all.push(o); }
}
all.sort((a, b) => a.start - b.start);

const f = (t) => new Date(t).toISOString().slice(11, 23);
console.log(`Зависших/медленных (>=${SLOW}ms) вызовов: ${all.length}\n`);
console.log('старт        | конец        | длит.    | сервис               | ур | метод          | исход  | запрос');
console.log('-'.repeat(170));
for (const o of all) {
  console.log(
    `${f(o.start)} | ${o.end ? f(o.end) : '     —      '} | ${String(o.ms ?? '—').padStart(7)}м | ` +
    `${o.svc.padEnd(20)} | ${o.lvl} | ${o.meth.padEnd(14)} | ${o.kind.padEnd(6)} | ${o.q || o.err}`,
  );
}
