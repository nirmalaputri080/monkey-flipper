/**
 * НАСТОЯЩИЕ TELEGRAM STARS INTEGRATION
 * Документация: https://core.telegram.org/bots/payments-stars
 */

require('dotenv').config(); // Загружаем переменные окружения
const TelegramBot = require('node-telegram-bot-api');

// Инициализация бота с токеном
// polling будет включен только если установлен BOT_TOKEN и ENABLE_BOT_POLLING=true
const botToken = process.env.BOT_TOKEN || '';
const enablePolling = process.env.ENABLE_BOT_POLLING === 'true' && !!botToken;

console.log('🔍 Telegram Bot Config:', {
  hasToken: !!botToken,
  tokenPreview: botToken ? `${botToken.substring(0, 10)}...` : 'none',
  enablePolling
});

const bot = botToken 
  ? new TelegramBot(botToken, { polling: enablePolling })
  : null;

/**
 * Создать инвойс для оплаты Telegram Stars
 * @param {number} userId - Telegram User ID
 * @param {string} itemName - Название товара
 * @param {string} itemDescription - Описание
 * @param {number} starsAmount - Сумма в Stars (XTR)
 * @returns {Promise<string>} - Invoice URL
 */
async function createStarsInvoice(userId, itemName, itemDescription, starsAmount) {
    if (!bot) {
        throw new Error('Telegram Bot не инициализирован');
    }
    
    try {
        // Создаем инвойс для оплаты Stars
        const invoice = await bot.sendInvoice(
            userId,
            itemName,                    // title
            itemDescription,             // description
            `purchase_${Date.now()}`,    // payload (уникальный ID)
            '',                          // provider_token (пусто для Stars)
            'XTR',                       // currency (Telegram Stars)
            [{ label: itemName, amount: starsAmount }], // prices (1 Star = 1 unit)
            {
                need_name: false,
                need_phone_number: false,
                need_email: false,
                need_shipping_address: false,
                is_flexible: false
            }
        );

        console.log(`✅ Инвойс создан: ${starsAmount} Stars для товара "${itemName}"`);
        return invoice;

    } catch (error) {
        console.error('❌ Ошибка создания инвойса:', error);
        throw error;
    }
}

/**
 * Обработчик успешного платежа (webhook)
 */
function setupPaymentHandler(server) {
    if (!bot) {
        console.warn('⚠️ Telegram Bot не инициализирован (BOT_TOKEN не установлен)');
        return;
    }
    
    // Обработка pre_checkout_query (перед оплатой)
    bot.on('pre_checkout_query', async (query) => {
        console.log('💰 Pre-checkout:', query);
        
        // Подтверждаем возможность оплаты
        await bot.answerPreCheckoutQuery(query.id, true);
    });

    // Обработка successful_payment (после успешной оплаты)
    bot.on('successful_payment', async (msg) => {
        const payment = msg.successful_payment;
        const userId = msg.from.id;
        
        console.log(`✅ Оплата успешна!`);
        console.log(`   User: ${userId}`);
        console.log(`   Amount: ${payment.total_amount} XTR`);
        console.log(`   Payload: ${payment.invoice_payload}`);
        
        // ЗДЕСЬ: Выдать товар пользователю в БД
        try {
            // Например, добавить NFT в инвентарь:
            await addItemToInventory(userId, payment.invoice_payload);
            
            // Отправить подтверждение
            await bot.sendMessage(userId, 
                `🎉 Покупка успешна!\n` +
                `Товар добавлен в ваш инвентарь.`
            );
            
        } catch (error) {
            console.error('❌ Ошибка выдачи товара:', error);
            await bot.sendMessage(userId, 
                `⚠️ Оплата прошла, но возникла ошибка. ` +
                `Свяжитесь с поддержкой.`
            );
        }
    });
}

/**
 * Выдать товар пользователю после оплаты
 */
async function addItemToInventory(userId, itemId) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    
    try {
        // Добавляем покупку в БД
        await pool.query(`
            INSERT INTO purchases (user_id, item_id, currency, status, created_at)
            VALUES ($1, $2, 'telegram_stars', 'completed', NOW())
        `, [userId, itemId]);
        
        console.log(`✅ Товар ${itemId} добавлен пользователю ${userId}`);
        
    } catch (error) {
        console.error('❌ Ошибка добавления товара:', error);
        throw error;
    }
}

