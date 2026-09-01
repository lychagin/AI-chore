# md2pdf — Markdown → PDF

Конвертирует дерево `.md` в PDF: GFM-таблицы через pandoc, блоки ` ```mermaid ` — в PNG через mermaid-cli, печать — headless Chromium.

Скрипт без npm-зависимостей проекта: вызывает внешние бинарники.

## Зависимости

| Инструмент                                                                    | Зачем                                     | Как проверить                              |
| ----------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| Node.js ≥ 18                                                                  | запуск `convert.mjs`                      | `node --version`                           |
| [pandoc](https://pandoc.org/)                                                 | GFM → HTML5, таблицы, `--embed-resources` | `pandoc --version`                         |
| Chromium / Chrome                                                             | `print-to-pdf`                            | `chromium --version`                       |
| [@mermaid-js/mermaid-cli](https://github.com/mermaid-js/mermaid-cli) (`mmdc`) | рендер mermaid                            | `mmdc --version`                           |
| Шрифты DejaVu / Liberation / Noto                                             | `print.css`                               | пакеты `fonts-dejavu` / `fonts-liberation` |

Установка на Debian/Ubuntu (ориентир):

```bash
sudo apt install pandoc chromium-browser fonts-dejavu
npm install -g @mermaid-js/mermaid-cli
```

Snap Chromium (`/snap/bin/chromium`) годится для печати PDF, но **не** как `executablePath` для Puppeteer: обёртка указывает на `/usr/bin/snap`. Для mermaid нужен сам бинарник, например `/snap/chromium/current/usr/lib/chromium-browser/chrome`.

Puppeteer mermaid-cli по умолчанию ищет свою сборку Chrome. Если кэш пуст (часто в Cursor), задайте системный Chrome — см. конфигурацию ниже.

## Запуск

Из корня репозитория:

```bash
node tools/md2pdf/convert.mjs <srcDir> [outDir]
```

По умолчанию PDF пишутся в `<srcDir>/pdf`, каталоги `pdf/`, `_build/`, `node_modules/`, `.git/` при обходе пропускаются.

Пример — сборка PDF по каталогу с постановкой:

```bash
node tools/md2pdf/convert.mjs \
  .swap/requirements/orders/checkout
```

Результат: `.swap/requirements/orders/checkout/pdf/**/*.pdf` (зеркалирует дерево markdown).

Другой каталог вывода:

```bash
node tools/md2pdf/convert.mjs ./docs --out /tmp/docs-pdf
```

Справка: `node tools/md2pdf/convert.mjs --help`.

## Параметры CLI

| Параметр                           | Смысл                                                          | По умолчанию                |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------- |
| `<srcDir>`                         | корень с `.md` (обязательный)                                  | —                           |
| `[outDir]` / `-o` / `--out`        | куда класть PDF                                                | `<srcDir>/pdf`              |
| `--css <file>`                     | стили печати                                                   | `tools/md2pdf/print.css` |
| `-p` / `--puppeteer-config <file>` | JSON для mermaid-cli (`-p`)                                    | см. ниже                    |
| `--keep-build`                     | не удалять `<outDir>/_build` (промежуточные `.md`/`.html`/PNG) | выкл.                       |
| `-h` / `--help`                    | справка                                                        | —                           |

## Переменные окружения

| Переменная                  | Смысл                                                           | По умолчанию                                     |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| `CHROMIUM`                  | бинарник для `--print-to-pdf`                                   | `chromium`                                       |
| `PUPPETEER_EXECUTABLE_PATH` | Chrome **для mermaid-cli** (реальный бинарник, не snap-wrapper) | автопоиск                                        |
| `PUPPETEER_CONFIG`          | путь к puppeteer JSON                                           | `tools/md2pdf/puppeteer.json`, если файл есть |
| `MD2PDF_CSS`                | путь к CSS                                                      | `tools/md2pdf/print.css`                      |
| `MMDC`                      | mermaid-cli                                                     | `mmdc`                                           |
| `PANDOC`                    | pandoc                                                          | `pandoc`                                         |
| `MMDC_SCALE`                | `-s` mermaid PNG                                                | `2`                                              |
| `MMDC_WIDTH`                | `-w` mermaid PNG                                                | `2400`                                           |

Приоритет конфига Puppeteer: `--puppeteer-config` → `PUPPETEER_CONFIG` → `tools/md2pdf/puppeteer.json` → автогенерация из `PUPPETEER_EXECUTABLE_PATH` / известных путей Chrome.

Автопоиск Chrome для mermaid (первый существующий не-snap-wrapper):

1. `PUPPETEER_EXECUTABLE_PATH`
2. `/snap/chromium/current/usr/lib/chromium-browser/chrome`
3. `/usr/lib/chromium-browser/chrome`
4. `google-chrome-stable` / `google-chrome` / `chromium-browser` / `chromium` в `/usr/bin`

Свой JSON (скопируйте пример и поправьте `executablePath`):

```bash
cp tools/md2pdf/puppeteer.json.example tools/md2pdf/puppeteer.json
```

`puppeteer.json` в git не кладём: путь к Chrome зависит от машины.

Пример явного Chrome:

```bash
export CHROMIUM=chromium
export PUPPETEER_EXECUTABLE_PATH=/snap/chromium/current/usr/lib/chromium-browser/chrome
node tools/md2pdf/convert.mjs .swap/requirements/orders/checkout
```

## Что делает конвертер

1. Рекурсивно собирает `.md` под `srcDir`.
2. Если в файле есть ` ```mermaid `, вызывает `mmdc` → markdown с PNG.
3. Иначе копирует markdown как есть.
4. `pandoc -f gfm -t html5 --standalone --embed-resources` + `print.css`.
5. Chromium `--headless=new --print-to-pdf` (A4 landscape, поля 12 mm, без колонтитулов).
6. Удаляет `_build`, если не передан `--keep-build`.

Заголовок PDF берётся из первой строки `# …` исходного markdown.

## Состав каталога

| Файл                     | Назначение                                                   |
| ------------------------ | ------------------------------------------------------------ |
| `convert.mjs`            | CLI                                                          |
| `print.css`              | стили печати (таблицы, mermaid-картинки, моноширинные блоки) |
| `puppeteer.json.example` | образец конфига mermaid-cli / Puppeteer                      |

---

## Как приспособить к своему проекту

Привязок к проекту нет — конвертер работает с любым деревом markdown. Настраивается
внешними бинарниками и переменными окружения, которые перечислены выше.

Что стоит проверить до первого прогона на своих документах:

1. **Chromium.** Скрипт печатает через headless-браузер и ищет его сам. На системах,
   где Chromium стоит из snap или flatpak, автоопределение промахивается — путь
   задаётся через `PUPPETEER_EXECUTABLE_PATH` (пример есть выше).
2. **pandoc и mermaid-cli.** Оба внешние. Без pandoc не соберутся GFM-таблицы, без
   mermaid-cli блоки ` ```mermaid ` останутся текстом. Ошибка при этом не всегда
   заметна в выводе — сверься с получившимся PDF.
3. **`print.css`.** Здесь задаются поля страницы, шрифты и разрывы. Это единственный
   файл, который имеет смысл править под свой стиль документов.
