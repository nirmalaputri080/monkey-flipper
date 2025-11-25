#!/bin/bash

# 🧪 Тест Telegram Stars API

echo "🧪 Тестирование Telegram Stars..."
echo ""

# Замените на ваши данные
USER_ID="123456789"
API_URL="http://localhost:3001"

echo "📦 1. Создание инвойса для покупки..."
curl -X POST ${API_URL}/api/shop/create-stars-invoice \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d "{
    \"userId\": \"${USER_ID}\",
    \"itemId\": \"golden_monkey\"
  }"

echo ""
echo ""

echo "💰 2. Проверка баланса Stars бота..."
curl ${API_URL}/api/stars/balance

echo ""
echo ""
echo "✅ Тест завершен!"
