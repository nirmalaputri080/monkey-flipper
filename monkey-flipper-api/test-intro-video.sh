#!/bin/bash

# 🎬 Тестирование Intro Video API

echo "🧪 Тестирование Intro Video API..."
echo ""

# Замените на ваш Telegram User ID
USER_ID="123456789"

echo "📹 1. Отправка intro video пользователю..."
curl -X POST http://localhost:3001/api/send-intro-video \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\", \"videoType\": \"mp4\"}"

echo ""
echo ""

echo "✅ 2. Проверка, видел ли пользователь intro..."
curl http://localhost:3001/api/check-intro/$USER_ID

echo ""
echo ""
echo "✅ Тест завершен!"
echo ""
echo "📝 Для полного теста:"
echo "   1. Замените USER_ID на ваш Telegram ID"
echo "   2. Положите видео в assets/intro.mp4"
echo "   3. Запустите сервер: node server-api.js"
echo "   4. Запустите этот скрипт: bash test-intro-video.sh"
echo "   5. Или отправьте /start вашему боту в Telegram"
