/**
 * НАСТОЯЩИЕ TELEGRAM STARS INTEGRATION
 * Документация: https://core.telegram.org/bots/payments-stars
 */

const TelegramBot = require('node-telegram-bot-api');

// Инициализация бота с токеном
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

/**
 * Создать инвойс для оплаты Telegram Stars
 * @param {number} userId - Telegram User ID
 * @param {string} itemName - Название товара
 * @param {string} itemDescription - Описание
 * @param {number} starsAmount - Сумма в Stars (XTR)
 * @returns {Promise<string>} - Invoice URL
 */
async function createStarsInvoice(userId, itemName, itemDescription, starsAmount) {
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

module.exports = {
    createStarsInvoice,
    setupPaymentHandler,
    addItemToInventory,
    getStarsBalance,
    withdrawStars,
    bot
};
