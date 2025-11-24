/**
 * Клиентская интеграция STARS API для Telegram WebApp
 * 
 * Использование:
 * 1. Подключите в index.html: <script src="stars-integration.js"></script>
 * 2. Инициализируйте: const stars = new StarsIntegration('https://your-api.com');
 * 3. Используйте методы: await stars.connectWallet(), await stars.buyItem(itemId)
 */

class StarsIntegration {
    constructor(apiBaseUrl) {
        this.apiUrl = apiBaseUrl;
        this.userId = null;
        this.jwt = null;
        this.gameEvents = [];
        this.refreshInterval = null;
        
        // Инициализация Telegram WebApp
        if (window.Telegram?.WebApp) {
            window.Telegram.WebApp.ready();
            this.initData = window.Telegram.WebApp.initData;
            this.userId = window.Telegram.WebApp.initDataUnsafe?.user?.id;
        } else {
            console.warn('⚠️ Telegram WebApp не обнаружен');
        }
        
        // Автообновление initData каждые 30 секунд (по ТЗ)
        this.startInitDataRefresh();
    }
    
    /**
     * Автообновление Telegram initData каждые 30 секунд
     */
    startInitDataRefresh() {
        this.refreshInterval = setInterval(() => {
            if (window.Telegram?.WebApp) {
                this.initData = window.Telegram.WebApp.initData;
                console.log('🔄 initData обновлен');
            }
        }, 30000); // 30 секунд
    }
    
