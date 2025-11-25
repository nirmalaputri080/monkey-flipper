/**
 * ПРИМЕР: Как использовать вступительное видео
 */

const { showIntroVideo, showIntroAnimation, bot } = require('./telegram-stars-real');

// Конфигурация
const GAME_URL = process.env.GAME_URL || 'https://your-game.com';
const INTRO_VIDEO = './assets/intro.mp4'; // Локальный файл
// или
// const INTRO_VIDEO = 'https://your-cdn.com/intro.mp4'; // URL

/**
 * ВАРИАНТ 1: Показать видео при команде /start
 */
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    
    console.log(`🎮 Новый пользователь: ${username} (${userId})`);
    
    // Показываем вступительное видео
    await showIntroVideo(userId, INTRO_VIDEO, GAME_URL);
});

/**
 * ВАРИАНТ 2: Показать анимацию (GIF) - более легковесный вариант
 */
bot.onText(/\/play/, async (msg) => {
    const userId = msg.from.id;
    
    // Показываем анимированный GIF
    await showIntroAnimation(userId, './assets/intro.gif', GAME_URL);
});

/**
 * ВАРИАНТ 3: Показать видео только первый раз
 */
const firstTimeUsers = new Set();

bot.onText(/\/game/, async (msg) => {
    const userId = msg.from.id;
    
    if (!firstTimeUsers.has(userId)) {
        // Первый запуск - показываем видео
        await showIntroVideo(userId, INTRO_VIDEO, GAME_URL);
        firstTimeUsers.add(userId);
    } else {
        // Повторный запуск - сразу кнопка игры
        await bot.sendMessage(userId, '🎮 С возвращением!', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🎮 Начать игру', web_app: { url: GAME_URL } }
                ]]
            }
        });
    }
});

/**
 * ВАРИАНТ 4: С проверкой в базе данных
 */
async function checkFirstTime(userId) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    
    try {
        const result = await pool.query(
            'SELECT intro_seen FROM users WHERE telegram_id = $1',
            [userId]
        );
        
        if (result.rows.length === 0 || !result.rows[0].intro_seen) {
            // Первый раз - показываем видео
            await showIntroVideo(userId, INTRO_VIDEO, GAME_URL);
            
            // Отмечаем в БД
            await pool.query(
                `INSERT INTO users (telegram_id, intro_seen, created_at) 
                 VALUES ($1, true, NOW())
                 ON CONFLICT (telegram_id) 
                 DO UPDATE SET intro_seen = true`,
                [userId]
            );
        } else {
            // Уже видел - сразу запускаем игру
            await bot.sendMessage(userId, '🎮 Играть!', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🎮 Начать игру', web_app: { url: GAME_URL } }
                    ]]
                }
            });
        }
    } catch (error) {
        console.error('❌ Ошибка проверки пользователя:', error);
    }
}

// Запуск бота
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error);
});

console.log('✅ Бот запущен с поддержкой вступительного видео');

// Экспорт для использования в других файлах
module.exports = { checkFirstTime };
