/**
 * Минимальный самодостаточный клиент DGraph.
 *
 * В исходном проекте здесь использовалась внутренняя обёртка из монорепозитория
 * (пул стабов, повторы при конфликте транзакции, кэш метаданных, свой логгер).
 * Утащить её нельзя — она тянет за собой половину общих компонентов проекта,
 * поэтому воспроизведена только та часть, которую действительно вызывает сервер:
 * конструктор, `query` и `mutate`.
 *
 * Отличия от оригинала, которые надо знать:
 *   - нет повторов при конфликте транзакции (`mutate` падает сразу);
 *   - нет кэша метаданных;
 *   - нет дедлайна на вызов — таймаут задаёт gRPC по умолчанию.
 *
 * Если такое поведение не устраивает — замени этот файл своей обёрткой,
 * сохранив сигнатуры: `index.ts` вызывает только эти три вещи.
 */

import * as dgraph from "dgraph-js";

/** Ответ DGraph в том виде, в каком его ждёт index.ts (используется только getJson). */
export type DgraphResponse = dgraph.Response;

export class DgraphClientWrapper {
    private readonly clientStubs: dgraph.DgraphClientStub[];
    private readonly dgraphClient: dgraph.DgraphClient;

    /**
     * @param alphaAddresses адреса alpha-нод, например ["localhost:9080"]
     * @param _unused        зарезервировано под логгер — оригинальная сигнатура
     * @param debug          включить отладочный вывод клиента
     */
    constructor(alphaAddresses: string[], _unused?: unknown, debug: boolean = false) {
        if (!alphaAddresses.length) {
            throw new Error("DgraphClientWrapper: список адресов alpha пуст");
        }

        const grpcOptions = {
            "grpc.max_receive_message_length": 64 * 1024 * 1024, // 64MB
            "grpc.max_send_message_length": 64 * 1024 * 1024, // 64MB
            "grpc.dns_resolver": "native",
        };

        this.clientStubs = alphaAddresses.map((address) => new dgraph.DgraphClientStub(address, undefined, grpcOptions));
        this.dgraphClient = new dgraph.DgraphClient(...this.clientStubs);
        this.dgraphClient.setDebugMode(debug);
    }

    /** Read-only запрос. Переменные передаются как в DQL: { "$name": "value" }. */
    async query(query: string, variables: Record<string, string> = {}): Promise<DgraphResponse> {
        const txn = this.dgraphClient.newTxn({ readOnly: true, bestEffort: false });
        try {
            return await txn.queryWithVars(query, variables);
        } finally {
            await txn.discard();
        }
    }

    /** Запись через setJson. Транзакция коммитится, при ошибке — откатывается. */
    async mutate(setJson: unknown): Promise<DgraphResponse> {
        const txn = this.dgraphClient.newTxn();
        try {
            const mutation = new dgraph.Mutation();
            mutation.setSetJson(setJson);
            const res = await txn.mutate(mutation);
            await txn.commit();
            return res;
        } finally {
            await txn.discard();
        }
    }

    /**
     * Удаление через deleteJson. `setJson` — необязательная сопутствующая запись
     * в той же транзакции (например, снять связь и одновременно проставить статус).
     */
    async delete(deleteJson: unknown, setJson: unknown = {}): Promise<DgraphResponse> {
        const txn = this.dgraphClient.newTxn();
        try {
            const mutation = new dgraph.Mutation();
            mutation.setSetJson(setJson);
            mutation.setDeleteJson(deleteJson);
            const res = await txn.mutate(mutation);
            await txn.commit();
            return res;
        } finally {
            await txn.discard();
        }
    }

    /**
     * Upsert: запрос + мутация в одном запросе с условием применения.
     * `conditions` — выражение вида `@if(eq(len(v), 0))`; пустая строка = без условия.
     */
    async upsert(query: string, data: unknown, conditions: string = ""): Promise<DgraphResponse> {
        const txn = this.dgraphClient.newTxn();
        try {
            const mutation = new dgraph.Mutation();
            mutation.setSetJson(data);
            mutation.setCond(conditions);

            const request = new dgraph.Request();
            request.setQuery(query);
            request.setMutationsList([mutation]);
            request.setCommitNow(true);

            return await txn.doRequest(request);
        } finally {
            await txn.discard();
        }
    }

    /**
     * Изменение схемы. Пустая строка возвращает текущее состояние, не меняя схему.
     * `runInBackground` — считать индексы в фоне (поддерживается с DGraph 20.03).
     */
    async alterSchema(schema: string, runInBackground: boolean = false): Promise<dgraph.Payload> {
        const operation = new dgraph.Operation();
        operation.setSchema(schema);
        if (runInBackground) {
            operation.setRunInBackground(true);
        }
        return await this.dgraphClient.alter(operation);
    }

    /** Закрыть соединения. Вызывать при остановке сервера. */
    close(): void {
        this.clientStubs.forEach((stub) => stub.close());
    }
}