    /**
     * Остановка автообновления
     */
    stopInitDataRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }
    
    /**
     * Добавление игрового события для анти-чит системы
     */
    addGameEvent(eventType, data) {
        const event = {
            type: eventType,
            timestamp: Date.now(),
            data: data
        };
        this.gameEvents.push(event);
        
        // Ограничиваем массив последними 100 событиями
        if (this.gameEvents.length > 100) {
            this.gameEvents = this.gameEvents.slice(-100);
        }
        
        return event;
    }
    
    /**
     * Получение JWT токена
     */
    async authenticate() {
        try {
            const response = await fetch(`${this.apiUrl}/api/auth/telegram`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ initData: this.initData })
            });
            
            const data = await response.json();
            if (data.success) {
                this.jwt = data.token;
                this.userId = data.userId;
                console.log('✅ Аутентификация успешна');
                return true;
            }
            return false;
        } catch (error) {
            console.error('❌ Ошибка аутентификации:', error);
            return false;
        }
    }
    
    /**
     * Получение заголовков для API запросов
     */
    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.jwt}`
        };
    }
    
    /**
     * Подключение STARS кошелька
     */
    async connectWallet(walletAddress) {
        if (!this.jwt) {
            await this.authenticate();
        }
        
        try {
            const response = await fetch(`${this.apiUrl}/api/wallet/connect`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({ 
                    userId: this.userId,
                    walletAddress: walletAddress 
                })
            });
            
            const data = await response.json();
            if (data.success) {
                console.log('✅ Кошелек подключен');
                return data;
            }
            throw new Error(data.error || 'Ошибка подключения кошелька');
        } catch (error) {
            console.error('❌ Ошибка подключения кошелька:', error);
            throw error;
        }
    }
    
    /**
     * Получение баланса пользователя
     */
    async getBalance() {
        if (!this.jwt) {
            await this.authenticate();
        }
        
        try {
            const response = await fetch(
                `${this.apiUrl}/api/wallet/balance?userId=${this.userId}`,
                { headers: this.getHeaders() }
            );
            
            const data = await response.json();
            return data;
        } catch (error) {
            console.error('❌ Ошибка получения баланса:', error);
            throw error;
        }
    }
    
    /**
     * Получение каталога товаров
     */
    async getShopItems() {
        if (!this.jwt) {
            await this.authenticate();
        }
        
        try {
            const response = await fetch(`${this.apiUrl}/api/shop/items`, {
                headers: this.getHeaders()
            });
            
            const data = await response.json();
            return data.items;
        } catch (error) {
            console.error('❌ Ошибка загрузки каталога:', error);
            throw error;
        }
    }
    
    /**
     * Покупка товара за Monkey Coins
     */
    async buyItemWithCoins(itemId) {
        if (!this.jwt) {
            await this.authenticate();
        }
        
        try {
            const response = await fetch(`${this.apiUrl}/api/shop/buy`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    userId: this.userId,
                    itemId: itemId
                })
            });
            
            const data = await response.json();
            if (data.success) {
                console.log(`✅ Товар "${data.item.name}" куплен за Monkey Coins`);
                return data;
            }
            throw new Error(data.error || 'Ошибка покупки');
        } catch (error) {
            console.error('❌ Ошибка покупки:', error);
            throw error;
        }
    }
    
    /**
     * Покупка товара за STARS
     */
    async buyItemWithStars(itemId, signature) {
        if (!this.jwt) {
            await this.authenticate();
        }
        
        try {
            const response = await fetch(`${this.apiUrl}/api/shop/buy-stars`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    userId: this.userId,
                    itemId: itemId,
                    signature: signature
                })
            });
            
            const data = await response.json();
            if (data.success) {
                console.log(`✅ Товар "${data.item.name}" куплен за STARS`);
                return data;
            }
            throw new Error(data.error || 'Ошибка покупки');
        } catch (error) {
            console.error('❌ Ошибка покупки за STARS:', error);
            throw error;
        }
    }
    
    /**
     * Отправка результатов игры с событиями
     */
    async submitScore(score) {
        if (!this.jwt) {
            await this.authenticate();
        }
        
        try {
            const response = await fetch(`${this.apiUrl}/api/game/score`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    userId: this.userId,
                    score: score,
                    events: this.gameEvents // Отправляем события для анти-чит
                })
            });
            
            const data = await response.json();
            if (data.success) {
                console.log(`✅ Счет ${score} отправлен и проверен`);
                this.gameEvents = []; // Очищаем события после отправки
                return data;
            }
            throw new Error(data.error || 'Ошибка отправки счета');
        } catch (error) {
            console.error('❌ Ошибка отправки счета:', error);
            throw error;
        }
    }
    
    /**
     * Получение истории транзакций
     */
    async getTransactionHistory() {
        if (!this.jwt) {
            await this.authenticate();
        }
        
        try {
            const response = await fetch(
                `${this.apiUrl}/api/wallet/transactions?userId=${this.userId}`,
                { headers: this.getHeaders() }
            );
            
            const data = await response.json();
            return data.transactions;
        } catch (error) {
            console.error('❌ Ошибка получения истории:', error);
            throw error;
        }
    }
    
    /**
     * Очистка при закрытии приложения
     */
    destroy() {
        this.stopInitDataRefresh();
        this.gameEvents = [];
        this.jwt = null;
    }
}

// =========================
// ПРИМЕР ИСПОЛЬЗОВАНИЯ
// =========================

/*
// 1. Инициализация
const stars = new StarsIntegration('https://your-api.onrender.com');

// 2. Аутентификация
await stars.authenticate();

// 3. Подключение кошелька
await stars.connectWallet('STARS1a2b3c4d5e6f7g8h9i0j...');

// 4. Получение баланса
const balance = await stars.getBalance();
console.log('Баланс:', balance);

// 5. Загрузка магазина
const items = await stars.getShopItems();
console.log('Товары:', items);

// 6. Покупка за Monkey Coins
await stars.buyItemWithCoins('skin_golden_monkey');

// 7. Покупка за STARS (с подписью)
const signature = 'ваша_подпись_от_клиента';
await stars.buyItemWithStars('nft_astronaut', signature);

// 8. Отправка игровых событий
stars.addGameEvent('flip_start', { startHeight: 100 });
stars.addGameEvent('flip_peak', { maxHeight: 250, timestamp: Date.now() });
stars.addGameEvent('flip_end', { landingHeight: 0, score: 15 });

// 9. Отправка счета
await stars.submitScore(150);

// 10. История транзакций
const history = await stars.getTransactionHistory();
console.log('История:', history);

// 11. Очистка при закрытии
window.addEventListener('beforeunload', () => {
    stars.destroy();
});
*/

// Экспорт для использования в модулях
if (typeof module !== 'undefined' && module.exports) {
    module.exports = StarsIntegration;
}
