#!/usr/bin/env node

const { exec } = require("child_process");
const chalk = require("chalk");

// Цвета для красивого вывода (из build-manager.js)
const colors = {
    primary: chalk.hex("#00D4FF"),
    success: chalk.hex("#00FF88"),
    warning: chalk.hex("#FFB800"),
    error: chalk.hex("#FF4757"),
    info: chalk.hex("#74B9FF"),
    muted: chalk.hex("#6C7B7F"),
    accent: chalk.hex("#A29BFE"),
};

// Красивый заголовок
function printHeader() {
    console.log("");
    console.log(colors.primary("╔══════════════════════════════════════════╗"));
    console.log(colors.primary("║") + colors.accent("  🐳 Docker Toolset   ") + colors.primary("║"));
    console.log(colors.primary("╚══════════════════════════════════════════╝"));
    console.log("");
}

// Красивые логи
function log(level, message, icon = "") {
    switch (level) {
        case "success":
            console.log(`${colors.success("✓")} ${colors.success(message)}`);
            break;
        case "error":
            console.log(`${colors.error("✗")} ${colors.error(message)}`);
            break;
        case "warning":
            console.log(`${colors.warning("⚠")} ${colors.warning(message)}`);
            break;
        case "info":
            console.log(`${colors.info("ℹ")} ${colors.info(message)}`);
            break;
        case "step":
            console.log(`${colors.primary("→")} ${colors.primary(message)}`);
            break;
        default:
            console.log(`${icon} ${message}`);
    }
}

