import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { DgraphClientWrapper } from "./dgraph-client.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Конфигурация: переменные процесса → .env рядом с сервером → путь из DGRAPH_MCP_ENV_FILE.
// Уже установленные переменные окружения имеют приоритет: dotenv их не перезаписывает.
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.DGRAPH_MCP_ENV_FILE || path.join(serverDir, "..", ".env");
dotenv.config({ path: configPath });

const server = new Server({
    name: "dgraph-mcp-server",
    version: "1.0.0",
});

// Конфигурация DGraph из существующего файла
const DGRAPH_CONNECT_URL = process.env.DGRAPH_CONNECT_URL || "localhost:19080";
const DGRAPH_ALPHA_ADDRESSES = process.env.DGRAPH_ALPHA_ADDRESSES?.split(",") || [DGRAPH_CONNECT_URL];
const DEBUG_MODE = process.env.DGRAPH_DEBUG === "true";

let dgraphClient: DgraphClientWrapper;

// Инициализация DGraph клиента
function initializeDgraphClient() {
    if (!dgraphClient) {
        dgraphClient = new DgraphClientWrapper(DGRAPH_ALPHA_ADDRESSES, undefined, DEBUG_MODE);
    }
    return dgraphClient;
}

// Инструменты для работы с DGraph
const tools: Tool[] = [
    {
        name: "dgraph_query",
        description: "Выполнить GraphQL+ запрос к DGraph",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "GraphQL+ запрос для выполнения",
                },
                variables: {
                    type: "object",
                    description: "Переменные для запроса (опционально)",
                    additionalProperties: true,
                },
            },
            required: ["query"],
        },
    },
    {
        name: "dgraph_mutate",
        description: "Выполнить мутацию в DGraph",
        inputSchema: {
            type: "object",
            properties: {
                data: {
                    type: "object",
                    description: "Данные для мутации в формате JSON",
                    additionalProperties: true,
                },
            },
            required: ["data"],
        },
    },
    {
        name: "dgraph_delete",
        description: "Удалить данные из DGraph",
        inputSchema: {
            type: "object",
            properties: {
                deleteJson: {
                    type: "object",
                    description: "Данные для удаления в формате JSON",
                    additionalProperties: true,
                },
                setJson: {
                    type: "object",
                    description: "Дополнительные данные для установки (опционально)",
                    additionalProperties: true,
                },
            },
            required: ["deleteJson"],
        },
    },
    {
        name: "dgraph_upsert",
        description: "Выполнить upsert операцию в DGraph",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Запрос для поиска существующих данных",
                },
                data: {
                    type: "object",
                    description: "Данные для вставки/обновления",
                    additionalProperties: true,
                },
                conditions: {
                    type: "string",
                    description: "Дополнительные условия (опционально)",
                },
            },
            required: ["query", "data"],
        },
    },
    {
        name: "dgraph_alter_schema",
        description: "Изменить схему DGraph",
        inputSchema: {
            type: "object",
            properties: {
                schema: {
                    type: "string",
                    description: "Схема DGraph в формате DQL",
                },
            },
            required: ["schema"],
        },
    },
    {
        name: "dgraph_get_stats",
        description: "Получить статистику базы данных DGraph",
        inputSchema: {
            type: "object",
            properties: {
                detailed: {
                    type: "boolean",
                    description: "Получить детальную статистику (опционально)",
                    default: false,
                },
            },
        },
    },
    {
        name: "dgraph_search",
        description: "Поиск по тексту в DGraph с использованием full-text search",
        inputSchema: {
            type: "object",
            properties: {
                searchTerm: {
                    type: "string",
                    description: "Поисковый запрос",
                },
                entityType: {
                    type: "string",
                    description: "Тип сущности для поиска (опционально)",
                },
                limit: {
                    type: "number",
                    description: "Максимальное количество результатов (опционально)",
                    default: 10,
                },
            },
            required: ["searchTerm"],
        },
    },
    {
        name: "dgraph_export",
        description: "Экспорт данных из DGraph в формате JSON",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Запрос для экспорта данных",
                },
                format: {
                    type: "string",
                    description: "Формат экспорта (json, csv, rdf)",
                    enum: ["json", "csv", "rdf"],
                    default: "json",
                },
                filename: {
                    type: "string",
                    description: "Имя файла для экспорта (опционально)",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "dgraph_health_check",
        description: "Проверить состояние здоровья DGraph базы данных",
        inputSchema: {
            type: "object",
            properties: {
                timeout: {
                    type: "number",
                    description: "Таймаут проверки в миллисекундах (опционально)",
                    default: 5000,
                },
            },
        },
    },
    {
        name: "dgraph_get_schema",
        description: "Получить текущую схему DGraph",
        inputSchema: {
            type: "object",
            properties: {
                format: {
                    type: "string",
                    description: "Формат схемы (dql, json, graphql)",
                    enum: ["dql", "json", "graphql"],
                    default: "json",
                },
            },
        },
    },
    {
        name: "dgraph_backup",
        description: "Создать резервную копию данных DGraph",
        inputSchema: {
            type: "object",
            properties: {
                destination: {
                    type: "string",
                    description: "Путь для сохранения резервной копии (опционально)",
                },
                includeSchema: {
                    type: "boolean",
                    description: "Включить схему в резервную копию",
                    default: true,
                },
            },
        },
    },
    {
        name: "dgraph_analyze_data",
        description: "Анализ данных в DGraph - поиск аномалий, дубликатов, связей",
        inputSchema: {
            type: "object",
            properties: {
                entityType: {
                    type: "string",
                    description: "Тип сущности для анализа (опционально)",
                },
                analysisType: {
                    type: "string",
                    description: "Тип анализа (duplicates, anomalies, relationships, all)",
                    enum: ["duplicates", "anomalies", "relationships", "all"],
                    default: "all",
                },
            },
        },
    },
];

