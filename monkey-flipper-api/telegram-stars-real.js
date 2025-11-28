/**
 * НАСТОЯЩИЕ TELEGRAM STARS INTEGRATION
 * Документация: https://core.telegram.org/bots/payments-stars
 * 
 * Используем WEBHOOK вместо POLLING - более надёжно для production
 */

require('dotenv').config(); // Загружаем переменные окружения
const TelegramBot = require('node-telegram-bot-api');

// Инициализация бота с токеном
const botToken = process.env.BOT_TOKEN || '';
const webhookUrl = process.env.WEBHOOK_URL || 'https://monkey-flipper-djm1.onrender.com';

console.log('🔍 Telegram Bot Config:', {
  hasToken: !!botToken,
  tokenPreview: botToken ? `${botToken.substring(0, 10)}...` : 'none',
  mode: 'WEBHOOK',
  webhookUrl: webhookUrl
});

let bot = null;

if (botToken) {
  // Создаём бота БЕЗ polling - будем использовать webhook
  bot = new TelegramBot(botToken, { polling: false });
  
  // Устанавливаем webhook при старте
  const webhookPath = '/telegram-webhook';
  const fullWebhookUrl = `${webhookUrl}${webhookPath}`;
  
  bot.setWebHook(fullWebhookUrl)
    .then(() => {
      console.log(`✅ Webhook установлен: ${fullWebhookUrl}`);
    })
    .catch(err => {
      console.error('❌ Ошибка установки webhook:', err.message);
    });
}

/**
 * Создать инвойс для оплаты Telegram Stars (для WebApp)
 * @param {number} userId - Telegram User ID
 * @param {string} itemName - Название товара
 * @param {string} itemDescription - Описание
 * @param {number} starsAmount - Сумма в Stars (XTR)
 * @param {string} itemId - ID товара для идентификации
 * @returns {Promise<string>} - Invoice Link URL
 */
async function createStarsInvoice(userId, itemName, itemDescription, starsAmount, itemId = null) {
    if (!bot) {
        throw new Error('Telegram Bot не инициализирован');
    }
    
    try {
        // Payload с userId И itemId для точной идентификации товара
        const payload = itemId 
            ? `purchase_${userId}_${itemId}_${Date.now()}`
            : `purchase_${userId}_${Date.now()}`;
        
        // Создаем ССЫЛКУ на инвойс (не отправляем сообщение!)
        // Это правильный способ для WebApp/Mini App
        const invoiceLink = await bot.createInvoiceLink(
            itemName,                    // title
            itemDescription,             // description
            payload,                     // payload (с userId и itemId для идентификации)
            '',                          // provider_token (пусто для Stars)
            'XTR',                       // currency (Telegram Stars)
            [{ label: itemName, amount: starsAmount }] // prices
        );

        console.log(`✅ Инвойс-ссылка создана: ${invoiceLink}`);
        console.log(`   Stars: ${starsAmount}, Item: "${itemName}" (${itemId}), User: ${userId}`);
        console.log(`   Payload: ${payload}`);
        
        // invoiceLink имеет формат: https://t.me/$INVOICE_SLUG
        // tg.openInvoice() принимает полный URL
        return invoiceLink;

    } catch (error) {
        console.error('❌ Ошибка создания инвойса:', error);
        throw error;
    }
}

/**
 * Обработчик платежей через WEBHOOK
 * Добавляет endpoint /telegram-webhook для приёма обновлений от Telegram
 */
