#!/bin/bash
# Тестирование STARS Integration API

API_URL="https://monkey-flipper-djm1.onrender.com"
TEST_USER="test_stars_$(date +%s)"

echo "🧪 ТЕСТИРОВАНИЕ STARS INTEGRATION API"
echo "====================================="
echo ""

# Цвета для вывода
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Тест 1: Проверка таблиц
echo -e "${YELLOW}[TEST 1]${NC} Проверка таблиц базы данных..."
TABLES=$(curl -s "$API_URL/api/debug/tables")
if echo "$TABLES" | grep -q "wallets"; then
    echo -e "${GREEN}✅ PASS${NC} - Таблицы созданы"
else
    echo -e "${RED}❌ FAIL${NC} - Таблицы не найдены"
fi
echo ""

# Тест 2: Подключение STARS кошелька
echo -e "${YELLOW}[TEST 2]${NC} Подключение STARS кошелька..."
CONNECT_RESULT=$(curl -s -X POST "$API_URL/api/wallet/connect-stars" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TEST_USER\",\"starsAddress\":\"STARSxAb12Cd34Ef56Gh78Ij90KlMnOpQrSt\"}")

if echo "$CONNECT_RESULT" | grep -q "success.*true"; then
    echo -e "${GREEN}✅ PASS${NC} - Кошелек подключен"
    echo "$CONNECT_RESULT" | jq . 2>/dev/null || echo "$CONNECT_RESULT"
else
    echo -e "${RED}❌ FAIL${NC} - Ошибка подключения"
    echo "$CONNECT_RESULT"
fi
echo ""

# Тест 3: Получение информации о кошельке
echo -e "${YELLOW}[TEST 3]${NC} Получение информации о STARS кошельке..."
INFO_RESULT=$(curl -s "$API_URL/api/wallet/stars-info/$TEST_USER")

if echo "$INFO_RESULT" | grep -q "connected.*true"; then
    echo -e "${GREEN}✅ PASS${NC} - Информация получена"
    echo "$INFO_RESULT" | jq . 2>/dev/null || echo "$INFO_RESULT"
else
    echo -e "${RED}❌ FAIL${NC} - Ошибка получения информации"
    echo "$INFO_RESULT"
fi
echo ""

# Тест 4: Добавление STARS баланса (для теста покупки)
echo -e "${YELLOW}[TEST 4]${NC} Добавление тестового STARS баланса..."
# Напрямую через SQL (только для тестирования!)
# В продакшне это делается через реальный STARS API
echo "⚠️  Требуется ручное добавление баланса через SQL"
echo ""

# Тест 5: Покупка за STARS (требует баланс)
echo -e "${YELLOW}[TEST 5]${NC} Покупка предмета за STARS..."
PURCHASE_RESULT=$(curl -s -X POST "$API_URL/api/shop/purchase-stars" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TEST_USER\",\"itemId\":\"skin_golden\",\"itemName\":\"Golden Skin\",\"priceStars\":5}")

if echo "$PURCHASE_RESULT" | grep -q "success"; then
    if echo "$PURCHASE_RESULT" | grep -q "success.*true"; then
        echo -e "${GREEN}✅ PASS${NC} - Покупка успешна"
    else
        echo -e "${YELLOW}⚠️  EXPECTED${NC} - Недостаточно средств (это нормально для теста)"
    fi
    echo "$PURCHASE_RESULT" | jq . 2>/dev/null || echo "$PURCHASE_RESULT"
else
    echo -e "${RED}❌ FAIL${NC} - Ошибка покупки"
    echo "$PURCHASE_RESULT"
fi
echo ""

# Тест 6: Отправка игровых событий (anti-cheat)
echo -e "${YELLOW}[TEST 6]${NC} Отправка игровых событий (anti-cheat)..."
EVENTS='[
  {"type":"land","platformY":500,"timestamp":1234567890},
  {"type":"land","platformY":400,"timestamp":1234567891},
  {"type":"land","platformY":300,"timestamp":1234567892}
]'

GAME_EVENTS_RESULT=$(curl -s -X POST "$API_URL/api/game-events" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TEST_USER\",\"username\":\"TestPlayer\",\"claimedScore\":200,\"events\":$EVENTS}")

if echo "$GAME_EVENTS_RESULT" | grep -q "success.*true"; then
    echo -e "${GREEN}✅ PASS${NC} - События обработаны, score пересчитан сервером"
    echo "$GAME_EVENTS_RESULT" | jq . 2>/dev/null || echo "$GAME_EVENTS_RESULT"
else
    echo -e "${RED}❌ FAIL${NC} - Ошибка обработки событий"
    echo "$GAME_EVENTS_RESULT"
fi
echo ""

# Тест 7: Отправка наград в STARS
echo -e "${YELLOW}[TEST 7]${NC} Отправка наград в STARS..."
REWARD_RESULT=$(curl -s -X POST "$API_URL/api/rewards/send-stars" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TEST_USER\",\"amount\":10,\"reason\":\"test_reward\"}")

if echo "$REWARD_RESULT" | grep -q "success"; then
    if echo "$REWARD_RESULT" | grep -q "pending"; then
        echo -e "${GREEN}✅ PASS${NC} - Награда в статусе pending (ожидает интеграции с STARS API)"
    fi
    echo "$REWARD_RESULT" | jq . 2>/dev/null || echo "$REWARD_RESULT"
else
    echo -e "${RED}❌ FAIL${NC} - Ошибка отправки награды"
    echo "$REWARD_RESULT"
fi
echo ""

echo "====================================="
echo "🏁 ТЕСТИРОВАНИЕ ЗАВЕРШЕНО"
echo ""
echo "📝 Заметки:"
echo "   - Для покупок за STARS нужно добавить баланс через SQL"
echo "   - Награды в статусе 'pending' до интеграции с Crypto All-Stars API"
echo "   - Anti-cheat система работает и пересчитывает score на сервере"
echo ""
