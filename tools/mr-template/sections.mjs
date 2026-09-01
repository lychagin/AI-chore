"use strict";

export const TITLE_HINT = "<!-- MR title: type(scope): [TASK-XXX] subject — при squash станет финальным commit -->";

// Условные строки чеклиста: key -> {flag в checklist, текст}
export const CONDITIONAL_CHECKS = [
    { flag: "openapi", text: "OpenAPI изменён → `npm run build`, валидаторы пересозданы" },
    { flag: "dgraph", text: "DGraph schema → миграция + сидер обновлены" },
    { flag: "frontend", text: "Скриншоты/видео приложены" },
];

export const PROSE = {
    whatDone: "<!-- AI: 1–3 строки что сделано -->",
    howTested: "<!-- AI: что прогнали / как убедились -->",
    problem: "<!-- AI: что ломалось + как воспроизвести, кратко -->",
    rootCause: "<!-- AI: почему ломалось -->",
    introduced: "<!-- AI: на основе blameHints: commit / автор / дата -->",
    fix: "<!-- AI: что изменили -->",
};

export const WHY_NOT_FOUND = [
    "не запускали / сломаны / нет юнит-тестов",
    "нет / неисправны интеграционные тесты",
    "изначально так реализовано",
    "недостаточно требований",
    "новые требования",
];
