/**
 * НАСТОЯЩИЕ TELEGRAM STARS INTEGRATION
 * Документация: https://core.telegram.org/bots/payments-stars
 */

require('dotenv').config(); // Загружаем переменные окружения
const TelegramBot = require('node-telegram-bot-api');

// Инициализация бота с токеном
// polling включается автоматически если есть BOT_TOKEN (можно отключить через ENABLE_BOT_POLLING=false)
const botToken = process.env.BOT_TOKEN || '';
const enablePolling = process.env.ENABLE_BOT_POLLING !== 'false' && !!botToken;

console.log('🔍 Telegram Bot Config:', {
  hasToken: !!botToken,
  tokenPreview: botToken ? `${botToken.substring(0, 10)}...` : 'none',
  enablePolling
});

const bot = botToken 
  ? new TelegramBot(botToken, { polling: enablePolling })
  : null;

/**
 * Создать инвойс для оплаты Telegram Stars (для WebApp)
 * @param {number} userId - Telegram User ID
 * @param {string} itemName - Название товара
 * @param {string} itemDescription - Описание
 * @param {number} starsAmount - Сумма в Stars (XTR)
 * @returns {Promise<string>} - Invoice Link URL
 */
async function createStarsInvoice(userId, itemName, itemDescription, starsAmount) {
    if (!bot) {
        throw new Error('Telegram Bot не инициализирован');
    }
    
    try {
        // Создаем ССЫЛКУ на инвойс (не отправляем сообщение!)
        // Это правильный способ для WebApp/Mini App
        const invoiceLink = await bot.createInvoiceLink(
            itemName,                    // title
            itemDescription,             // description
            `purchase_${userId}_${Date.now()}`, // payload (с userId для идентификации)
            '',                          // provider_token (пусто для Stars)
            'XTR',                       // currency (Telegram Stars)
            [{ label: itemName, amount: starsAmount }] // prices
        );

        console.log(`✅ Инвойс-ссылка создана: ${invoiceLink}`);
        console.log(`   Stars: ${starsAmount}, Item: "${itemName}", User: ${userId}`);
        
        // invoiceLink имеет формат: https://t.me/$INVOICE_SLUG
        // tg.openInvoice() принимает полный URL
        return invoiceLink;

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
        
        console.log(`✅ Оплата Stars успешна!`);
        console.log(`   User: ${userId}`);
        console.log(`   Amount: ${payment.total_amount} XTR`);
        console.log(`   Payload: ${payment.invoice_payload}`);
        
        // Выдать товар пользователю в БД
        try {
            const item = await addItemToInventory(userId, payment.invoice_payload, payment.total_amount);
            
            // Отправить подтверждение
            await bot.sendMessage(userId, 
                `🎉 Покупка успешна!\n\n` +
                `📦 ${item.name}\n` +
                `💫 Оплачено: ${payment.total_amount} ⭐\n\n` +
                `Товар добавлен в ваш инвентарь!`
            );
            
        } catch (error) {
            console.error('❌ Ошибка выдачи товара:', error);
            await bot.sendMessage(userId, 
                `⚠️ Оплата прошла, но возникла ошибка при выдаче товара.\n` +
                `Payload: ${payment.invoice_payload}\n` +
                `Сумма: ${payment.total_amount} XTR\n\n` +
                `Свяжитесь с поддержкой.`
            );
        }
    });
}

/**
 * Выдать товар пользователю после оплаты Stars
 */
async function addItemToInventory(userId, payload, amount) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const fs = require('fs');
    const crypto = require('crypto');
    
    try {
        // payload имеет формат: purchase_USERID_TIMESTAMP
        // Нам нужно найти какой товар был куплен по цене
        console.log(`🔍 Processing payment: userId=${userId}, payload=${payload}, amount=${amount}`);
        
        // Загружаем товары чтобы найти по цене
        const shopItems = JSON.parse(fs.readFileSync('./shop-items.json', 'utf8'));
        const allItems = [...shopItems.skins, ...shopItems.nft_characters, ...shopItems.boosts];
        
        // Ищем товар по цене в Stars (amount)
        const item = allItems.find(i => i.priceXTR === amount);
        
        if (!item) {
            console.error(`❌ Товар с ценой ${amount} XTR не найден`);
            throw new Error(`Item with price ${amount} XTR not found`);
        }
        
        const purchaseId = crypto.randomUUID();
        
        // Добавляем покупку в БД
        await pool.query(`
            INSERT INTO purchases (id, user_id, item_id, item_name, price, currency, status, purchased_at)
            VALUES ($1, $2, $3, $4, $5, 'XTR', 'active', NOW())
        `, [purchaseId, userId, item.id, item.name, amount]);
        
        console.log(`✅ Товар "${item.name}" (${item.id}) добавлен пользователю ${userId}`);
        
        return item;
        
    } catch (error) {
        console.error('❌ Ошибка добавления товара:', error);
        throw error;
    } finally {
        await pool.end();
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