// Выполнение команды с Promise
function execCommand(command, description = "") {
    return new Promise((resolve, reject) => {
        if (description) {
            log("info", description);
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

// Проверка системных требований
async function checkRequirements() {
    log("info", "Проверка системных требований...");

    return new Promise((resolve, reject) => {
        exec("docker --version", (error, stdout) => {
            if (error) {
                log("error", "Docker не установлен или недоступен");
                reject(error);
                return;
            }

            log("success", "Docker доступен");
            resolve();
        });
    });
}

// ==================== СТАТИСТИКА ====================

// Получение статистики образов
async function getImageStats() {
    try {
        log("step", "Анализ Docker образов");

        // Получаем список всех образов
        const imagesResult = await execCommand(
            'docker images --format "{{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedAt}}"',
            "Получение списка образов",
        );
        const images = imagesResult.stdout
            .trim()
            .split("\n")
            .filter((line) => line.trim());

        console.log(colors.info("📦 Статистика образов:"));
        console.log(colors.muted("─".repeat(80)));

        if (images.length > 0) {
            // Заголовок таблицы
            console.log(colors.accent("Образ".padEnd(30) + "Тег".padEnd(15) + "Размер".padEnd(12) + "Создан"));
            console.log(colors.muted("─".repeat(80)));

            // Сортируем по размеру (убираем 'MB', 'GB' и парсим)
            const sortedImages = images
                .map((line) => {
                    const [repo, tag, size, created] = line.split("\t");
                    const sizeValue = parseFloat(size.replace(/[^\d.]/g, ""));
                    const sizeUnit = size.replace(/[\d.]/g, "");
                    return { repo, tag, size, sizeValue, sizeUnit, created, line };
                })
                .sort((a, b) => {
                    // Конвертируем в MB для сравнения
                    const aMB = a.sizeUnit === "GB" ? a.sizeValue * 1024 : a.sizeValue;
                    const bMB = b.sizeUnit === "GB" ? b.sizeValue * 1024 : b.sizeValue;
                    return bMB - aMB;
                });

            // Выводим образы
            sortedImages.forEach(({ repo, tag, size, created }) => {
                const repoDisplay = repo.length > 28 ? repo.substring(0, 25) + "..." : repo;
                const tagDisplay = tag.length > 13 ? tag.substring(0, 10) + "..." : tag;
                console.log(
                    colors.info(repoDisplay.padEnd(30)) +
                        colors.muted(tagDisplay.padEnd(15)) +
                        colors.warning(size.padEnd(12)) +
                        colors.muted(created),
                );
            });

            console.log(colors.muted("─".repeat(80)));
            console.log(colors.success(`Всего образов: ${images.length}`));
        } else {
            console.log(colors.warning("Образы не найдены"));
        }
    } catch (error) {
        log("error", `Ошибка при получении статистики образов: ${error.message}`);
    }
}

// Получение статистики контейнеров
async function getContainerStats() {
    try {
        log("step", "Анализ Docker контейнеров");

        // Получаем все контейнеры (включая остановленные)
        const allContainersResult = await execCommand(
            'docker ps -a --format "{{.Names}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Image}}"',
            "Получение списка всех контейнеров",
        );
        const allContainers = allContainersResult.stdout
            .trim()
            .split("\n")
            .filter((line) => line.trim());

        // Получаем запущенные контейнеры
        const runningContainersResult = await execCommand(
            'docker ps --format "{{.Names}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Image}}"',
            "Получение списка запущенных контейнеров",
        );
        const runningContainers = runningContainersResult.stdout
            .trim()
            .split("\n")
            .filter((line) => line.trim());

        console.log(colors.info("🐳 Статистика контейнеров:"));
        console.log(colors.muted("─".repeat(80)));

        if (allContainers.length > 0) {
            // Заголовок таблицы
            console.log(colors.accent("Имя".padEnd(25) + "Статус".padEnd(20) + "Порты".padEnd(15) + "Образ"));
            console.log(colors.muted("─".repeat(80)));

            allContainers.forEach((line) => {
                const [name, status, ports, image] = line.split("\t");
                const nameDisplay = name.length > 23 ? name.substring(0, 20) + "..." : name;
                const statusDisplay = status.length > 18 ? status.substring(0, 15) + "..." : status;
                const portsDisplay = ports.length > 13 ? ports.substring(0, 10) + "..." : ports;
                const imageDisplay = image.length > 20 ? image.substring(0, 17) + "..." : image;

                // Цвет статуса
                const statusColor = status.includes("Up")
                    ? colors.success
                    : status.includes("Exited")
                      ? colors.warning
                      : status.includes("Created")
                        ? colors.info
                        : colors.error;

                console.log(
                    colors.info(nameDisplay.padEnd(25)) +
                        statusColor(statusDisplay.padEnd(20)) +
                        colors.muted(portsDisplay.padEnd(15)) +
                        colors.muted(imageDisplay),
                );
            });

            console.log(colors.muted("─".repeat(80)));
            console.log(colors.success(`Всего контейнеров: ${allContainers.length}`));
            console.log(colors.info(`Запущенных: ${runningContainers.length}`));
            console.log(colors.warning(`Остановленных: ${allContainers.length - runningContainers.length}`));
        } else {
            console.log(colors.warning("Контейнеры не найдены"));
        }
    } catch (error) {
        log("error", `Ошибка при получении статистики контейнеров: ${error.message}`);
    }
}

// Получение статистики томов
async function getVolumeStats() {
    try {
        log("step", "Анализ Docker томов");

        const volumesResult = await execCommand(
            'docker volume ls --format "{{.Driver}}\\t{{.Name}}"',
            "Получение списка томов",
        );
        const volumes = volumesResult.stdout
            .trim()
            .split("\n")
            .filter((line) => line.trim());

        console.log(colors.info("💾 Статистика томов:"));
        console.log(colors.muted("─".repeat(50)));

        if (volumes.length > 0) {
            // Заголовок таблицы
            console.log(colors.accent("Драйвер".padEnd(15) + "Имя"));
            console.log(colors.muted("─".repeat(50)));

            volumes.forEach((line) => {
                const [driver, name] = line.split("\t");
                const nameDisplay = name.length > 30 ? name.substring(0, 27) + "..." : name;
                console.log(colors.info(driver.padEnd(15)) + colors.muted(nameDisplay));
            });

            console.log(colors.muted("─".repeat(50)));
            console.log(colors.success(`Всего томов: ${volumes.length}`));
        } else {
            console.log(colors.warning("Томы не найдены"));
        }
    } catch (error) {
        log("error", `Ошибка при получении статистики томов: ${error.message}`);
    }
}

// Получение статистики сетей
async function getNetworkStats() {
    try {
        log("step", "Анализ Docker сетей");

        const networksResult = await execCommand(
            'docker network ls --format "{{.Name}}\\t{{.Driver}}\\t{{.Scope}}"',
            "Получение списка сетей",
        );
        const networks = networksResult.stdout
            .trim()
            .split("\n")
            .filter((line) => line.trim());

        console.log(colors.info("🌐 Статистика сетей:"));
        console.log(colors.muted("─".repeat(50)));

        if (networks.length > 0) {
            // Заголовок таблицы
            console.log(colors.accent("Имя".padEnd(20) + "Драйвер".padEnd(12) + "Область"));
            console.log(colors.muted("─".repeat(50)));

            networks.forEach((line) => {
                const [name, driver, scope] = line.split("\t");
                const nameDisplay = name.length > 18 ? name.substring(0, 15) + "..." : name;
                console.log(
                    colors.info(nameDisplay.padEnd(20)) + colors.muted(driver.padEnd(12)) + colors.muted(scope),
                );
            });

            console.log(colors.muted("─".repeat(50)));
            console.log(colors.success(`Всего сетей: ${networks.length}`));
        } else {
            console.log(colors.warning("Сети не найдены"));
        }
    } catch (error) {
        log("error", `Ошибка при получении статистики сетей: ${error.message}`);
    }
}

// Получение общей статистики системы
async function getSystemStats() {
    try {
        log("step", "Общая статистика Docker системы");

        // Получаем информацию о системе
        const infoResult = await execCommand(
            'docker system info --format "{{.ServerVersion}}\\t{{.Containers}}\\t{{.Images}}\\t{{.Driver}}"',
            "Получение информации о системе",
        );
        const [version, containers, images, driver] = infoResult.stdout.trim().split("\t");

        console.log(colors.info("🔧 Информация о системе:"));
        console.log(colors.muted("─".repeat(60)));
        console.log(colors.info(`Версия Docker: ${colors.accent(version)}`));
        console.log(colors.info(`Контейнеры: ${colors.accent(containers)}`));
        console.log(colors.info(`Образы: ${colors.accent(images)}`));
        console.log(colors.info(`Драйвер хранилища: ${colors.accent(driver)}`));
        console.log(colors.muted("─".repeat(60)));

        // Получаем использование ресурсов
        const dfResult = await execCommand("docker system df", "Получение статистики использования");
        console.log(colors.info("💾 Использование ресурсов:"));
        console.log(dfResult.stdout);
    } catch (error) {
        log("error", `Ошибка при получении системной статистики: ${error.message}`);
    }
}

// Показать полную статистику (по умолчанию)
async function showFullStats() {
    await getImageStats();
    console.log("");
    await getContainerStats();
    console.log("");
    await getVolumeStats();
    console.log("");
    await getNetworkStats();
    console.log("");
    await getSystemStats();
}

// ==================== ОЧИСТКА ====================

// Запрос подтверждения от пользователя
async function askConfirmation(message) {
    const readline = require("readline");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(colors.error(`${message} (yes/no): `), (answer) => {
            rl.close();
            resolve(answer.toLowerCase());
        });
    });
}

// Безопасная очистка (только неиспользуемые ресурсы)
async function safeCleanup() {
    log("step", "Безопасная очистка неиспользуемых ресурсов");

    const cleanSteps = [
        {
            name: "Очистка неиспользуемых образов",
            command: "docker image prune -f",
            description: "Удаление неиспользуемых образов",
        },
        {
            name: "Очистка остановленных контейнеров",
            command: "docker container prune -f",
            description: "Удаление остановленных контейнеров",
        },
        {
            name: "Очистка неиспользуемых томов",
            command: "docker volume prune -f",
            description: "Удаление неиспользуемых томов",
        },
        {
            name: "Очистка неиспользуемых сетей",
            command: "docker network prune -f",
            description: "Удаление неиспользуемых сетей",
        },
        {
            name: "Очистка кэша сборки",
            command: "docker builder prune -f",
            description: "Очистка кэша сборки Docker",
        },
    ];

    let totalCleaned = 0;
    const startTime = Date.now();

    for (const step of cleanSteps) {
        try {
            const result = await execCommand(step.command, step.description);

            // Парсим результат для подсчета очищенных ресурсов
            const output = result.stdout + result.stderr;
            let cleaned = 0;

            if (output.includes("Total reclaimed space:")) {
                const spaceMatch = output.match(/Total reclaimed space:\s*([\d.]+)\s*([A-Z]+)/);
                if (spaceMatch) {
                    const space = parseFloat(spaceMatch[1]);
                    const unit = spaceMatch[2];
                    cleaned = space;
                    log("success", `✓ ${step.name} - освобождено ${space} ${unit}`);
                }
            } else if (output.includes("deleted") || output.includes("removed")) {
                const deletedMatch = output.match(/(\d+)\s+(deleted|removed)/);
                if (deletedMatch) {
                    cleaned = parseInt(deletedMatch[1]);
                    log("success", `✓ ${step.name} - удалено ${cleaned} элементов`);
                } else {
                    log("success", `✓ ${step.name} - выполнено`);
                }
            } else {
                log("success", `✓ ${step.name} - выполнено`);
            }

            totalCleaned += cleaned;
        } catch (error) {
            log("warning", `⚠ ${step.name} - ${error.message}`);
        }

        // Небольшая пауза между командами
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    log("success", `🧹 Безопасная очистка завершена за ${duration}с`);

    if (totalCleaned > 0) {
        log("info", `💾 Общий объем освобожденного пространства: ${totalCleaned} MB`);
    }
}

// Агрессивная очистка (все неиспользуемые ресурсы)
async function aggressiveCleanup() {
    log("step", "Агрессивная очистка всех неиспользуемых ресурсов");

    const cleanSteps = [
        {
            name: "Удаление всех неиспользуемых образов",
            command: "docker image prune -a -f",
            description: "Удаление всех неиспользуемых образов (включая теги)",
        },
        {
            name: "Удаление всех остановленных контейнеров",
            command: "docker container prune -f",
            description: "Удаление всех остановленных контейнеров",
        },
        {
            name: "Удаление всех неиспользуемых томов",
            command: "docker volume prune -f",
            description: "Удаление всех неиспользуемых томов",
        },
        {
            name: "Удаление всех неиспользуемых сетей",
            command: "docker network prune -f",
            description: "Удаление всех неиспользуемых сетей",
        },
        {
            name: "Очистка всего кэша сборки",
            command: "docker builder prune -a -f",
            description: "Очистка всего кэша сборки Docker",
        },
        {
            name: "Системная очистка",
            command: "docker system prune -a -f --volumes",
            description: "Удаление всех неиспользуемых данных системы",
        },
    ];

    let totalCleaned = 0;
    const startTime = Date.now();

    for (const step of cleanSteps) {
        try {
            const result = await execCommand(step.command, step.description);

            // Парсим результат для подсчета очищенных ресурсов
            const output = result.stdout + result.stderr;
            let cleaned = 0;

            if (output.includes("Total reclaimed space:")) {
                const spaceMatch = output.match(/Total reclaimed space:\s*([\d.]+)\s*([A-Z]+)/);
                if (spaceMatch) {
                    const space = parseFloat(spaceMatch[1]);
                    const unit = spaceMatch[2];
                    cleaned = space;
                    log("success", `✓ ${step.name} - освобождено ${space} ${unit}`);
                }
            } else if (output.includes("deleted") || output.includes("removed")) {
                const deletedMatch = output.match(/(\d+)\s+(deleted|removed)/);
                if (deletedMatch) {
                    cleaned = parseInt(deletedMatch[1]);
                    log("success", `✓ ${step.name} - удалено ${cleaned} элементов`);
                } else {
                    log("success", `✓ ${step.name} - выполнено`);
                }
            } else {
                log("success", `✓ ${step.name} - выполнено`);
            }

            totalCleaned += cleaned;
        } catch (error) {
            log("warning", `⚠ ${step.name} - ${error.message}`);
        }

        // Небольшая пауза между командами
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    log("success", `🧹 Агрессивная очистка завершена за ${duration}с`);

    if (totalCleaned > 0) {
        log("info", `💾 Общий объем освобожденного пространства: ${totalCleaned} MB`);
    }
}

// Тотальная очистка (ВСЕ ресурсы)
async function totalCleanup() {
    log("step", "ТОТАЛЬНАЯ ОЧИСТКА ВСЕХ DOCKER РЕСУРСОВ");

    // Показываем предупреждение
    console.log(colors.warning("⚠️  ВНИМАНИЕ: Эта команда удалит ВСЕ Docker ресурсы!"));
    console.log(colors.warning("   - Все остановленные контейнеры"));
    console.log(colors.warning("   - ВСЕ образы (включая используемые!)"));
    console.log(colors.warning("   - ВСЕ ТОМЫ (включая используемые!)"));
    console.log(colors.warning("   - Все неиспользуемые сети"));
    console.log(colors.warning("   - Весь кэш сборки"));
    console.log("");

    // Запрашиваем подтверждение
    const answer = await askConfirmation("Вы уверены, что хотите продолжить?");

    if (answer !== "yes" && answer !== "y") {
        log("info", "Тотальная очистка отменена пользователем");
        return;
    }

    const cleanSteps = [
        {
            name: "Остановка всех контейнеров",
            command: "docker stop $(docker ps -aq) 2>/dev/null || true",
            description: "Останавливаем все запущенные контейнеры",
        },
        {
            name: "Удаление всех контейнеров",
            command: "docker rm $(docker ps -aq) 2>/dev/null || true",
            description: "Удаляем все контейнеры",
        },
        {
            name: "Удаление всех образов",
            command: "docker rmi $(docker images -q) 2>/dev/null || true",
            description: "Удаляем ВСЕ образы",
        },
        {
            name: "Удаление всех томов",
            command: "docker volume rm $(docker volume ls -q) 2>/dev/null || true",
            description: "Удаляем ВСЕ тома (включая используемые)",
        },
        {
            name: "Принудительное удаление томов",
            command: "docker volume ls -q | xargs -r docker volume rm -f 2>/dev/null || true",
            description: "Принудительно удаляем оставшиеся тома",
        },
        {
            name: "Удаление всех сетей (кроме встроенных)",
            command: "docker network ls -q | xargs -r docker network rm 2>/dev/null || true",
            description: "Удаляем все пользовательские сети",
        },
        {
            name: "Очистка кэша сборки",
            command: "docker builder prune -a -f",
            description: "Очищаем весь кэш сборки Docker",
        },
        {
            name: "Удаление неиспользуемых данных",
            command: "docker system prune -a -f --volumes",
            description: "Удаляем все неиспользуемые данные системы",
        },
    ];

    let totalCleaned = 0;
    const startTime = Date.now();

    for (const step of cleanSteps) {
        try {
            const result = await execCommand(step.command, step.description);

            // Парсим результат для подсчета очищенных ресурсов
            const output = result.stdout + result.stderr;
            let cleaned = 0;

            if (output.includes("Total reclaimed space:")) {
                const spaceMatch = output.match(/Total reclaimed space:\s*([\d.]+)\s*([A-Z]+)/);
                if (spaceMatch) {
                    const space = parseFloat(spaceMatch[1]);
                    const unit = spaceMatch[2];
                    cleaned = space;
                    log("success", `✓ ${step.name} - освобождено ${space} ${unit}`);
                }
            } else if (output.includes("deleted") || output.includes("removed")) {
                const deletedMatch = output.match(/(\d+)\s+(deleted|removed)/);
                if (deletedMatch) {
                    cleaned = parseInt(deletedMatch[1]);
                    log("success", `✓ ${step.name} - удалено ${cleaned} элементов`);
                } else {
                    log("success", `✓ ${step.name} - выполнено`);
                }
            } else {
                log("success", `✓ ${step.name} - выполнено`);
            }

            totalCleaned += cleaned;
        } catch (error) {
            log("warning", `⚠ ${step.name} - ${error.message}`);
        }

        // Небольшая пауза между командами
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    log("success", `🧹 Тотальная очистка завершена за ${duration}с`);

    if (totalCleaned > 0) {
        log("info", `💾 Общий объем освобожденного пространства: ${totalCleaned} MB`);
    }
}

// Очистка конкретного типа ресурсов
async function cleanSpecific(type) {
    switch (type) {
        case "images":
            log("step", "Очистка образов");
            await execCommand("docker image prune -a -f", "Удаление всех неиспользуемых образов");
            break;

        case "containers":
            log("step", "Очистка контейнеров");
            await execCommand("docker container prune -f", "Удаление остановленных контейнеров");
            break;

        case "volumes":
            log("step", "Очистка томов");
            await execCommand("docker volume prune -f", "Удаление неиспользуемых томов");
            break;

        case "networks":
            log("step", "Очистка сетей");
            await execCommand("docker network prune -f", "Удаление неиспользуемых сетей");
            break;

        case "cache":
            log("step", "Очистка кэша");
            await execCommand("docker builder prune -a -f", "Очистка кэша сборки");
            break;

        default:
            log("error", `Неизвестный тип ресурса: ${type}`);
            return;
    }

    log("success", `Очистка ${type} завершена`);
}

// ==================== ОСНОВНАЯ ФУНКЦИЯ ====================

async function main() {
    const command = process.argv[2] || "stats";
    const target = process.argv[3];

    printHeader();

    try {
        await checkRequirements();

        switch (command) {
            case "stats":
                await showFullStats();
                break;

            case "images":
                await getImageStats();
                break;

            case "containers":
                await getContainerStats();
                break;

            case "volumes":
                await getVolumeStats();
                break;

            case "networks":
                await getNetworkStats();
                break;

            case "system":
                await getSystemStats();
                break;

            case "clean-safe":
                await safeCleanup();
                break;

            case "clean-aggressive":
                await aggressiveCleanup();
                break;

            case "clean-total":
                await totalCleanup();
                break;

            case "clean-images":
            case "clean-containers":
            case "clean-volumes":
            case "clean-networks":
            case "clean-cache":
                const cleanType = command.replace("clean-", "");
                await cleanSpecific(cleanType);
                break;

            default:
                console.log(colors.primary("🐳 Docker Toolset - Универсальный инструмент для работы с Docker"));
                console.log("");
                console.log(colors.info("Использование: node docker-toolset.js [команда]"));
                console.log("");
                console.log(colors.info("📊 Команды статистики:"));
                console.log("  (без аргументов) - Полная статистика системы");
                console.log("  stats            - Полная статистика системы");
                console.log("  images           - Статистика образов");
                console.log("  containers       - Статистика контейнеров");
                console.log("  volumes          - Статистика томов");
                console.log("  networks         - Статистика сетей");
                console.log("  system           - Общая системная информация");
                console.log("");
                console.log(colors.info("🧹 Команды очистки:"));
                console.log("  clean-safe       - Безопасная очистка (только неиспользуемые ресурсы)");
                console.log("  clean-aggressive - Агрессивная очистка (все неиспользуемые ресурсы)");
                console.log("  clean-total      - ТОТАЛЬНАЯ очистка (ВСЕ ресурсы)");
                console.log("  clean-images     - Очистка только образов");
                console.log("  clean-containers - Очистка только контейнеров");
                console.log("  clean-volumes    - Очистка только томов");
                console.log("  clean-networks   - Очистка только сетей");
                console.log("  clean-cache      - Очистка только кэша сборки");
                console.log("");
                console.log(
                    colors.warning('⚠️  ВНИМАНИЕ: Команды "clean-aggressive" и "clean-total" удаляют много ресурсов!'),
                );
                break;
        }

        if (command !== "help" && !command.startsWith("clean-")) {
            console.log("");
            log("success", "🎉 Операция завершена успешно!");
        } else if (command.startsWith("clean-")) {
            console.log("");
            log("success", "🎉 Очистка завершена!");

            // Показываем состояние после очистки
            console.log("");
            await showFullStats();
        }
    } catch (error) {
        log("error", `Ошибка: ${error.message}`);
        process.exit(1);
    }
}

// Запускаем
main();
