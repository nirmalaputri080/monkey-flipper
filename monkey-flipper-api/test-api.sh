#!/bin/bash

# 🧪 STARS Integration API Test Script
# Простой скрипт для проверки всех STARS endpoints

API_URL="${API_URL:-http://localhost:3001}"
TEST_USER_ID="test_user_12345"

echo "🧪 Тестирование STARS Integration API"
echo "API URL: $API_URL"
echo "========================================"
echo ""

# Цвета для вывода
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Функция для проверки ответа
check_response() {
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ PASS${NC}"
    else
        echo -e "${RED}❌ FAIL${NC}"
    fi
    echo ""
}

# 1. Проверка каталога магазина
echo -e "${YELLOW}1. GET /api/shop/catalog${NC}"
curl -s "$API_URL/api/shop/catalog" | jq '.success' > /dev/null
check_response

# 2. Проверка категории скинов
echo -e "${YELLOW}2. GET /api/shop/catalog?category=skins${NC}"
curl -s "$API_URL/api/shop/catalog?category=skins" | jq '.items | length' > /dev/null
check_response

# 3. Проверка категории NFT
echo -e "${YELLOW}3. GET /api/shop/catalog?category=nft_characters${NC}"
curl -s "$API_URL/api/shop/catalog?category=nft_characters" | jq '.items | length' > /dev/null
check_response

# 4. Проверка категории бустов
echo -e "${YELLOW}4. GET /api/shop/catalog?category=boosts${NC}"
curl -s "$API_URL/api/shop/catalog?category=boosts" | jq '.items | length' > /dev/null
check_response

# 5. Получить информацию о конкретном товаре
echo -e "${YELLOW}5. GET /api/shop/item/skin_golden_monkey${NC}"
curl -s "$API_URL/api/shop/item/skin_golden_monkey" | jq '.success' > /dev/null
check_response

# 6. Получить кошелек пользователя
echo -e "${YELLOW}6. GET /api/wallet/$TEST_USER_ID${NC}"
curl -s "$API_URL/api/wallet/$TEST_USER_ID" | jq '.success' > /dev/null
check_response

# 7. Получить информацию о STARS кошельке
echo -e "${YELLOW}7. GET /api/wallet/stars-info/$TEST_USER_ID${NC}"
curl -s "$API_URL/api/wallet/stars-info/$TEST_USER_ID" | jq '.success' > /dev/null
check_response

# 8. Получить таблицу лидеров
echo -e "${YELLOW}8. GET /api/leaderboard${NC}"
curl -s "$API_URL/api/leaderboard" | jq '.success' > /dev/null
check_response

# 9. Проверка структуры БД (debug endpoint)
echo -e "${YELLOW}9. GET /api/debug/tables${NC}"
curl -s "$API_URL/api/debug/tables" | jq '.tables | length' > /dev/null
check_response

# 10. Получить транзакции пользователя
echo -e "${YELLOW}10. GET /api/transactions/$TEST_USER_ID${NC}"
curl -s "$API_URL/api/transactions/$TEST_USER_ID" | jq '.success' > /dev/null
check_response

echo "========================================"
echo -e "${GREEN}✅ Все базовые GET endpoints проверены!${NC}"
echo ""
echo "📝 Примечание: POST endpoints требуют валидные данные и подписи"
echo "   Для их тестирования используйте test-stars-client.html"
echo ""