/**
 * Проверка баланса Stars у бота (сколько заработали)
 */
async function getStarsBalance() {
    try {
        // Получаем транзакции бота
        const transactions = await bot.getStarTransactions();
        
        let totalEarned = 0;
        transactions.forEach(tx => {
            if (tx.source.type === 'user') {
                totalEarned += tx.amount;
            }
        });
        
        console.log(`💰 Заработано Stars: ${totalEarned} XTR`);
        return totalEarned;
        
    } catch (error) {
        console.error('❌ Ошибка получения баланса:', error);
        return 0;
    }
}

/**
 * Вывести Stars с баланса бота (опционально)
 */
async function withdrawStars(recipientUserId, amount) {
    try {
        // Отправка Stars пользователю
        const result = await bot.refundStarPayment(recipientUserId, amount);
        
        console.log(`✅ Отправлено ${amount} Stars пользователю ${recipientUserId}`);
        return result;
        
    } catch (error) {
        console.error('❌ Ошибка вывода Stars:', error);
        throw error;
    }
}

/**
 * Показать вступительное видео перед запуском игры
 * @param {number} userId - Telegram User ID
 * @param {string} videoPath - Путь к видео файлу или URL
 * @param {string} gameUrl - URL игры для кнопки
 */
async function showIntroVideo(userId, videoPath, gameUrl) {
    if (!bot) {
        throw new Error('Telegram Bot не инициализирован');
    }
    
    try {
        // Отправляем видео с кнопкой запуска игры
        await bot.sendVideo(userId, videoPath, {
            caption: '🎮 Добро пожаловать в Monkey Flipper!\n\n' +
                     '🐵 Переворачивай карты и зарабатывай монеты\n' +
                     '⚔️ Сражайся с другими игроками\n' +
                     '🏆 Поднимайся в рейтинге\n\n' +
                     '👇 Нажми кнопку, чтобы начать играть!',
            reply_markup: {
                inline_keyboard: [[
                    { 
                        text: '🎮 Начать игру', 
                        web_app: { url: gameUrl } 
                    }
                ]]
            },
            supports_streaming: true  // Для плавного воспроизведения
        });
        
        console.log(`✅ Вступительное видео отправлено пользователю ${userId}`);
        return true;
        
    } catch (error) {
        console.error('❌ Ошибка отправки видео:', error);
        
        // Fallback: отправить просто кнопку без видео
        await bot.sendMessage(userId, 
            '🎮 Добро пожаловать в Monkey Flipper!\n\n' +
            '🐵 Переворачивай карты и зарабатывай монеты\n' +
            '⚔️ Сражайся с другими игроками\n' +
            '🏆 Поднимайся в рейтинге',
            {
                reply_markup: {
                    inline_keyboard: [[
                        { 
                            text: '🎮 Начать игру', 
                            web_app: { url: gameUrl } 
                        }
                    ]]
                }
            }
        );
        
        return false;
    }
}

/**
 * Показать видео с анимацией (GIF)
 * @param {number} userId - Telegram User ID
 * @param {string} animationPath - Путь к GIF файлу
 * @param {string} gameUrl - URL игры
 */
async function showIntroAnimation(userId, animationPath, gameUrl) {
    if (!bot) {
        throw new Error('Telegram Bot не инициализирован');
    }
    
    try {
        await bot.sendAnimation(userId, animationPath, {
            caption: '🎮 Готов играть? Нажми кнопку!',
            reply_markup: {
                inline_keyboard: [[
                    { 
                        text: '🎮 Начать игру', 
                        web_app: { url: gameUrl } 
                    }
                ]]
            }
        });
        
        console.log(`✅ Анимация отправлена пользователю ${userId}`);
        return true;
        
    } catch (error) {
        console.error('❌ Ошибка отправки анимации:', error);
        return false;
    }
}

module.exports = {
    createStarsInvoice,
    setupPaymentHandler,
    addItemToInventory,
    getStarsBalance,
    withdrawStars,
    showIntroVideo,
    showIntroAnimation,
    bot
};
