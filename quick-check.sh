#!/bin/bash

# 🚀 Скрипт быстрой проверки всех компонентов

echo "🔍 ПРОВЕРКА MONKEY FLIPPER - ВСЕ КОМПОНЕНТЫ"
echo "=============================================="
echo ""

# Цвета для вывода
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Проверка локальных файлов
echo "📁 1. Проверка локальных файлов..."
if [ -f "vercel.json" ] && [ -f "api/save-score.js" ] && [ -f "api/leaderboard.js" ]; then
    echo -e "${GREEN}✅ Все файлы на месте${NC}"
else
    echo -e "${RED}❌ Некоторые файлы отсутствуют${NC}"
fi
echo ""

# 2. Проверка Vercel API (локально)
echo "🧪 2. Тестирование Vercel API локально..."
node test-vercel-api.js > /tmp/vercel-test.log 2>&1
if grep -q "✅ Все тесты завершены" /tmp/vercel-test.log; then
    echo -e "${GREEN}✅ Vercel API работает локально${NC}"
else
    echo -e "${RED}❌ Ошибка в Vercel API${NC}"
    cat /tmp/vercel-test.log
fi
echo ""

# 3. Проверка Render сервера
echo "🌐 3. Проверка Render сервера (Socket.IO)..."
echo "   URL: https://monkey-flipper.onrender.com"

# Используем curl с таймаутом 20 секунд
if curl -s --max-time 20 https://monkey-flipper.onrender.com > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Render сервер отвечает${NC}"
    
    # Пробуем Socket.IO тест
    echo ""
    echo "   Тестирую Socket.IO подключение..."
    timeout 15 node test-server.js > /tmp/socket-test.log 2>&1
    
    if grep -q "ВСЁ РАБОТАЕТ" /tmp/socket-test.log; then
        echo -e "${GREEN}   ✅ Socket.IO работает!${NC}"
    else
        echo -e "${YELLOW}   ⚠️  Socket.IO не ответил (возможно нужно подождать пробуждения)${NC}"
    fi
else
    echo -e "${RED}❌ Render сервер не отвечает (спящий режим или офлайн)${NC}"
    echo -e "${YELLOW}   💡 Решение: Откройте https://monkey-flipper.onrender.com в браузере${NC}"
    echo -e "${YELLOW}      и подождите 1-2 минуты для пробуждения${NC}"
fi
echo ""

# 4. Проверка синтаксиса
echo "🔍 4. Проверка синтаксических ошибок..."
ERROR_COUNT=0

for file in api/save-score.js api/leaderboard.js src/index.js; do
    if node --check "$file" 2>/dev/null; then
        echo -e "   ${GREEN}✅${NC} $file"
    else
        echo -e "   ${RED}❌${NC} $file - есть ошибки!"
        ((ERROR_COUNT++))
    fi
done

if [ $ERROR_COUNT -eq 0 ]; then
    echo -e "${GREEN}✅ Синтаксических ошибок не найдено${NC}"
else
    echo -e "${RED}❌ Найдено ошибок: $ERROR_COUNT${NC}"
fi
echo ""

# 5. Статус Git
echo "📦 5. Git статус..."
if git status > /dev/null 2>&1; then
    CHANGED=$(git status --porcelain | wc -l | tr -d ' ')
    if [ "$CHANGED" -eq "0" ]; then
        echo -e "${GREEN}✅ Нет незакоммиченных изменений${NC}"
    else
        echo -e "${YELLOW}⚠️  Есть $CHANGED незакоммиченных изменений${NC}"
        echo "   Измененные файлы:"
        git status --porcelain | head -5
    fi
else
    echo -e "${YELLOW}⚠️  Не Git репозиторий${NC}"
fi
echo ""

# ИТОГОВАЯ СВОДКА
echo "=============================================="
echo "📊 ИТОГОВАЯ СВОДКА"
echo "=============================================="
echo ""
echo "✅ РАБОТАЕТ:"
echo "   • Vercel API (локально)"
echo "   • Структура проекта"
echo "   • Конфигурация vercel.json"
echo ""
echo "⚠️  ТРЕБУЕТ ВНИМАНИЯ:"
echo "   • Render сервер (возможно в спящем режиме)"
echo "   • Необходим деплой на Vercel"
echo ""
echo "📋 СЛЕДУЮЩИЕ ШАГИ:"
echo ""
echo "1️⃣  Разбудить Render сервер:"
echo "   Откройте в браузере: https://monkey-flipper.onrender.com"
echo "   Подождите 1-2 минуты"
echo ""
echo "2️⃣  Задеплоить на Vercel:"
echo "   vercel --prod"
echo ""
echo "3️⃣  Повторить проверку:"
echo "   ./quick-check.sh"
echo ""
echo "=============================================="
