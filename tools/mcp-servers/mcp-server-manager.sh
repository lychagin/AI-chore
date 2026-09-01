#!/bin/bash

# Скрипт для управления MCP сервером
# Использование: ./mcp-server-manager.sh {start|stop|status}

MCP_SERVER_PID_FILE="/tmp/mcp-dgraph-server.pid"
MCP_SERVER_LOG_FILE="/tmp/mcp-dgraph-server.log"
MCP_SERVER_PATH="$(pwd)/infrastructure/mcp-dgraph-server/dist/index.js"

# Функция для запуска MCP сервера
start_mcp_server() {
    echo "🚀 Запуск MCP сервера..."
    
    # Проверяем, не запущен ли уже сервер
    if [ -f "$MCP_SERVER_PID_FILE" ]; then
        PID=$(cat "$MCP_SERVER_PID_FILE")
        if ps -p $PID > /dev/null 2>&1; then
            echo "⚠️  MCP сервер уже запущен (PID: $PID)"
            return 0
        else
            echo "🧹 Удаляем устаревший PID файл..."
            rm -f "$MCP_SERVER_PID_FILE"
        fi
    fi
    
    # Проверяем, что файл сервера существует
    if [ ! -f "$MCP_SERVER_PATH" ]; then
        echo "❌ MCP сервер не найден: $MCP_SERVER_PATH"
        echo "💡 Выполните: npm run mcp:build"
        return 1
    fi
    
    # MCP сервер работает в интерактивном режиме, поэтому просто проверяем что файл существует
    if [ -f "$MCP_SERVER_PATH" ]; then
        echo "✅ MCP сервер готов к работе"
        echo "📝 Путь к серверу: $MCP_SERVER_PATH"
        echo "💡 MCP сервер запуститься Cursor-ом автоматически при использовании MCP инструментов"
    else
        echo "❌ MCP сервер не найден: $MCP_SERVER_PATH"
        echo "💡 Выполните: npm run mcp:build"
        return 1
    fi
}

# Функция для остановки MCP сервера
stop_mcp_server() {
    echo "🛑 Остановка MCP сервера..."
    echo "ℹ️  MCP сервер работает в интерактивном режиме"
    echo "💡 Cursor автоматически останавливает MCP сервер при закрытии"
    echo "💡 Для принудительной остановки закройте Cursor"
}

# Функция для проверки статуса MCP сервера
status_mcp_server() {
    if [ -f "$MCP_SERVER_PATH" ]; then
        echo "✅ MCP сервер готов к работе"
        echo "📝 Путь к серверу: $MCP_SERVER_PATH"
        echo "💡 MCP сервер запускается Cursor автоматически при использовании MCP инструментов"
        return 0
    else
        echo "❌ MCP сервер не собран"
        echo "💡 Выполните: npm run mcp:build"
        return 1
    fi
}

# Основная логика
case "$1" in
    start)
        start_mcp_server
        ;;
    stop)
        stop_mcp_server
        ;;
    status)
        status_mcp_server
        ;;
    restart)
        stop_mcp_server
        sleep 2
        start_mcp_server
        ;;
    *)
        echo "Использование: $0 {start|stop|status|restart}"
        echo ""
        echo "Команды:"
        echo "  start   - Запустить MCP сервер"
        echo "  stop    - Остановить MCP сервер"
        echo "  status  - Проверить статус MCP сервера"
        echo "  restart - Перезапустить MCP сервер"
        exit 1
        ;;
esac