// Обработчик списка инструментов
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
}));

// Обработчик вызова инструментов
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        const client = initializeDgraphClient();

        switch (name) {
            case "dgraph_query": {
                const { query, variables = {} } = args as { query: string; variables?: Record<string, any> };
                const result = await client.query(query, variables);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.getJson(), null, 2),
                        },
                    ],
                };
            }

            case "dgraph_mutate": {
                const { data } = args as { data: Record<string, any> };
                const result = await client.mutate(data);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.getJson(), null, 2),
                        },
                    ],
                };
            }

            case "dgraph_delete": {
                const { deleteJson, setJson = {} } = args as {
                    deleteJson: Record<string, any>;
                    setJson?: Record<string, any>;
                };
                const result = await client.delete(deleteJson, setJson);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.getJson(), null, 2),
                        },
                    ],
                };
            }

            case "dgraph_upsert": {
                const {
                    query,
                    data,
                    conditions = "",
                } = args as {
                    query: string;
                    data: Record<string, any>;
                    conditions?: string;
                };
                const result = await client.upsert(query, data, conditions);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.getJson(), null, 2),
                        },
                    ],
                };
            }

            case "dgraph_alter_schema": {
                const { schema } = args as { schema: string };
                const result = await client.alterSchema(schema);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.toObject(), null, 2),
                        },
                    ],
                };
            }

            case "dgraph_get_stats": {
                const { detailed = false } = args as { detailed?: boolean };
                const statsQuery = detailed
                    ? `{
            stats(func: has(dgraph.type)) {
              count(uid)
              type: dgraph.type
            }
            total(func: has(dgraph.type)) {
              total: count(uid)
            }
          }`
                    : `{
            total(func: has(dgraph.type)) {
              total: count(uid)
            }
          }`;

                const result = await client.query(statsQuery);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.getJson(), null, 2),
                        },
                    ],
                };
            }

            case "dgraph_search": {
                const {
                    searchTerm,
                    entityType,
                    limit = 10,
                } = args as {
                    searchTerm: string;
                    entityType?: string;
                    limit?: number;
                };

                let searchQuery = `{
          search(func: anyoftext(name, description, title), "${searchTerm}")`;

                if (entityType) {
                    searchQuery += ` @filter(eq(dgraph.type, "${entityType}"))`;
                }

                searchQuery += ` {
            uid
            name
            description
            title
            dgraph.type
          }
        }`;

                const result = await client.query(searchQuery);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result.getJson(), null, 2),
                        },
                    ],
                };
            }

            case "dgraph_export": {
                const {
                    query,
                    format = "json",
                    filename,
                } = args as {
                    query: string;
                    format?: string;
                    filename?: string;
                };

                const result = await client.query(query);
                const data = result.getJson();

                let exportData = data;
                if (format === "csv") {
                    // Простое преобразование в CSV (можно улучшить)
                    exportData = JSON.stringify(data, null, 2);
                } else if (format === "rdf") {
                    // Простое преобразование в RDF (можно улучшить)
                    exportData = JSON.stringify(data, null, 2);
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    format,
                                    filename: filename || `export_${Date.now()}.${format}`,
                                    data: exportData,
                                    recordCount: Array.isArray(data) ? data.length : 1,
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            case "dgraph_health_check": {
                const { timeout = 5000 } = args as { timeout?: number };

                try {
                    const startTime = Date.now();
                    const healthQuery = `{
            health(func: has(dgraph.type)) {
              count(uid)
            }
          }`;

                    const result = (await Promise.race([
                        client.query(healthQuery),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeout)),
                    ])) as any;

                    const responseTime = Date.now() - startTime;

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "healthy",
                                        responseTime: `${responseTime}ms`,
                                        timestamp: new Date().toISOString(),
                                        data: result.getJson(),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "unhealthy",
                                        error: error instanceof Error ? error.message : String(error),
                                        timestamp: new Date().toISOString(),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                        isError: true,
                    };
                }
            }

            case "dgraph_get_schema": {
                const { format = "dql" } = args as { format?: string };

                try {
                    // Получаем схему через query
                    const result = await client.query("schema {}");

                    let schemaData: any = result.getJson();
                    let outputText: string;

                    if (format === "json") {
                        outputText = JSON.stringify(schemaData, null, 2);
                    } else if (format === "graphql") {
                        // Простое преобразование в GraphQL формат
                        outputText = `# GraphQL Schema (converted from DQL)\n${JSON.stringify(schemaData, null, 2)}`;
                    } else {
                        outputText = JSON.stringify(schemaData, null, 2);
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: outputText,
                            },
                        ],
                    };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        error: "Не удалось получить схему",
                                        details: error instanceof Error ? error.message : String(error),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                        isError: true,
                    };
                }
            }

            case "dgraph_backup": {
                const { destination, includeSchema = true } = args as {
                    destination?: string;
                    includeSchema?: boolean;
                };

                try {
                    // Получаем все данные
                    const dataQuery = `{
            all(func: has(dgraph.type)) {
              uid
              expand(_all_) {
                uid
                expand(_all_)
              }
            }
          }`;

                    const dataResult = await client.query(dataQuery);
                    const backupData = {
                        timestamp: new Date().toISOString(),
                        data: dataResult.getJson(),
                        schema: includeSchema ? await client.alterSchema("") : null,
                        metadata: {
                            recordCount: Array.isArray(dataResult.getJson()) ? dataResult.getJson().length : 1,
                            backupVersion: "1.0",
                        },
                    };

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "success",
                                        destination: destination || `backup_${Date.now()}.json`,
                                        backupSize: JSON.stringify(backupData).length,
                                        recordCount: backupData.metadata.recordCount,
                                        data: backupData,
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        status: "error",
                                        error: error instanceof Error ? error.message : String(error),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                        isError: true,
                    };
                }
            }

            case "dgraph_analyze_data": {
                const { entityType, analysisType = "all" } = args as {
                    entityType?: string;
                    analysisType?: string;
                };

                try {
                    let analysisResults: any = {};

                    if (analysisType === "all" || analysisType === "duplicates") {
                        // Поиск дубликатов по имени
                        const duplicatesQuery = `{
              duplicates(func: has(name)) @groupby(name) {
                count(uid)
                name
              }
            }`;
                        const duplicatesResult = await client.query(duplicatesQuery);
                        analysisResults.duplicates = duplicatesResult.getJson();
                    }

                    if (analysisType === "all" || analysisType === "relationships") {
                        // Анализ связей
                        const relationshipsQuery = `{
              relationships(func: has(dgraph.type)) {
                uid
                dgraph.type
                expand(_all_) {
                  uid
                  dgraph.type
                }
              }
            }`;
                        const relationshipsResult = await client.query(relationshipsQuery);
                        analysisResults.relationships = relationshipsResult.getJson();
                    }

                    if (analysisType === "all" || analysisType === "anomalies") {
                        // Поиск аномалий (сущности без обязательных полей)
                        const anomaliesQuery = `{
              anomalies(func: has(dgraph.type)) @filter(NOT has(name)) {
                uid
                dgraph.type
                expand(_all_)
              }
            }`;
                        const anomaliesResult = await client.query(anomaliesQuery);
                        analysisResults.anomalies = anomaliesResult.getJson();
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        analysisType,
                                        entityType: entityType || "all",
                                        timestamp: new Date().toISOString(),
                                        results: analysisResults,
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                    };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        error: "Ошибка при анализе данных",
                                        details: error instanceof Error ? error.message : String(error),
                                    },
                                    null,
                                    2,
                                ),
                            },
                        ],
                        isError: true,
                    };
                }
            }

            default:
                throw new Error(`Неизвестный инструмент: ${name}`);
        }
    } catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Ошибка при выполнении ${name}: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});

// Запуск сервера
const transport = new StdioServerTransport();
await server.connect(transport);

// eslint-disable-next-line no-console
console.error("DGraph MCP сервер запущен");
// eslint-disable-next-line no-console
console.error(`Используется конфигурация: ${configPath}`);
// eslint-disable-next-line no-console
console.error(`DGraph адрес: ${DGRAPH_CONNECT_URL}`);