function setupPaymentHandler(server) {
    if (!bot) {
        console.warn('⚠️ Telegram Bot не инициализирован (BOT_TOKEN не установлен)');
        return;
    }
    
    // Webhook endpoint - Telegram будет слать сюда обновления
    server.post('/telegram-webhook', async (req, res) => {
        try {
            const update = req.body;
            
            console.log('📩 Webhook update received:', JSON.stringify(update).substring(0, 200));
            
            // Обработка pre_checkout_query
            if (update.pre_checkout_query) {
                const query = update.pre_checkout_query;
                console.log('💰 Pre-checkout via webhook:', query);
                
                try {
                    await bot.answerPreCheckoutQuery(query.id, true);
                    console.log('✅ Pre-checkout confirmed');
                } catch (err) {
                    console.error('❌ Pre-checkout error:', err.message);
                }
            }
            
            // Обработка successful_payment (приходит внутри message)
            if (update.message && update.message.successful_payment) {
                const msg = update.message;
                const payment = msg.successful_payment;
                const userId = msg.from.id;
                
                console.log(`✅ Оплата Stars успешна (webhook)!`);
                console.log(`   User: ${userId}`);
                console.log(`   Amount: ${payment.total_amount} XTR`);
                console.log(`   Payload: ${payment.invoice_payload}`);
                console.log(`   Charge ID: ${payment.telegram_payment_charge_id}`);
                
                // Выдать товар пользователю в БД
                try {
                    const item = await addItemToInventory(
                        userId, 
                        payment.invoice_payload, 
                        payment.total_amount,
                        payment.telegram_payment_charge_id
                    );
                    
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
            }
            
            // Всегда отвечаем 200 OK чтобы Telegram не пытался повторить
            res.sendStatus(200);
            
        } catch (error) {
            console.error('❌ Webhook processing error:', error);
            res.sendStatus(200); // Всё равно отвечаем OK
        }
    });
    
    console.log('✅ Webhook handler registered at /telegram-webhook');
}

/**
 * Выдать товар пользователю после оплаты Stars
 */
async function addItemToInventory(userId, payload, amount, chargeId = null) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const fs = require('fs');
    const crypto = require('crypto');
    
    try {
        // payload имеет формат: purchase_USERID_ITEMID_TIMESTAMP или purchase_USERID_TIMESTAMP (старый)
        console.log(`🔍 Processing payment: userId=${userId}, payload=${payload}, amount=${amount}, chargeId=${chargeId}`);
        
        // Парсим payload для извлечения itemId
        const payloadParts = payload.split('_');
        let itemId = null;
        
        // Новый формат: purchase_USERID_ITEMID_TIMESTAMP (4+ частей, itemId не является числом)
        if (payloadParts.length >= 4 && isNaN(payloadParts[2])) {
            // Собираем itemId (может содержать _ в названии)
            // Формат: purchase_702659927_skin_ninja_monkey_1234567890
            const timestampIndex = payloadParts.length - 1;
            itemId = payloadParts.slice(2, timestampIndex).join('_');
            console.log(`📦 Parsed itemId from payload: ${itemId}`);
        }
        
        // Загружаем товары
        const shopItems = JSON.parse(fs.readFileSync('./shop-items.json', 'utf8'));
        const allItems = [...shopItems.skins, ...shopItems.nft_characters, ...shopItems.boosts];
        
        let item;
        
        // Сначала ищем по itemId (если есть)
        if (itemId) {
            item = allItems.find(i => i.id === itemId);
            if (item) {
                console.log(`✅ Found item by ID: ${item.name} (${item.id})`);
            }
        }
        
        // Если не нашли по ID, ищем по цене (fallback для старых платежей)
        if (!item) {
            item = allItems.find(i => i.priceXTR === amount);
            if (item) {
                console.log(`⚠️ Found item by price fallback: ${item.name} (${amount} XTR)`);
            }
        }
        
        if (!item) {
            console.error(`❌ Товар не найден: itemId=${itemId}, amount=${amount} XTR`);
            throw new Error(`Item not found: itemId=${itemId}, price=${amount} XTR`);
        }
        
        const purchaseId = crypto.randomUUID();
        
        // Добавляем покупку в БД (без charge_id - колонки нет в таблице)
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
 * Получить транзакции Stars напрямую через Telegram API
 */
async function fetchStarTransactions() {
    try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getStarTransactions`);
        const data = await response.json();
        
        if (data.ok) {
            return data.result.transactions || [];
        }
        return [];
    } catch (error) {
        console.error('❌ Ошибка получения транзакций:', error);
        return [];
    }
}

/**
 * Проверка баланса Stars у бота (сколько заработали)
 */
async function getStarsBalance() {
    try {
        const transactions = await fetchStarTransactions();
        
        let totalEarned = 0;
        transactions.forEach(tx => {
            if (tx.source && tx.source.type === 'user') {
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
 * Получить список транзакций Stars
 */
async function getStarsTransactions() {
    try {
        return await fetchStarTransactions();
    } catch (error) {
        console.error('❌ Ошибка получения транзакций:', error);
        return [];
    }
}

/**
 * Сделать возврат Stars пользователю
 * @param {number} userId - Telegram User ID
 * @param {string} telegramPaymentChargeId - ID транзакции из successful_payment
 */
async function refundStarsPayment(userId, telegramPaymentChargeId) {
    if (!bot) {
        throw new Error('Telegram Bot не инициализирован');
    }
    
    try {
        console.log(`💸 Возврат Stars: user=${userId}, chargeId=${telegramPaymentChargeId}`);
        
        await bot.refundStarPayment(userId, telegramPaymentChargeId);
        
        console.log(`✅ Возврат Stars успешен для пользователя ${userId}`);
        return true;
        
    } catch (error) {
        console.error('❌ Ошибка возврата Stars:', error);
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
    getStarsTransactions,
    refundStarsPayment,
    showIntroVideo,
    showIntroAnimation,
    bot
};
