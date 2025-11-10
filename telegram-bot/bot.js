// Простой Telegram бот для автоматического запуска Web App
const TelegramBot = require('node-telegram-bot-api');

// Замените на ваш токен бота
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://monkey-flipper.vercel.app';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Обработка команды /start
bot.onText(/\/start(.*)/, (msg, match) => {
  const chatId = msg.chat.id;
  const startParam = match[1].trim(); // Параметр после /start
  
  console.log('📩 Получена команда /start');
  console.log('   Chat ID:', chatId);
  console.log('   Параметр:', startParam);
  
  // Формируем URL для Web App
  let webAppUrl = WEB_APP_URL;
  
  // Если есть параметр (например, duel_123), добавляем его в URL
  if (startParam && startParam.startsWith('duel_')) {
    webAppUrl = `${WEB_APP_URL}?matchId=${startParam}`;
    console.log('   🎮 Duel link detected:', startParam);
  }
  
  // Отправляем сообщение с кнопкой Web App
  bot.sendMessage(chatId, '🐵 Welcome to Crypto Monkey!\n\nClick the button below to start playing:', {
    reply_markup: {
      inline_keyboard: [[
        {
          text: '🎮 Play Game',
          web_app: { url: webAppUrl }
        }
      ]]
    }
  });
});

// Обработка текстовых сообщений
bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, '👋 Use /start to play Crypto Monkey!');
  }
});

console.log('🤖 Bot started!');
console.log('   Bot token:', BOT_TOKEN.substring(0, 10) + '...');
console.log('   Web App URL:', WEB_APP_URL);
