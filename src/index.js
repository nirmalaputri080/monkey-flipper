// ==================== SEEDED RANDOM NUMBER GENERATOR ====================
// Для детерминированной генерации платформ в 1v1 режиме
class SeededRandom {
    constructor(seed) {
        this.seed = seed;
    }
    
    // Простой LCG (Linear Congruential Generator)
    next() {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }
    
    // Случайное число в диапазоне [min, max]
    range(min, max) {
        return min + this.next() * (max - min);
    }
    
    // Случайное целое число в диапазоне [min, max]
    intRange(min, max) {
        return Math.floor(this.range(min, max + 1));
    }
}

// ==================== SERVER CONFIGURATION ====================
// Socket.IO сервер (Render) - для 1v1 матчмейкинга
const SOCKET_SERVER_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000'  // Для локальной разработки
    : 'https://monkey-flipper-1v1.onrender.com';

// API сервер (Render) - для сохранения счетов и лидерборда
const API_SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'  // Для локальной разработки
    : 'https://monkey-flipper-djm1.onrender.com';  // API на Render с PostgreSQL

// Старая переменная для обратной совместимости (используется в Socket.IO коде)
const SERVER_URL = SOCKET_SERVER_URL;  

// НОВОЕ: Функция получения Telegram User ID
function getTelegramUserId() {
    try {
        const tg = window.Telegram?.WebApp;
        
        // ДИАГНОСТИКА: показываем что есть
        if (window.location.search.includes('debug')) {
            alert('Telegram: ' + (tg ? 'Есть' : 'Нет') + 
                  '\nUser: ' + (tg?.initDataUnsafe?.user ? 'Есть' : 'Нет'));
        }
        
        if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
            console.log('✅ Telegram user detected:', tg.initDataUnsafe.user);
            return {
                id: tg.initDataUnsafe.user.id.toString(),
                username: tg.initDataUnsafe.user.username || tg.initDataUnsafe.user.first_name || 'Anonymous'
            };
        }
    } catch (e) {
        console.error('❌ Ошибка получения Telegram ID:', e);
    }
    
    // Fallback: создаем анонимный ID (сохраняется в localStorage)
    let anonymousId = localStorage.getItem('anonymousUserId');
    
    // 🔧 ВРЕМЕННЫЙ ФИХ: Для тестирования 1v1 - генерируем НОВЫЙ ID при ?test=1
    // В продакшне это отключено - каждый пользователь имеет свой ID
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('test')) {
        // Только для тестирования - каждая вкладка = новый игрок
        anonymousId = 'anonymous_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    } else if (!anonymousId) {
        // Обычный режим - сохраняем ID
        anonymousId = 'anonymous_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('anonymousUserId', anonymousId);
    }
    
    console.log('⚠️ Используется анонимный ID:', anonymousId);
    return { id: anonymousId, username: 'Anonymous' };
}

// НОВОЕ: Функция отправки счета на сервер
async function saveScoreToServer(userId, username, score) {
    try {
        // Округляем счет до целого числа для базы данных
        const roundedScore = Math.round(score);
        console.log(`📤 Отправка счета на сервер: userId=${userId}, score=${roundedScore}`);
        
        const response = await fetch(`${API_SERVER_URL}/api/save-score`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId: userId,
                username: username,
                score: roundedScore,
                timestamp: new Date().toISOString()
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        console.log('✅ Сервер ответил:', result);
        
        // Возвращаем результат (новый рекорд или нет) + информация о монетах
        return {
            success: true,
            isNewRecord: result.isNewRecord,
            bestScore: result.bestScore,
            gamesPlayed: result.gamesPlayed,
            coinsEarned: result.coinsEarned || 0,
            newBalance: result.newBalance || 0
        };
    } catch (error) {
        console.error('❌ Ошибка отправки счета на сервер:', error);
        
        // Сохраняем в очередь для повторной отправки
        savePendingScore(userId, username, score);
        
        return {
            success: false,
            error: error.message
        };
    }
}

// НОВОЕ: Сохранение неотправленных счетов для повторной попытки
function savePendingScore(userId, username, score) {
    try {
        // Округляем счет до целого числа
        const roundedScore = Math.round(score);
        const pending = JSON.parse(localStorage.getItem('pendingScores') || '[]');
        pending.push({
            userId: userId,
            username: username,
            score: roundedScore,
            timestamp: Date.now()
        });
        // Храним максимум 10 неотправленных счетов
        if (pending.length > 10) {
            pending.shift();
        }
        localStorage.setItem('pendingScores', JSON.stringify(pending));
        console.log('💾 Счет сохранен локально для повторной отправки');
    } catch (e) {
        console.error('Ошибка сохранения в pendingScores:', e);
    }
}

// НОВОЕ: Попытка отправить неотправленные счеты
async function retryPendingScores() {
    try {
        const pending = JSON.parse(localStorage.getItem('pendingScores') || '[]');
        if (pending.length === 0) return;

        console.log(`🔄 Попытка отправить ${pending.length} неотправленных счетов`);

        for (const item of pending) {
            const result = await saveScoreToServer(item.userId, item.username, item.score);
            if (result.success) {
                // Убираем успешно отправленный счет из очереди
                const index = pending.indexOf(item);
                pending.splice(index, 1);
            }
        }

        localStorage.setItem('pendingScores', JSON.stringify(pending));
    } catch (e) {
        console.error('Ошибка повторной отправки:', e);
    }
}

// Константы
const CONSTS = {
    // АДАПТИВНАЯ ШИРИНА: подстраивается под экран
    WIDTH: (() => {
        // Для мобильных - используем ширину окна
        const screenWidth = window.innerWidth || 640;
        // Ограничиваем минимум 320 (старые телефоны) и максимум 1920 (десктоп)
        return Math.min(Math.max(screenWidth, 320), 1920);
    })(),
    HEIGHT: (() => {
        // Для Telegram используем viewportHeight, для браузера - innerHeight
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.viewportHeight) {
            console.log('📱 Используем Telegram viewportHeight:', window.Telegram.WebApp.viewportHeight);
            return window.Telegram.WebApp.viewportHeight;
        }
        const screenHeight = window.innerHeight || 800;
        console.log('🌐 Используем window.innerHeight:', screenHeight);
        return screenHeight;
    })(),
    GRAVITY: 650, // ФИКС: Увеличено в 2 раза (было 300) - прыжки быстрее
    JUMP_VELOCITY: -660, // ФИКС: Ещё больше увеличено (было -550) - чтобы допрыгивать до платформ
    MOVE_VELOCITY: 300,
    WALL_SLIDE_SPEED: 200, // ФИКС: Увеличено в 2 раза (было 100) - чтобы соответствовать скорости игры
    RECYCLE_DISTANCE: 500, // ФИКС: Ещё меньше (с 1500), реже авто-recycle
    PLATFORM_GAP: 250,
    SCORE_HEIGHT_INCREMENT: 10,
    SCORE_KILL: 100,
    PLAYER_BOUNCE: 0,
    DEBUG_PHYSICS: true,
    FALL_IMPACT_THRESHOLD: 5, // НОВОЕ: Минимальная скорость падения для game over на земле (чтобы отличить старт от падения)
    // НОВОЕ: Параметры для типов платформ
    PLATFORM_TYPE_NORMAL_PERCENT: 60, // 60% обычных шариков
    PLATFORM_TYPE_MOVING_PERCENT: 30, // 30% движущихся шариков
    PLATFORM_TYPE_UNBREAKABLE_PERCENT: 10, // 10% нелопающихся шариков
    MOVING_PLATFORM_SPEED: 20, // Скорость движения шариков
    MOVING_PLATFORM_RANGE: 150, // Диапазон движения (px влево/вправо)
    BALLOON_SMASH_DURATION: 300, // НОВОЕ: Длительность анимации взрыва шарика (ms) - было 1000
};

// ФИКС: DPI для четкого текста на Retina дисплеях
const DPR = Math.min(window.devicePixelRatio || 1, 2);

class MenuScene extends Phaser.Scene {
    constructor() {
        super({ key: 'MenuScene' });
        this.scoreBoardElements = []; // Массив для элементов экрана рекордов
        this.shopElements = []; // НОВОЕ: Массив для элементов экрана магазина
        this.monkeyCoins = 0; // НОВОЕ: Баланс Monkey Coins
        this.coinsText = null; // НОВОЕ: Текст для отображения баланса
    }

    preload() {
        this.load.image('background_img', 'assets/background.png');
        this.load.image('background_img_menu', 'assets/background_menu.jpg');
        
    }

    create() {
        // НОВОЕ: Проверка deep link для автоматического принятия дуэли
        this.checkDeepLink();
        
        // Фон с растяжкой (stretch) без повторения, как в GameScene
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // НОВОЕ: Отладочная информация о Telegram пользователе
        const userData = getTelegramUserId();
        const isTelegram = window.Telegram?.WebApp?.initDataUnsafe?.user ? '✅' : '❌';
        
        // ОТЛАДКА: Показываем start_param на экране
        const tg = window.Telegram?.WebApp;
        const startParam = tg?.initDataUnsafe?.start_param;
        const debugInfo = `start_param: ${startParam || 'NONE'}`;
        
        // Фон для отладочной панели - КОМПАКТНЫЙ ДЛЯ ТЕЛЕФОНА
        const debugBg = this.add.graphics();
        debugBg.fillStyle(0x000000, 0.7);
        debugBg.fillRoundedRect(10, 10, CONSTS.WIDTH - 20, 100, 8);
        debugBg.setDepth(20);
        
        // Информация о пользователе - УМЕНЬШЕННЫЕ ШРИФТЫ
        const debugText = this.add.text(15, 15, 
            `${isTelegram} TG | 👤 ${userData.username} | 🆔 ${userData.id}`,
            { 
                fontSize: '12px', 
                fill: '#FFFFFF', 
                fontFamily: 'Arial'
            }
        ).setDepth(21);
        
        // НОВОЕ: Отображение баланса Monkey Coins - КРУПНЕЕ
        this.coinsText = this.add.text(CONSTS.WIDTH / 2, 50, 
            `💰 Loading...`, 
            { 
                fontSize: '20px', 
                fill: '#FFD700', 
                fontFamily: 'Arial Black',
                stroke: '#000000',
                strokeThickness: 3
            }
        ).setOrigin(0.5).setDepth(21);
        
        // Подсказка - запас монет внизу панели
        this.add.text(CONSTS.WIDTH / 2, 80, 
            `Зарабатывай монеты играя! 🎮`, 
            { 
                fontSize: '11px', 
                fill: '#AAAAAA', 
                fontFamily: 'Arial',
                fontStyle: 'italic'
            }
        ).setOrigin(0.5).setDepth(21);
        
        // НОВОЕ: Загружаем баланс асинхронно
        this.loadMonkeyCoins(userData.id);

        // Кнопки - КОМПАКТНЫЕ ДЛЯ ТЕЛЕФОНА
        const buttons = [
            { text: 'Играть', y: CONSTS.HEIGHT / 2 - 220, callback: () => this.scene.start('GameScene') },
            { text: '1v1 Онлайн', y: CONSTS.HEIGHT / 2 - 170, callback: () => this.scene.start('MatchmakingScene') },
            { text: 'Дуэли', y: CONSTS.HEIGHT / 2 - 120, callback: () => this.scene.start('DuelHistoryScene') },
            { text: '🏆 Турниры', y: CONSTS.HEIGHT / 2 - 70, callback: () => this.scene.start('TournamentScene') },
            { text: 'Рейтинг', y: CONSTS.HEIGHT / 2 - 20, callback: () => this.openLeaderboard() },
            { text: '🎯 Достижения', y: CONSTS.HEIGHT / 2 + 30, callback: () => this.scene.start('AchievementsScene') },
            { text: '💰 Награды', y: CONSTS.HEIGHT / 2 + 80, callback: () => this.scene.start('DailyRewardScene') },
            { text: '📊 Статистика', y: CONSTS.HEIGHT / 2 + 130, callback: () => this.scene.start('StatsScene') },
            { text: '🎁 Рефералы', y: CONSTS.HEIGHT / 2 + 180, callback: () => this.scene.start('ReferralScene') },
            { text: '🎒 Инвентарь', y: CONSTS.HEIGHT / 2 + 230, callback: () => this.scene.start('InventoryScene') },
            { text: '💎 Кошелёк', y: CONSTS.HEIGHT / 2 + 280, callback: () => this.scene.start('WalletScene') },
            { text: '⭐ Магазин', y: CONSTS.HEIGHT / 2 + 330, callback: () => this.openWebShop() },
        ];

        buttons.forEach(btnData => {
            const btnGraphics = this.add.graphics().setDepth(1);
            btnGraphics.fillStyle(0xFFFFFF, 1);
            btnGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 90, btnData.y - 24, 180, 48, 8);

            // Прозрачная интерактивная зона поверх всей кнопки
            const btnZone = this.add.rectangle(CONSTS.WIDTH / 2, btnData.y, 180, 48, 0x000000, 0)
                .setInteractive({ useHandCursor: true })
                .setDepth(3);

            const btnText = this.add.text(CONSTS.WIDTH / 2, btnData.y, btnData.text, { fontSize: '24px', fill: '#000', fontFamily: 'Arial Black' }).setOrigin(0.5).setDepth(4);

            const setButtonColor = (hover) => {
                btnGraphics.clear();
                btnGraphics.fillStyle(hover ? 0xCCCCCC : 0xFFFFFF, 1);
                btnGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 90, btnData.y - 24, 180, 48, 8);
            };

            btnZone.on('pointerover', () => setButtonColor(true));
            btnZone.on('pointerout', () => setButtonColor(false));
            btnZone.on('pointerdown', btnData.callback);

            // Анимация появления
            [btnGraphics, btnZone, btnText].forEach(obj => {
                obj.setAlpha(0);
                this.tweens.add({
                    targets: obj,
                    alpha: 1,
                    duration: 600,
                    ease: 'Power2'
                });
            });
        });
    }

    // Метод для показа экрана рекордов
    // ФИКС Phase 3: Открываем встроенную LeaderboardScene (без выхода из приложения)
    openLeaderboard() {
        console.log('📊 Открываем таблицу лидеров...');
        this.scene.start('LeaderboardScene');
    }

    // УБРАНО: Старый метод showScoreBoard() больше не используется
    // Метод для скрытия экрана рекордов - больше не нужен
    hideScoreBoard() {
        // Пустой метод для обратной совместимости
    }
    
    // Открыть веб-магазин (shop.html - единственный магазин)
    openWebShop() {
        console.log('⭐ Opening web shop...');
        const userData = getTelegramUserId();
        const userId = userData?.id || 'unknown';
        
        // Для Telegram Mini App используем относительный путь (откроется внутри WebApp)
        const shopUrl = `/shop.html?userId=${userId}`;
        
        console.log('🛒 Opening shop with userId:', userId);
        
        // Открываем внутри того же окна (сохраняет контекст Telegram WebApp)
        window.location.href = shopUrl;
    }
    
    // НОВОЕ: Загрузка баланса Monkey Coins
    async loadMonkeyCoins(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/wallet/balance/${userId}`);
            const data = await response.json();
            
            if (data.success) {
                this.monkeyCoins = data.wallet.monkeyCoin || 0;
                if (this.coinsText) {
                    this.coinsText.setText(`💰 ${this.monkeyCoins} Monkey Coins`);
                }
                console.log(`✅ Loaded ${this.monkeyCoins} Monkey Coins`);
            } else {
                throw new Error('Failed to load wallet');
            }
        } catch (error) {
            console.error('❌ Error loading Monkey Coins:', error);
            if (this.coinsText) {
                this.coinsText.setText(`💰 0 Monkey Coins`);
            }
        }
    }

    // Показать уведомление о реферальном бонусе
    showReferralBonus(amount) {
        // Фон для уведомления
        const bonusBg = this.add.graphics().setDepth(200);
        bonusBg.fillStyle(0x000000, 0.9);
        bonusBg.fillRoundedRect(20, CONSTS.HEIGHT / 2 - 80, CONSTS.WIDTH - 40, 160, 16);
        bonusBg.lineStyle(3, 0xFFD700, 1);
        bonusBg.strokeRoundedRect(20, CONSTS.HEIGHT / 2 - 80, CONSTS.WIDTH - 40, 160, 16);

        // Заголовок
        const titleText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 50, '🎁 Добро пожаловать!', {
            fontSize: '24px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5).setDepth(201);

        // Текст бонуса
        const bonusText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, `Вы получили бонус за регистрацию\nпо реферальной ссылке:`, {
            fontSize: '14px',
            fill: '#FFFFFF',
            fontFamily: 'Arial',
            align: 'center'
        }).setOrigin(0.5).setDepth(201);

        // Сумма бонуса
        const amountText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 + 45, `+${amount} 🪙`, {
            fontSize: '32px',
            fill: '#00FF00',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5).setDepth(201);

        // Автоскрытие через 4 секунды
        this.time.delayedCall(4000, () => {
            bonusBg.destroy();
            titleText.destroy();
            bonusText.destroy();
            amountText.destroy();
            
            // Обновляем баланс
            const userData = getTelegramUserId();
            this.loadMonkeyCoins(userData.id);
        });
    }

    // НОВОЕ: Проверка deep link для автоматического принятия дуэли
    async checkDeepLink() {
        try {
            // Проверяем Telegram WebApp startapp parameter
            const tg = window.Telegram?.WebApp;
            const startParam = tg?.initDataUnsafe?.start_param;
            
            // ОТЛАДКА: Показываем все параметры
            console.log('🔍 Checking deep link...');
            console.log('   Telegram WebApp:', tg ? 'EXISTS' : 'NOT FOUND');
            console.log('   initDataUnsafe:', tg?.initDataUnsafe);
            console.log('   start_param:', startParam);
            
            // ВАЖНО: Проверяем несколько способов получения параметра
            const urlParams = new URLSearchParams(window.location.search);
            const urlMatchId = urlParams.get('matchId'); // Прямой параметр из URL
            const urlStartParam = urlParams.get('tgWebAppStartParam');
            const hashMatchId = window.location.hash.includes('duel_') 
                ? window.location.hash.substring(1) 
                : null;
            
            console.log('   URL matchId:', urlMatchId);
            console.log('   URL tgWebAppStartParam:', urlStartParam);
            console.log('   Hash matchId:', hashMatchId);
            
            // Используем любой найденный параметр
            const finalParam = startParam || urlStartParam || urlMatchId || hashMatchId;
            console.log('   Final param:', finalParam);
            
            if (finalParam && finalParam.startsWith('duel_')) {
                const matchId = finalParam;
                console.log('🔗 Deep link detected:', matchId);
                
                // ОТЛАДКА: Показываем alert чтобы пользователь видел
                alert(`Deep link found: ${matchId}`);
                
                // Показываем loading
                const loadingBg = this.add.rectangle(
                    0, 0, 
                    CONSTS.WIDTH, 
                    CONSTS.HEIGHT, 
                    0x000000, 
                    0.8
                ).setOrigin(0, 0).setDepth(100);
                
                const loadingText = this.add.text(
                    CONSTS.WIDTH / 2,
                    CONSTS.HEIGHT / 2,
                    '⏳ Принятие вызова...',
                    {
                        fontSize: '24px',
                        fill: '#FFD700',
                        fontFamily: 'Arial Black'
                    }
                ).setOrigin(0.5).setDepth(101);
                
                // Получаем информацию о дуэли
                const duelResponse = await fetch(`${API_SERVER_URL}/api/duel/${matchId}`);
                
                if (!duelResponse.ok) {
                    throw new Error('Дуэль не найдена');
                }
                
                const duelData = await duelResponse.json();
                const duel = duelData.duel;
                
                // Проверяем статус
                if (duel.status !== 'pending') {
                    loadingText.setText('❌ Дуэль уже началась или истекла');
                    setTimeout(() => {
                        loadingBg.destroy();
                        loadingText.destroy();
                    }, 2000);
                    return;
                }
                
                // Принимаем вызов
                const userData = getTelegramUserId();
                const acceptResponse = await fetch(`${API_SERVER_URL}/api/duel/${matchId}/accept`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        player2Id: userData.id,
                        player2Username: userData.username
                    })
                });
                
                if (!acceptResponse.ok) {
                    const errorData = await acceptResponse.json();
                    throw new Error(errorData.error || 'Failed to accept');
                }
                
                const acceptData = await acceptResponse.json();
                
                // Успешно принято - запускаем игру с seed
                loadingText.setText('✅ Вызов принят! Запуск игры...');
                
                setTimeout(() => {
                    loadingBg.destroy();
                    loadingText.destroy();
                    
                    // Запускаем игру в режиме дуэли
                    this.scene.start('GameScene', {
                        mode: 'duel',
                        matchId: matchId,
                        seed: acceptData.seed,
                        opponentUsername: duel.player1_username
                    });
                }, 1500);
                
            } else if (finalParam && finalParam.startsWith('ref_')) {
                // Реферальная ссылка
                const referrerId = finalParam.replace('ref_', '');
                console.log('🎁 Referral link detected, referrer:', referrerId);
                
                const userData = getTelegramUserId();
                
                // Применяем реферальный код
                try {
                    const refResponse = await fetch(`${API_SERVER_URL}/api/referral/apply`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            referrerId: referrerId,
                            referredId: userData.id,
                            referredUsername: userData.username
                        })
                    });
                    
                    const refData = await refResponse.json();
                    
                    if (refData.success) {
                        console.log('✅ Referral applied! Bonus:', refData.bonusReceived);
                        
                        // Показываем уведомление о бонусе
                        this.showReferralBonus(refData.bonusReceived);
                    } else if (refData.alreadyReferred) {
                        console.log('ℹ️ User already has a referrer');
                    } else {
                        console.log('⚠️ Referral apply failed:', refData.error);
                    }
                } catch (refError) {
                    console.error('❌ Referral error:', refError);
                }
            } else {
                console.log('ℹ️ No deep link found');
                
                // ОТЛАДКА: Показываем alert если пользователь открыл из Telegram но параметра нет
                if (tg && !finalParam) {
                    console.log('⚠️ User opened from Telegram but no start_param found');
                    
                    // Показываем все что есть в initDataUnsafe
                    const debugData = JSON.stringify(tg.initDataUnsafe, null, 2);
                    console.log('Full initDataUnsafe:', debugData);
                }
            }
        } catch (error) {
            console.error('❌ Deep link error:', error);
            alert(`Failed to accept challenge: ${error.message}`);
        }
    }
}

// ==================== LEADERBOARD SCENE ====================
// Встроенный лидерборд без выхода из приложения
class LeaderboardScene extends Phaser.Scene {
    constructor() {
        super({ key: 'LeaderboardScene' });
        this.leaderboardData = [];
        this.loadingText = null;
    }
    
    create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);
        
        // Заголовок - КОМПАКТНЕЕ
        this.add.text(CONSTS.WIDTH / 2, 40, '🏆 РЕЙТИНГ', {
            fontSize: '32px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);
        
        // Статус загрузки
        this.loadingText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, '⏳ Загрузка...', {
            fontSize: '20px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);
        
        // Кнопка "Назад"
        this.createBackButton();
        
        // Загружаем данные
        this.loadLeaderboard();
    }
    
    createBackButton() {
        const buttonY = CONSTS.HEIGHT - 35;
        
        const backGraphics = this.add.graphics();
        backGraphics.fillStyle(0x2196F3, 1);
        backGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 70, buttonY - 18, 140, 36, 8);
        
        const backZone = this.add.rectangle(CONSTS.WIDTH / 2, buttonY, 140, 36, 0x000000, 0)
            .setInteractive({ useHandCursor: true });
        
        const backText = this.add.text(CONSTS.WIDTH / 2, buttonY, '← Назад', {
            fontSize: '20px',
            fill: '#FFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);
        
        backZone.on('pointerdown', () => {
            console.log('🔙 Возврат в меню');
            this.scene.start('MenuScene');
        });
    }
    
    async loadLeaderboard() {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/leaderboard?limit=20`);
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Failed to load leaderboard');
            }
            
            this.leaderboardData = data.rows || [];
            this.displayLeaderboard();
            
        } catch (error) {
            console.error('❌ Ошибка загрузки рейтинга:', error);
            this.loadingText.setText('❌ Ошибка загрузки');
        }
    }
    
    displayLeaderboard() {
        // Удаляем loading text
        if (this.loadingText) {
            this.loadingText.destroy();
        }
        
        if (this.leaderboardData.length === 0) {
            this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Пока нет записей', {
                fontSize: '20px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }).setOrigin(0.5);
            return;
        }
        
        // Создаем компактный список для телефона
        const startY = 90;
        const rowHeight = 38;
        const maxVisible = 12;
        
        this.leaderboardData.slice(0, maxVisible).forEach((player, index) => {
            const rank = index + 1;
            const y = startY + index * rowHeight;
            
            // Фон строки - компактнее
            const rowBg = this.add.graphics();
            rowBg.fillStyle(index % 2 === 0 ? 0x333333 : 0x222222, 0.7);
            rowBg.fillRoundedRect(15, y - 15, CONSTS.WIDTH - 30, 32, 5);
            
            // Место - меньше
            let rankText = `${rank}`;
            let rankColor = '#FFFFFF';
            if (rank === 1) {
                rankText = '🥇';
                rankColor = '#FFD700';
            } else if (rank === 2) {
                rankText = '🥈';
                rankColor = '#C0C0C0';
            } else if (rank === 3) {
                rankText = '🥉';
                rankColor = '#CD7F32';
            }
            
            this.add.text(30, y, rankText, {
                fontSize: '16px',
                fill: rankColor,
                fontFamily: 'Arial Black'
            }).setOrigin(0, 0.5);
            
            // Имя игрока - короче
            const username = player.username || 'Anonymous';
            this.add.text(70, y, username.length > 12 ? username.substring(0, 12) + '...' : username, {
                fontSize: '15px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }).setOrigin(0, 0.5);
            
            // Счет - меньше
            this.add.text(CONSTS.WIDTH - 25, y, player.score.toLocaleString(), {
                fontSize: '16px',
                fill: '#00FF00',
                fontFamily: 'Arial Black'
            }).setOrigin(1, 0.5);
        });
        
        // Показываем количество игроков - меньше текст
        this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 60, 
            `Всего игроков: ${this.leaderboardData.length}`, {
            fontSize: '13px',
            fill: '#AAAAAA',
            fontFamily: 'Arial'
        }).setOrigin(0.5);
    }
}


// ==================== TOURNAMENT SCENE ====================
class TournamentScene extends Phaser.Scene {
    constructor() {
        super({ key: 'TournamentScene' });
        this.tournaments = [];
        this.myTournaments = [];
    }

    async create() {
        const userData = getTelegramUserId();

        // Фон
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // Градиентный оверлей для затемнения фона
        const overlay = this.add.rectangle(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, CONSTS.WIDTH, CONSTS.HEIGHT, 0x000000, 0.6);

        // Заголовок с тенью
        this.add.text(CONSTS.WIDTH / 2, 45, '🏆 ТУРНИРЫ', {
            fontSize: '40px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#8B4513',
            strokeThickness: 6,
            shadow: { offsetX: 3, offsetY: 3, color: '#000', blur: 8, fill: true }
        }).setOrigin(0.5);

        // Подзаголовок
        this.add.text(CONSTS.WIDTH / 2, 85, 'Соревнуйтесь за реальные призы в TON!', {
            fontSize: '15px',
            fill: '#FFFFFF',
            fontFamily: 'Arial',
            stroke: '#000',
            strokeThickness: 3
        }).setOrigin(0.5);

        // Кнопка "Назад"
        this.createBackButton();

        // Табы
        const tabY = 130;
        this.activeTab = 'active';
        this.activeTabButton = this.createTab('🔥 Активные', 90, tabY, true, () => this.switchTab('active'));
        this.myTabButton = this.createTab('📋 Мои', CONSTS.WIDTH - 90, tabY, false, () => this.switchTab('my'));

        // Контейнер для списка турниров
        this.tournamentsContainer = this.add.container(0, 180);

        // Загружаем активные турниры по умолчанию
        await this.loadActiveTournaments(userData.id);
        this.showActiveTournaments();
    }

    createTab(text, x, y, active, callback) {
        const width = 140;
        const height = 45;
        
        // Фон кнопки с закругленными углами (через графику)
        const graphics = this.add.graphics();
        graphics.fillStyle(active ? 0xFF6B35 : 0x34495E, 1);
        graphics.fillRoundedRect(x - width/2, y - height/2, width, height, 10);
        
        // Обводка
        graphics.lineStyle(3, active ? 0xFFFFFF : 0x7F8C8D, 1);
        graphics.strokeRoundedRect(x - width/2, y - height/2, width, height, 10);
        
        graphics.setInteractive(new Phaser.Geom.Rectangle(x - width/2, y - height/2, width, height), Phaser.Geom.Rectangle.Contains);
        graphics.input.cursor = 'pointer';

        const txt = this.add.text(x, y, text, {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 3
        }).setOrigin(0.5);

        graphics.on('pointerdown', callback);
        
        return { graphics, txt, x, y, active, width, height };
    }

    switchTab(tab) {
        if (this.activeTab === tab) return;
        
        this.activeTab = tab;
        
        // Обновляем визуал табов
        this.updateTabStyles();
        
        // Показываем соответствующий контент
        if (tab === 'active') {
            this.showActiveTournaments();
        } else {
            this.showMyTournaments();
        }
    }

    updateTabStyles() {
        // Перерисовываем табы
        const isActiveTab = this.activeTab === 'active';
        
        // Активные
        this.activeTabButton.graphics.clear();
        this.activeTabButton.graphics.fillStyle(isActiveTab ? 0xFF6B35 : 0x34495E, 1);
        this.activeTabButton.graphics.fillRoundedRect(
            this.activeTabButton.x - this.activeTabButton.width/2, 
            this.activeTabButton.y - this.activeTabButton.height/2, 
            this.activeTabButton.width, 
            this.activeTabButton.height, 
            10
        );
        this.activeTabButton.graphics.lineStyle(3, isActiveTab ? 0xFFFFFF : 0x7F8C8D, 1);
        this.activeTabButton.graphics.strokeRoundedRect(
            this.activeTabButton.x - this.activeTabButton.width/2, 
            this.activeTabButton.y - this.activeTabButton.height/2, 
            this.activeTabButton.width, 
            this.activeTabButton.height, 
            10
        );
        
        // Мои
        this.myTabButton.graphics.clear();
        this.myTabButton.graphics.fillStyle(!isActiveTab ? 0xFF6B35 : 0x34495E, 1);
        this.myTabButton.graphics.fillRoundedRect(
            this.myTabButton.x - this.myTabButton.width/2, 
            this.myTabButton.y - this.myTabButton.height/2, 
            this.myTabButton.width, 
            this.myTabButton.height, 
            10
        );
        this.myTabButton.graphics.lineStyle(3, !isActiveTab ? 0xFFFFFF : 0x7F8C8D, 1);
        this.myTabButton.graphics.strokeRoundedRect(
            this.myTabButton.x - this.myTabButton.width/2, 
            this.myTabButton.y - this.myTabButton.height/2, 
            this.myTabButton.width, 
            this.myTabButton.height, 
            10
        );
    }

    async loadActiveTournaments(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/tournaments/active`);
            const data = await response.json();

            if (data.success) {
                this.tournaments = data.tournaments || [];
                console.log('✅ Loaded tournaments:', this.tournaments.length);
            }
        } catch (error) {
            console.error('❌ Error loading tournaments:', error);
        }
    }

    async loadMyTournaments(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/tournaments/my/${userId}`);
            const data = await response.json();

            if (data.success) {
                this.myTournaments = data.tournaments || [];
                console.log('✅ Loaded my tournaments:', this.myTournaments.length);
            }
        } catch (error) {
            console.error('❌ Error loading my tournaments:', error);
        }
    }

    showActiveTournaments() {
        this.tournamentsContainer.removeAll(true);

        if (this.tournaments.length === 0) {
            const emptyText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Нет активных турниров\n\n🔜 Скоро появятся!', {
                fontSize: '20px',
                fill: '#ECF0F1',
                align: 'center',
                fontFamily: 'Arial',
                stroke: '#000',
                strokeThickness: 3
            }).setOrigin(0.5);
            this.tournamentsContainer.add(emptyText);
            return;
        }

        let yOffset = 0;

        this.tournaments.forEach((tournament) => {
            const card = this.createTournamentCard(tournament, yOffset);
            this.tournamentsContainer.add(card);
            yOffset += 170; // Увеличил отступ между карточками
        });
    }

    async showMyTournaments() {
        const userData = getTelegramUserId();
        await this.loadMyTournaments(userData.id);

        this.tournamentsContainer.removeAll(true);

        if (this.myTournaments.length === 0) {
            const txt = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Вы еще не участвуете\nни в одном турнире', {
                fontSize: '18px',
                fill: '#AAAAAA',
                align: 'center'
            }).setOrigin(0.5);
            this.tournamentsContainer.add(txt);
            return;
        }

        let yOffset = 0;

        this.myTournaments.forEach((tournament) => {
            const card = this.createMyTournamentCard(tournament, yOffset);
            this.tournamentsContainer.add(card);
            yOffset += 140;
        });
    }

    createTournamentCard(tournament, yOffset) {
        const container = this.add.container(CONSTS.WIDTH / 2, yOffset);
        const cardWidth = CONSTS.WIDTH - 40;
        const cardHeight = 150;

        // Графика для закругленной карточки
        const cardGraphics = this.add.graphics();
        
        // Тень
        cardGraphics.fillStyle(0x000000, 0.3);
        cardGraphics.fillRoundedRect(-cardWidth/2 + 5, -cardHeight/2 + 5, cardWidth, cardHeight, 15);
        
        // Основной фон
        cardGraphics.fillStyle(0x1E2732, 1);
        cardGraphics.fillRoundedRect(-cardWidth/2, -cardHeight/2, cardWidth, cardHeight, 15);
        
        // Золотая обводка
        cardGraphics.lineStyle(3, 0xFFD700, 1);
        cardGraphics.strokeRoundedRect(-cardWidth/2, -cardHeight/2, cardWidth, cardHeight, 15);
        
        container.add(cardGraphics);

        // Название турнира
        const name = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 15, tournament.name || 'Weekly Tournament', {
            fontSize: '22px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 4,
            wordWrap: { width: cardWidth - 30 }
        });
        
        // Призовой фонд (большой и заметный)
        const prizeAmount = parseFloat(tournament.prize_pool_ton).toFixed(2);
        const prizeText = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 45, `💰 ${prizeAmount} TON`, {
            fontSize: '18px',
            fill: '#2ECC71',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 3
        });

        // Вступительный взнос
        const entryAmount = parseFloat(tournament.entry_fee_ton).toFixed(2);
        const entryText = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 68, `🎫 Взнос: ${entryAmount} TON`, {
            fontSize: '15px',
            fill: '#E74C3C',
            fontFamily: 'Arial',
            stroke: '#000',
            strokeThickness: 2
        });

        // Участники
        const participantsText = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 90, `👥 ${tournament.current_participants}/${tournament.max_participants || '∞'}`, {
            fontSize: '14px',
            fill: '#ECF0F1',
            fontFamily: 'Arial',
            stroke: '#000',
            strokeThickness: 2
        });

        // Время до конца (правый верхний угол)
        const timeRemaining = this.formatTimeRemaining(tournament.seconds_until_end || 0);
        const timeText = this.add.text(cardWidth/2 - 15, -cardHeight/2 + 15, `⏰ ${timeRemaining}`, {
            fontSize: '14px',
            fill: '#F39C12',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 2
        }).setOrigin(1, 0);

        // Кнопка "Лидерборд" (стильная)
        const btnY = cardHeight/2 - 25;
        const leaderboardGraphics = this.add.graphics();
        leaderboardGraphics.fillStyle(0x3498DB, 1);
        leaderboardGraphics.fillRoundedRect(-cardWidth/2 + 15, btnY - 20, 100, 40, 8);
        leaderboardGraphics.lineStyle(2, 0xFFFFFF, 1);
        leaderboardGraphics.strokeRoundedRect(-cardWidth/2 + 15, btnY - 20, 100, 40, 8);
        leaderboardGraphics.setInteractive(new Phaser.Geom.Rectangle(-cardWidth/2 + 15, btnY - 20, 100, 40), Phaser.Geom.Rectangle.Contains);
        leaderboardGraphics.input.cursor = 'pointer';

        const leaderboardText = this.add.text(-cardWidth/2 + 65, btnY, '📊 ТОП', {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 3
        }).setOrigin(0.5);

        leaderboardGraphics.on('pointerdown', () => this.showLeaderboard(tournament));
        leaderboardGraphics.on('pointerover', () => {
            leaderboardGraphics.clear();
            leaderboardGraphics.fillStyle(0x5DADE2, 1);
            leaderboardGraphics.fillRoundedRect(-cardWidth/2 + 15, btnY - 20, 100, 40, 8);
            leaderboardGraphics.lineStyle(2, 0xFFFFFF, 1);
            leaderboardGraphics.strokeRoundedRect(-cardWidth/2 + 15, btnY - 20, 100, 40, 8);
        });
        leaderboardGraphics.on('pointerout', () => {
            leaderboardGraphics.clear();
            leaderboardGraphics.fillStyle(0x3498DB, 1);
            leaderboardGraphics.fillRoundedRect(-cardWidth/2 + 15, btnY - 20, 100, 40, 8);
            leaderboardGraphics.lineStyle(2, 0xFFFFFF, 1);
            leaderboardGraphics.strokeRoundedRect(-cardWidth/2 + 15, btnY - 20, 100, 40, 8);
        });

        // Кнопка "Вступить" (большая и яркая)
        const joinBtnColor = tournament.isFull ? 0x7F8C8D : 0x27AE60;
        const joinGraphics = this.add.graphics();
        joinGraphics.fillStyle(joinBtnColor, 1);
        joinGraphics.fillRoundedRect(-cardWidth/2 + 125, btnY - 20, 110, 40, 8);
        joinGraphics.lineStyle(3, tournament.isFull ? 0x95A5A6 : 0xFFD700, 1);
        joinGraphics.strokeRoundedRect(-cardWidth/2 + 125, btnY - 20, 110, 40, 8);
        
        if (!tournament.isFull) {
            joinGraphics.setInteractive(new Phaser.Geom.Rectangle(-cardWidth/2 + 125, btnY - 20, 110, 40), Phaser.Geom.Rectangle.Contains);
            joinGraphics.input.cursor = 'pointer';
        }

        const joinText = this.add.text(-cardWidth/2 + 180, btnY, tournament.isFull ? '❌ FULL' : '✅ JOIN', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 4
        }).setOrigin(0.5);

        if (!tournament.isFull) {
            joinGraphics.on('pointerdown', () => this.joinTournament(tournament));
            joinGraphics.on('pointerover', () => {
                joinGraphics.clear();
                joinGraphics.fillStyle(0x2ECC71, 1);
                joinGraphics.fillRoundedRect(-cardWidth/2 + 125, btnY - 20, 110, 40, 8);
                joinGraphics.lineStyle(3, 0xFFD700, 1);
                joinGraphics.strokeRoundedRect(-cardWidth/2 + 125, btnY - 20, 110, 40, 8);
            });
            joinGraphics.on('pointerout', () => {
                joinGraphics.clear();
                joinGraphics.fillStyle(0x27AE60, 1);
                joinGraphics.fillRoundedRect(-cardWidth/2 + 125, btnY - 20, 110, 40, 8);
                joinGraphics.lineStyle(3, 0xFFD700, 1);
                joinGraphics.strokeRoundedRect(-cardWidth/2 + 125, btnY - 20, 110, 40, 8);
            });
        }

        container.add([name, prizeText, entryText, participantsText, timeText, leaderboardGraphics, leaderboardText, joinGraphics, joinText]);

        return container;
    }

    createMyTournamentCard(tournament, yOffset) {
        const container = this.add.container(CONSTS.WIDTH / 2, yOffset);
        const cardWidth = CONSTS.WIDTH - 40;
        const cardHeight = 140;

        // Графика для карточки
        const cardGraphics = this.add.graphics();
        
        // Тень
        cardGraphics.fillStyle(0x000000, 0.3);
        cardGraphics.fillRoundedRect(-cardWidth/2 + 5, -cardHeight/2 + 5, cardWidth, cardHeight, 15);
        
        // Основной фон (другой цвет для "Моих" турниров)
        cardGraphics.fillStyle(0x283747, 1);
        cardGraphics.fillRoundedRect(-cardWidth/2, -cardHeight/2, cardWidth, cardHeight, 15);
        
        // Синяя обводка для моих турниров
        cardGraphics.lineStyle(3, 0x3498DB, 1);
        cardGraphics.strokeRoundedRect(-cardWidth/2, -cardHeight/2, cardWidth, cardHeight, 15);
        
        container.add(cardGraphics);

        // Название
        const name = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 15, tournament.name || 'Tournament', {
            fontSize: '20px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 4,
            wordWrap: { width: cardWidth - 140 }
        });

        // Мое место (крупно и заметно)
        const placeColor = tournament.current_place === 1 ? '#FFD700' : 
                          tournament.current_place === 2 ? '#C0C0C0' : 
                          tournament.current_place === 3 ? '#CD7F32' : '#3498DB';
        const placeEmoji = tournament.current_place === 1 ? '🥇' : 
                          tournament.current_place === 2 ? '🥈' : 
                          tournament.current_place === 3 ? '🥉' : '📍';
        
        const place = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 45, `${placeEmoji} Место: ${tournament.current_place || '-'}`, {
            fontSize: '18px',
            fill: placeColor,
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 3
        });

        // Лучший счет
        const score = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 70, `🎯 Лучший счет: ${tournament.best_score || 0}`, {
            fontSize: '16px',
            fill: '#2ECC71',
            fontFamily: 'Arial',
            stroke: '#000',
            strokeThickness: 2
        });

        // Попытки
        const attempts = this.add.text(-cardWidth/2 + 15, -cardHeight/2 + 93, `🎮 Попыток: ${tournament.attempts || 0}`, {
            fontSize: '14px',
            fill: '#ECF0F1',
            fontFamily: 'Arial',
            stroke: '#000',
            strokeThickness: 2
        });

        // Статус (правый верхний угол)
        const statusText = tournament.status === 'finished' ? '✅ Завершен' : '🔥 Активен';
        const statusColor = tournament.status === 'finished' ? '#95A5A6' : '#E67E22';
        const status = this.add.text(cardWidth/2 - 15, -cardHeight/2 + 15, statusText, {
            fontSize: '15px',
            fill: statusColor,
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 2
        }).setOrigin(1, 0);

        // Кнопка "Играть" (если турнир активен)
        if (tournament.status !== 'finished') {
            const btnY = cardHeight/2 - 25;
            const playGraphics = this.add.graphics();
            playGraphics.fillStyle(0xFF6B35, 1);
            playGraphics.fillRoundedRect(-cardWidth/2 + 15, btnY - 20, 120, 40, 8);
            playGraphics.lineStyle(3, 0xFFD700, 1);
            playGraphics.strokeRoundedRect(-cardWidth/2 + 15, btnY - 20, 120, 40, 8);
            playGraphics.setInteractive(new Phaser.Geom.Rectangle(-cardWidth/2 + 15, btnY - 20, 120, 40), Phaser.Geom.Rectangle.Contains);
            playGraphics.input.cursor = 'pointer';

            const playText = this.add.text(-cardWidth/2 + 75, btnY, '🎮 ИГРАТЬ', {
                fontSize: '18px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black',
                stroke: '#000',
                strokeThickness: 4
            }).setOrigin(0.5);

            playGraphics.on('pointerdown', () => this.playTournament(tournament));
            playGraphics.on('pointerover', () => {
                playGraphics.clear();
                playGraphics.fillStyle(0xFF8C5A, 1);
                playGraphics.fillRoundedRect(-cardWidth/2 + 15, btnY - 20, 120, 40, 8);
                playGraphics.lineStyle(3, 0xFFD700, 1);
                playGraphics.strokeRoundedRect(-cardWidth/2 + 15, btnY - 20, 120, 40, 8);
            });
            playGraphics.on('pointerout', () => {
                playGraphics.clear();
                playGraphics.fillStyle(0xFF6B35, 1);
                playGraphics.fillRoundedRect(-cardWidth/2 + 15, btnY - 20, 120, 40, 8);
                playGraphics.lineStyle(3, 0xFFD700, 1);
                playGraphics.strokeRoundedRect(-cardWidth/2 + 15, btnY - 20, 120, 40, 8);
            });

            container.add([playGraphics, playText]);
        }

        container.add([name, place, score, attempts, status]);

        return container;
    }

    async joinTournament(tournament) {
        const userData = getTelegramUserId();

        try {
            const response = await fetch(`${API_SERVER_URL}/api/tournaments/${tournament.id}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userData.id,
                    username: userData.username,
                    autoRenew: false
                })
            });

            const data = await response.json();

            if (data.success) {
                console.log('✅ Joined tournament:', tournament.id);
                alert(`Вы вступили в турнир!\nВзнос: ${tournament.entry_fee_ton} TON`);
                this.scene.restart();
            } else {
                console.error('❌ Join failed:', data.error);
                alert(`Ошибка: ${data.error}`);
            }
        } catch (error) {
            console.error('❌ Join tournament error:', error);
            alert('Ошибка подключения к серверу');
        }
    }

    playTournament(tournament) {
        // Сохраняем ID турнира для отправки результата
        localStorage.setItem('currentTournamentId', tournament.id);
        
        // Запускаем игру
        this.scene.start('GameScene');
    }

    formatTimeRemaining(seconds) {
        if (seconds <= 0) return 'Завершен';

        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (days > 0) return `${days}д ${hours}ч`;
        if (hours > 0) return `${hours}ч ${minutes}м`;
        return `${minutes}м`;
    }

    async showLeaderboard(tournament) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/tournaments/${tournament.id}`);
            const data = await response.json();

            if (!data.success) {
                alert('Ошибка загрузки лидерборда');
                return;
            }

            // Создаем модальное окно с лидербордом
            const overlay = this.add.rectangle(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, CONSTS.WIDTH, CONSTS.HEIGHT, 0x000000, 0.8)
                .setInteractive()
                .setDepth(2000);

            const panel = this.add.rectangle(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, CONSTS.WIDTH - 40, CONSTS.HEIGHT - 100, 0x2C3E50, 1)
                .setDepth(2001);

            // Заголовок
            const title = this.add.text(CONSTS.WIDTH / 2, 70, '🏆 ЛИДЕРБОРД', {
                fontSize: '28px',
                fill: '#FFD700',
                fontFamily: 'Arial Black'
            }).setOrigin(0.5).setDepth(2002);

            const subtitle = this.add.text(CONSTS.WIDTH / 2, 100, tournament.name, {
                fontSize: '16px',
                fill: '#CCCCCC'
            }).setOrigin(0.5).setDepth(2002);

            // Список игроков
            let yPos = 140;
            data.leaderboard.slice(0, 10).forEach((player, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                const color = index < 3 ? '#FFD700' : '#FFFFFF';

                const playerText = this.add.text(40, yPos, 
                    `${medal} ${player.username}: ${player.best_score}`, 
                    {
                        fontSize: '18px',
                        fill: color,
                        fontFamily: 'Arial'
                    }
                ).setDepth(2002);

                yPos += 35;
            });

            // Кнопка закрыть
            const closeBtn = this.add.rectangle(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 60, 120, 45, 0xE74C3C, 1)
                .setInteractive({ useHandCursor: true })
                .setDepth(2002);

            const closeText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 60, 'Закрыть', {
                fontSize: '18px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }).setOrigin(0.5).setDepth(2002);

            closeBtn.on('pointerdown', () => {
                [overlay, panel, title, subtitle, closeBtn, closeText].forEach(obj => obj.destroy());
                this.children.list.filter(obj => obj.depth === 2002).forEach(obj => obj.destroy());
            });

        } catch (error) {
            console.error('❌ Error loading leaderboard:', error);
            alert('Ошибка подключения к серверу');
        }
    }

    createBackButton() {
        const backBtn = this.add.rectangle(50, CONSTS.HEIGHT - 40, 80, 40, 0x34495E, 1)
            .setInteractive({ useHandCursor: true });

        const backText = this.add.text(50, CONSTS.HEIGHT - 40, '← Назад', {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        backBtn.on('pointerdown', () => this.scene.start('MenuScene'));
        backBtn.on('pointerover', () => backBtn.setFillStyle(0x4A6278));
        backBtn.on('pointerout', () => backBtn.setFillStyle(0x34495E));
    }
}

// ==================== MATCHMAKING SCENE ====================
// Сцена поиска оппонента для 1v1 режима
class MatchmakingScene extends Phaser.Scene {
    constructor() {
        super({ key: 'MatchmakingScene' });
        this.socket = null;
        this.userData = null;
        this.searchingText = null;
        this.dots = '';
        this.dotTimer = null;
    }
    
    create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);
        
        // Заголовок
        this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 4, '1v1 Онлайн', {
            fontSize: '42px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 6
        }).setOrigin(0.5);
        
        // Статус поиска
        this.searchingText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Поиск соперника', {
            fontSize: '32px',
            fill: '#FFFFFF',
            fontFamily: 'Arial',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);
        
        // Анимация точек
        this.dotTimer = this.time.addEvent({
            delay: 500,
            callback: () => {
                this.dots = this.dots.length >= 3 ? '' : this.dots + '.';
                this.searchingText.setText('Поиск соперника' + this.dots);
            },
            loop: true
        });
        
        // Кнопка отмены
        const cancelGraphics = this.add.graphics();
        cancelGraphics.fillStyle(0xFF0000, 1);
        cancelGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 80, CONSTS.HEIGHT - 120, 160, 50, 8);
        
        const cancelZone = this.add.rectangle(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 95, 160, 50, 0x000000, 0)
            .setInteractive({ useHandCursor: true });
        
        const cancelButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 95, 'Отмена', {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);
        
        cancelZone.on('pointerdown', () => {
            this.cancelMatchmaking();
        });
        
        // Подключаемся к серверу
        this.connectToServer();
    }
    
    connectToServer() {
        // Получаем данные пользователя
        this.userData = getTelegramUserId();
        
        // Подключаемся к Socket.IO серверу
        const socketUrl = SERVER_URL || window.location.origin;
        console.log('🔌 Подключение к серверу:', socketUrl);
        console.log('👤 Мои данные:', this.userData);
        
        this.socket = io(socketUrl);
        
        this.socket.on('connect', () => {
            console.log('✅ Подключено к серверу Socket.IO:', this.socket.id);
            console.log('📤 Отправляю данные для матчмейкинга:', {
                userId: this.userData.id,
                username: this.userData.username
            });
            
            // Начинаем поиск матча
            this.socket.emit('findMatch', {
                userId: this.userData.id,
                username: this.userData.username
            });
        });
        
        this.socket.on('searching', (data) => {
            console.log('🔍 Поиск... Игроков в очереди:', data.queueSize);
        });
        
        this.socket.on('gameStart', (data) => {
            console.log('🎮 Игра началась!', data);
            console.log('🆚 Мой ID:', this.userData.id);
            console.log('🆚 ID оппонента:', data.opponent?.id);
            console.log('⚠️ ПРОВЕРКА: Это один и тот же игрок?', this.userData.id === data.opponent?.id);
            
            // Останавливаем таймер точек
            if (this.dotTimer) {
                this.dotTimer.remove();
            }
            
            // Переходим в GameScene с параметрами 1v1
            this.scene.start('GameScene', {
                mode: '1v1',
                seed: data.seed,
                roomId: data.roomId,
                opponent: data.opponent,
                socket: this.socket
            });
        });
        
        this.socket.on('countdown', (seconds) => {
            this.searchingText.setText(`Игра начнётся через ${seconds}...`);
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('❌ Ошибка подключения:', error);
            this.searchingText.setText('Ошибка подключения!\nВозврат в меню...');
            
            this.time.delayedCall(2000, () => {
                this.scene.start('MenuScene');
            });
        });
    }
    
    cancelMatchmaking() {
        console.log('❌ Отмена поиска матча');
        
        if (this.socket) {
            this.socket.emit('cancelMatch');
            this.socket.disconnect();
        }
        
        if (this.dotTimer) {
            this.dotTimer.remove();
        }
        
        this.scene.start('MenuScene');
    }
    
    shutdown() {
        // Очистка при выходе из сцены
        if (this.dotTimer) {
            this.dotTimer.remove();
        }
    }
}

// ==================== DUEL HISTORY SCENE ====================
// Сцена истории дуэлей и создания вызовов
class DuelHistoryScene extends Phaser.Scene {
    constructor() {
        super({ key: 'DuelHistoryScene' });
    }
    
    create() {
        const userData = getTelegramUserId();
        
        // Адаптивные размеры
        const padding = 20;
        const buttonWidth = Math.min(CONSTS.WIDTH - padding * 2, 320);
        const buttonHeight = 55;
        
        // Фон с градиентом
        const bg = this.add.graphics();
        bg.fillGradientStyle(0x1a1a2e, 0x1a1a2e, 0x16213e, 0x16213e, 1);
        bg.fillRect(0, 0, CONSTS.WIDTH, CONSTS.HEIGHT);
        
        // Заголовок - компактный
        this.add.text(CONSTS.WIDTH / 2, 45, '⚔️ ДУЭЛИ', {
            fontSize: '36px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000',
            strokeThickness: 4
        }).setOrigin(0.5);
        
        // Подзаголовок
        this.add.text(CONSTS.WIDTH / 2, 80, 'Вызови друга на поединок!', {
            fontSize: '14px',
            fill: '#aaaaaa',
            fontFamily: 'Arial'
        }).setOrigin(0.5);
        
        // === КНОПКИ ДЕЙСТВИЙ ===
        let btnY = 120;
        
        // Кнопка "Создать вызов" - главная
        this.createButton(
            CONSTS.WIDTH / 2, btnY,
            buttonWidth, buttonHeight + 5,
            '🎯 Создать вызов',
            0xFF6B35, 0xFF8C5A,
            () => this.createDuelChallenge(userData),
            '22px'
        );
        
        btnY += buttonHeight + 15;
        
        // Кнопка "Принять вызов"
        this.createButton(
            CONSTS.WIDTH / 2, btnY,
            buttonWidth, buttonHeight - 5,
            '✅ Принять вызов по ID',
            0x27ae60, 0x2ecc71,
            () => this.showAcceptDialog(userData),
            '18px'
        );
        
        btnY += buttonHeight + 10;
        
        // Разделитель
        const dividerY = btnY + 5;
        this.add.rectangle(CONSTS.WIDTH / 2, dividerY, buttonWidth, 2, 0x444466);
        this.add.text(CONSTS.WIDTH / 2, dividerY, '  История  ', {
            fontSize: '12px',
            fill: '#666688',
            fontFamily: 'Arial',
            backgroundColor: '#1a1a2e'
        }).setOrigin(0.5);
        
        btnY += 25;
        
        // === ЗОНА ИСТОРИИ ДУЭЛЕЙ ===
        const historyStartY = btnY;
        const historyHeight = CONSTS.HEIGHT - historyStartY - 80;
        
        // Контейнер для истории дуэлей
        this.historyContainer = this.add.container(0, historyStartY);
        this.historyScrollY = 0;
        this.maxScrollY = 0;
        
        // Маска для обрезки содержимого
        const maskShape = this.make.graphics();
        maskShape.fillStyle(0xffffff);
        maskShape.fillRect(0, historyStartY, CONSTS.WIDTH, historyHeight);
        this.historyMask = maskShape.createGeometryMask();
        this.historyContainer.setMask(this.historyMask);
        
        // Загружаем историю
        this.loadDuelHistory(userData.id, historyHeight);
        
        // Обработка скролла - свайп и колесо
        this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
            if (pointer.y > historyStartY) {
                this.historyScrollY += deltaY * 0.5;
                this.historyScrollY = Phaser.Math.Clamp(this.historyScrollY, -this.maxScrollY, 0);
                this.historyContainer.y = historyStartY + this.historyScrollY;
            }
        });
        
        // Свайп для мобильных
        let dragStartY = 0;
        let lastDragY = 0;
        this.input.on('pointerdown', (pointer) => {
            if (pointer.y > historyStartY) {
                dragStartY = pointer.y;
                lastDragY = this.historyScrollY;
            }
        });
        this.input.on('pointermove', (pointer) => {
            if (pointer.isDown && dragStartY > historyStartY) {
                const delta = pointer.y - dragStartY;
                this.historyScrollY = lastDragY + delta;
                this.historyScrollY = Phaser.Math.Clamp(this.historyScrollY, -this.maxScrollY, 0);
                this.historyContainer.y = historyStartY + this.historyScrollY;
            }
        });
        
        // === НИЖНЯЯ ПАНЕЛЬ ===
        const bottomY = CONSTS.HEIGHT - 45;
        
        // Фон нижней панели
        this.add.rectangle(CONSTS.WIDTH / 2, bottomY, CONSTS.WIDTH, 70, 0x0f0f1a, 0.95);
        
        // Кнопка "Назад" слева
        this.createButton(
            70, bottomY,
            120, 45,
            '← Назад',
            0x34495e, 0x4a6278,
            () => this.scene.start('MenuScene'),
            '16px'
        );
        
        // Кнопка "Очистить" справа
        this.createButton(
            CONSTS.WIDTH - 70, bottomY,
            100, 40,
            '🗑️',
            0x7f8c8d, 0x95a5a6,
            () => this.confirmClearHistory(userData),
            '20px'
        );
    }
    
    // Хелпер для создания кнопок
    createButton(x, y, width, height, text, color, hoverColor, callback, fontSize = '18px') {
        const btn = this.add.rectangle(x, y, width, height, color, 1)
            .setInteractive({ useHandCursor: true });
        
        // Скругленные углы через графику
        const btnBg = this.add.graphics();
        btnBg.fillStyle(color, 1);
        btnBg.fillRoundedRect(x - width/2, y - height/2, width, height, 12);
        
        const btnText = this.add.text(x, y, text, {
            fontSize: fontSize,
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);
        
        btn.on('pointerover', () => {
            btnBg.clear();
            btnBg.fillStyle(hoverColor, 1);
            btnBg.fillRoundedRect(x - width/2, y - height/2, width, height, 12);
        });
        btn.on('pointerout', () => {
            btnBg.clear();
            btnBg.fillStyle(color, 1);
            btnBg.fillRoundedRect(x - width/2, y - height/2, width, height, 12);
        });
        btn.on('pointerdown', callback);
        
        return { btn, btnBg, btnText };
    }
    
    async createDuelChallenge(userData) {
        try {
            // Показываем loading
            const loadingText = this.add.text(
                CONSTS.WIDTH / 2, 
                CONSTS.HEIGHT / 2, 
                '⏳ Создание вызова...', 
                {
                    fontSize: '24px',
                    fill: '#FFD700',
                    fontFamily: 'Arial'
                }
            ).setOrigin(0.5);
            
            // Создаем вызов через API
            const response = await fetch(`${API_SERVER_URL}/api/duel/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    player1Id: userData.id,
                    player1Username: userData.username,
                    botUsername: 'monkey_test_crypto_bot' // Имя Telegram бота
                })
            });
            
            if (!response.ok) {
                throw new Error('Не удалось создать вызов');
            }
            
            const data = await response.json();
            
            loadingText.setText('✅ Вызов создан! Запуск игры...');
            
            // ВАЖНО: Сохраняем данные дуэли для показа диалога после игры
            this.lastCreatedDuel = data;
            
            // Автоматически запускаем игру для создателя
            setTimeout(() => {
                loadingText.destroy();
                
                // Запускаем игру в режиме дуэли для создателя (player1)
                this.scene.start('GameScene', {
                    mode: 'duel',
                    matchId: data.matchId,
                    seed: data.seed,
                    isCreator: true, // Флаг что это создатель
                    opponentUsername: 'Ожидание соперника...'
                });
            }, 1000);
            
        } catch (error) {
            console.error('❌ Ошибка создания вызова:', error);
            alert('Не удалось создать вызов. Попробуйте ещё.');
        }
    }
    
    showShareDialog(duelData) {
        // Затемнение фона
        const overlay = this.add.rectangle(
            0, 0, 
            CONSTS.WIDTH, 
            CONSTS.HEIGHT, 
            0x000000, 
            0.7
        ).setOrigin(0, 0).setInteractive();
        
        // Диалоговое окно
        const dialog = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2,
            CONSTS.WIDTH - 80,
            400,
            0x2c3e50
        ).setStrokeStyle(4, 0xFFD700).setDepth(0);
        
        // Заголовок
        const titleText = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 150,
            '✅ Вызов создан!',
            {
                fontSize: '28px',
                fill: '#FFD700',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setDepth(1);
        
        // Информация
        const infoText = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 80,
            `ID матча: ${duelData.matchId}\n` +
            `Истекает: ${new Date(duelData.expiresAt).toLocaleString()}`,
            {
                fontSize: '14px',
                fill: '#FFFFFF',
                fontFamily: 'Arial',
                align: 'center',
                lineSpacing: 8
            }
        ).setOrigin(0.5).setDepth(1);
        
        // Кнопка "Copy Match ID"
        const copyIdBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2,
            200,
            45,
            0x9b59b6
        ).setInteractive({ useHandCursor: true }).setDepth(1);
        
        const copyIdText = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2,
            '📋 Копировать ID',
            {
                fontSize: '16px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setDepth(2);
        
        copyIdBtn.on('pointerdown', () => {
            navigator.clipboard?.writeText(duelData.matchId);
            alert(`ID скопирован!\n${duelData.matchId}\n\nОтправьте его другу!`);
        });
        
        // Кнопка "Share in Telegram"
        const shareBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 80,
            280,
            60,
            0x0088cc
        ).setInteractive({ useHandCursor: true }).setDepth(1);
        
        const shareText = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 80,
            '📤 Поделиться в Telegram',
            {
                fontSize: '20px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setDepth(2);
        
        shareBtn.on('pointerdown', () => {
            // УЛУЧШЕНО: Используем современный Telegram WebApp API
            if (window.Telegram?.WebApp) {
                const tg = window.Telegram.WebApp;
                const shareUrl = duelData.duelLink;
                const userData = getTelegramUserId();
                const shareText = `🐵 ${userData.username || 'Я'} вызываю тебя на дуэль в Crypto Monkey!\n\nПрими вызов и докажи что ты лучший! 🏆`;
                
                // Вариант 1: switchInlineQuery (рекомендуется для ботов)
                if (tg.switchInlineQuery) {
                    try {
                        // Отправляет inline query в выбранный чат
                        tg.switchInlineQuery(duelData.matchId, ['users', 'groups', 'channels']);
                        console.log('✅ Используем switchInlineQuery');
                    } catch (e) {
                        console.warn('switchInlineQuery недоступен, используем openTelegramLink');
                        // Fallback на старый метод
                        tg.openTelegramLink(
                            `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`
                        );
                    }
                } 
                // Вариант 2: openTelegramLink (универсальный)
                else {
                    tg.openTelegramLink(
                        `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`
                    );
                    console.log('✅ Используем openTelegramLink');
                }
                
                // Показываем подтверждение
                tg.showPopup({
                    title: '✅ Вызов отправлен!',
                    message: 'Начинаем игру...',
                    buttons: [{ type: 'ok' }]
                });
            } else {
                // Fallback для веба: копируем ссылку
                navigator.clipboard?.writeText(duelData.duelLink);
                alert('🔗 Ссылка скопирована!\n\nОтправьте её другу для начала дуэли!');
            }
            
            // Уничтожаем все элементы диалога
            overlay.destroy();
            dialog.destroy();
            titleText.destroy();
            infoText.destroy();
            copyIdBtn.destroy();
            copyIdText.destroy();
            shareBtn.destroy();
            shareText.destroy();
            closeBtn.destroy();
            closeText.destroy();
        });
        
        // Кнопка "Close"
        const closeBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 160,
            200,
            50,
            0x95a5a6
        ).setInteractive({ useHandCursor: true }).setDepth(1);
        
        const closeText = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 160,
            'Закрыть',
            {
                fontSize: '18px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }
        ).setOrigin(0.5).setDepth(2);
        
        closeBtn.on('pointerdown', () => {
            overlay.destroy();
            dialog.destroy();
            titleText.destroy();
            infoText.destroy();
            copyIdBtn.destroy();
            copyIdText.destroy();
            shareBtn.destroy();
            shareText.destroy();
            closeBtn.destroy();
            closeText.destroy();
            this.loadDuelHistory(getTelegramUserId().id);
        });
    }
    
    // НОВОЕ: Диалог для ручного принятия вызова
    showAcceptDialog(userData) {
        // Затемнение фона
        const overlay = this.add.rectangle(
            0, 0, 
            CONSTS.WIDTH, 
            CONSTS.HEIGHT, 
            0x000000, 
            0.7
        ).setOrigin(0, 0).setInteractive();
        
        // Диалоговое окно
        const dialog = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2,
            CONSTS.WIDTH - 80,
            350,
            0x2c3e50
        ).setStrokeStyle(4, 0x27ae60);
        
        // Заголовок
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 120,
            '✅ Принять вызов',
            {
                fontSize: '28px',
                fill: '#2ecc71',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5);
        
        // Инструкция
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 60,
            'Введите ID матча из ссылки:',
            {
                fontSize: '18px',
                fill: '#ecf0f1',
                fontFamily: 'Arial'
            }
        ).setOrigin(0.5);
        
        // Создаем поле ввода через HTML input
        const inputHtml = document.createElement('input');
        inputHtml.type = 'text';
        inputHtml.placeholder = 'duel_123456789_abc';
        inputHtml.style.cssText = `
            position: fixed;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            width: 280px;
            height: 45px;
            font-size: 16px;
            padding: 10px;
            border: 2px solid #27ae60;
            border-radius: 8px;
            text-align: center;
            z-index: 1000;
        `;
        document.body.appendChild(inputHtml);
        inputHtml.focus();
        
        // Кнопка "Accept"
        const acceptBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 80,
            200,
            50,
            0x27ae60
        ).setInteractive({ useHandCursor: true });
        
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 80,
            '✅ Принять',
            {
                fontSize: '20px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5);
        
        acceptBtn.on('pointerdown', async () => {
            const matchId = inputHtml.value.trim();
            
            if (!matchId || !matchId.startsWith('duel_')) {
                alert('Неверный ID матча! Должен начинаться с "duel_"');
                return;
            }
            
            // Убираем диалог
            inputHtml.remove();
            overlay.destroy();
            dialog.destroy();
            this.children.list.slice(-5).forEach(child => child.destroy());
            
            // Показываем loading
            const loadingText = this.add.text(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2,
                '⏳ Принятие вызова...',
                {
                    fontSize: '24px',
                    fill: '#FFD700',
                    fontFamily: 'Arial Black'
                }
            ).setOrigin(0.5);
            
            try {
                // Получаем информацию о дуэли
                const duelResponse = await fetch(`${API_SERVER_URL}/api/duel/${matchId}`);
                
                if (!duelResponse.ok) {
                    throw new Error('Дуэль не найдена или истекла');
                }
                
                const duelData = await duelResponse.json();
                const duel = duelData.duel;
                
                // Проверяем статус
                if (duel.status !== 'pending') {
                    throw new Error('Дуэль уже началась или истекла');
                }
                
                // Принимаем вызов
                const acceptResponse = await fetch(`${API_SERVER_URL}/api/duel/${matchId}/accept`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        player2Id: userData.id,
                        player2Username: userData.username
                    })
                });
                
                if (!acceptResponse.ok) {
                    const errorData = await acceptResponse.json();
                    throw new Error(errorData.error || 'Failed to accept');
                }
                
                const acceptData = await acceptResponse.json();
                
                // Успешно принято - запускаем игру
                loadingText.setText('✅ Вызов принят! Запуск игры...');
                
                setTimeout(() => {
                    loadingText.destroy();
                    this.scene.start('GameScene', {
                        mode: 'duel',
                        matchId: matchId,
                        seed: acceptData.seed,
                        opponentUsername: duel.player1_username
                    });
                }, 1500);
                
            } catch (error) {
                console.error('❌ Ошибка принятия:', error);
                loadingText.destroy();
                alert(`Не удалось принять вызов: ${error.message}`);
            }
        });
        
        // Кнопка "Cancel"
        const cancelBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 140,
            200,
            50,
            0x95a5a6
        ).setInteractive({ useHandCursor: true });
        
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 140,
            'Отмена',
            {
                fontSize: '18px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }
        ).setOrigin(0.5);
        
        cancelBtn.on('pointerdown', () => {
            inputHtml.remove();
            overlay.destroy();
            dialog.destroy();
            this.children.list.slice(-5).forEach(child => child.destroy());
        });
    }
    
    async loadDuelHistory(userId, visibleHeight) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/duel/history/${userId}?limit=15`);
            
            if (!response.ok) {
                throw new Error('Failed to load history');
            }
            
            const data = await response.json();
            
            // Очищаем контейнер
            this.historyContainer.removeAll(true);
            
            if (data.duels.length === 0) {
                // Пустая история - красивое сообщение
                const emptyIcon = this.add.text(CONSTS.WIDTH / 2, 60, '🎮', {
                    fontSize: '48px'
                }).setOrigin(0.5);
                
                const emptyText = this.add.text(CONSTS.WIDTH / 2, 120, 
                    'Пока нет дуэлей\n\nСоздай вызов и отправь\nдругу ссылку!', {
                    fontSize: '16px',
                    fill: '#888899',
                    fontFamily: 'Arial',
                    align: 'center',
                    lineSpacing: 8
                }).setOrigin(0.5);
                
                this.historyContainer.add([emptyIcon, emptyText]);
                return;
            }
            
            const cardHeight = 75;
            const cardGap = 10;
            const cardWidth = CONSTS.WIDTH - 40;
            
            // Отображаем историю
            data.duels.forEach((duel, index) => {
                const y = index * (cardHeight + cardGap) + 10;
                const isPlayer1 = duel.player1_id === userId;
                const opponentName = isPlayer1 ? (duel.player2_username || '???') : duel.player1_username;
                const myScore = isPlayer1 ? duel.score1 : duel.score2;
                const opponentScore = isPlayer1 ? duel.score2 : duel.score1;
                
                // Определяем статус и цвет
                let statusIcon = '⏳';
                let statusText = 'Ожидание';
                let cardColor = 0x3d4663;
                let accentColor = 0xf39c12;
                
                if (duel.status === 'pending') {
                    statusIcon = '⏳';
                    statusText = 'Ожидание';
                    cardColor = 0x3d4663;
                    accentColor = 0xf39c12;
                } else if (duel.status === 'active') {
                    statusIcon = '🎮';
                    statusText = 'Играет';
                    cardColor = 0x2d4a7c;
                    accentColor = 0x3498db;
                } else if (duel.status === 'completed') {
                    const won = duel.winner === userId;
                    const draw = duel.winner === 'draw';
                    statusIcon = won ? '🏆' : (draw ? '🤝' : '💔');
                    statusText = won ? 'Победа!' : (draw ? 'Ничья' : 'Поражение');
                    cardColor = won ? 0x1e5631 : (draw ? 0x4a4a2e : 0x5c2323);
                    accentColor = won ? 0x2ecc71 : (draw ? 0xf1c40f : 0xe74c3c);
                } else if (duel.status === 'expired') {
                    statusIcon = '⏰';
                    statusText = 'Истекла';
                    cardColor = 0x333344;
                    accentColor = 0x7f8c8d;
                }
                
                // Карточка дуэли
                const cardBg = this.add.graphics();
                cardBg.fillStyle(cardColor, 1);
                cardBg.fillRoundedRect(20, y, cardWidth, cardHeight, 10);
                
                // Акцентная линия слева
                cardBg.fillStyle(accentColor, 1);
                cardBg.fillRoundedRect(20, y, 5, cardHeight, { tl: 10, bl: 10, tr: 0, br: 0 });
                
                // Иконка статуса
                const icon = this.add.text(45, y + cardHeight/2, statusIcon, {
                    fontSize: '28px'
                }).setOrigin(0, 0.5);
                
                // Имя соперника
                const nameText = this.add.text(85, y + 18, `vs ${opponentName}`, {
                    fontSize: '16px',
                    fill: '#FFFFFF',
                    fontFamily: 'Arial Black'
                });
                
                // Счёт
                const scoreStr = (myScore !== null && opponentScore !== null) 
                    ? `${myScore} : ${opponentScore}` 
                    : '— : —';
                const scoreText = this.add.text(85, y + 45, scoreStr, {
                    fontSize: '14px',
                    fill: '#aaaacc',
                    fontFamily: 'Arial'
                });
                
                // Статус справа
                const statusLabel = this.add.text(CONSTS.WIDTH - 35, y + cardHeight/2, statusText, {
                    fontSize: '12px',
                    fill: Phaser.Display.Color.IntegerToColor(accentColor).rgba,
                    fontFamily: 'Arial Black'
                }).setOrigin(1, 0.5);
                
                // Время (если завершена)
                if (duel.duration_seconds) {
                    const mins = Math.floor(duel.duration_seconds / 60);
                    const secs = Math.floor(duel.duration_seconds % 60);
                    const timeStr = mins > 0 ? `${mins}м ${secs}с` : `${secs}с`;
                    const timeText = this.add.text(CONSTS.WIDTH - 35, y + cardHeight/2 + 15, `⏱ ${timeStr}`, {
                        fontSize: '11px',
                        fill: '#666688',
                        fontFamily: 'Arial'
                    }).setOrigin(1, 0.5);
                    this.historyContainer.add(timeText);
                }
                
                this.historyContainer.add([cardBg, icon, nameText, scoreText, statusLabel]);
            });
            
            // Рассчитываем максимальный скролл
            const totalHeight = data.duels.length * (cardHeight + cardGap) + 20;
            this.maxScrollY = Math.max(0, totalHeight - (visibleHeight || (CONSTS.HEIGHT - 340)));
            
        } catch (error) {
            console.error('❌ Ошибка загрузки истории:', error);
            
            const errorText = this.add.text(CONSTS.WIDTH / 2, 80,
                '❌ Ошибка загрузки\n\nПроверьте подключение', {
                fontSize: '18px',
                fill: '#e74c3c',
                fontFamily: 'Arial',
                align: 'center'
            }).setOrigin(0.5);
            
            this.historyContainer.add(errorText);
        }
    }
    
    // НОВОЕ: Подтверждение очистки истории
    confirmClearHistory(userData) {
        // Затемнение
        const overlay = this.add.rectangle(
            0, 0, 
            CONSTS.WIDTH, 
            CONSTS.HEIGHT, 
            0x000000, 
            0.8
        ).setOrigin(0, 0).setInteractive().setDepth(100);
        
        // Диалог
        const dialog = this.add.graphics().setDepth(101);
        dialog.fillStyle(0x1a1a2e, 1);
        dialog.fillRoundedRect(40, CONSTS.HEIGHT/2 - 120, CONSTS.WIDTH - 80, 240, 16);
        dialog.lineStyle(3, 0xe74c3c);
        dialog.strokeRoundedRect(40, CONSTS.HEIGHT/2 - 120, CONSTS.WIDTH - 80, 240, 16);
        
        // Иконка предупреждения
        const warningIcon = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 80,
            '⚠️',
            { fontSize: '48px' }
        ).setOrigin(0.5).setDepth(102);
        
        // Текст предупреждения
        const warningText = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 20,
            'Очистить всю историю?\n\nЭто действие нельзя отменить!',
            {
                fontSize: '16px',
                fill: '#FFFFFF',
                fontFamily: 'Arial',
                align: 'center',
                lineSpacing: 8
            }
        ).setOrigin(0.5).setDepth(102);
        
        // Кнопка "Удалить"
        const deleteBtn = this.add.rectangle(
            CONSTS.WIDTH / 2 - 70,
            CONSTS.HEIGHT / 2 + 70,
            120,
            45,
            0xe74c3c
        ).setInteractive({ useHandCursor: true }).setDepth(101);
        
        const deleteText = this.add.text(
            CONSTS.WIDTH / 2 - 70,
            CONSTS.HEIGHT / 2 + 70,
            '🗑️ Удалить',
            {
                fontSize: '15px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setDepth(102);
        
        deleteBtn.on('pointerdown', async () => {
            try {
                const response = await fetch(`${API_SERVER_URL}/api/duel/history/${userData.id}`, {
                    method: 'DELETE'
                });
                
                // Закрываем диалог
                overlay.destroy();
                dialog.destroy();
                warningIcon.destroy();
                warningText.destroy();
                deleteBtn.destroy();
                deleteText.destroy();
                cancelBtn.destroy();
                cancelText.destroy();
                
                if (response.ok) {
                    // Перезагружаем историю
                    this.loadDuelHistory(userData.id, CONSTS.HEIGHT - 280);
                } else {
                    alert('Не удалось удалить историю');
                }
            } catch (e) {
                console.error('Ошибка удаления:', e);
            }
        });
        
        // Кнопка "Отмена"
        const cancelBtn = this.add.rectangle(
            CONSTS.WIDTH / 2 + 70,
            CONSTS.HEIGHT / 2 + 70,
            120,
            45,
            0x34495e
        ).setInteractive({ useHandCursor: true }).setDepth(101);
        
        const cancelText = this.add.text(
            CONSTS.WIDTH / 2 + 70,
            CONSTS.HEIGHT / 2 + 70,
            'Отмена',
            {
                fontSize: '15px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }
        ).setOrigin(0.5).setDepth(102);
        
        cancelBtn.on('pointerdown', () => {
            overlay.destroy();
            dialog.destroy();
            warningIcon.destroy();
            warningText.destroy();
            deleteBtn.destroy();
            deleteText.destroy();
            cancelBtn.destroy();
            cancelText.destroy();
        });
    }
}

// Класс сцены игры (с возвратом в меню при проигрыше)
class GameScene extends Phaser.Scene {
    constructor() {
    super({ key: 'GameScene' });
    this.player = null;
    this.playerSkin = null; // НОВОЕ: Активный скин игрока
    this.equippedItems = {}; // НОВОЕ: Все экипированные предметы
    this.jumpMultiplier = 1.0; // НОВОЕ: Множитель для прыжка (1.0 = нормально, 1.5 = +50%)
    this.hasShield = false; // НОВОЕ: Есть ли активный щит от падения
    this.boostActive = false; // НОВОЕ: Активен ли временный буст (3 секунды)
    this.boostTimer = null; // НОВОЕ: Таймер для буста
    this.boostTimerText = null; // НОВОЕ: UI для таймера буста
    this.boostDuration = 3000; // НОВОЕ: Длительность буста в миллисекундах (3 секунды)
    this.isFalling = false;
    this.isJumping = false; // НОВОЕ: Флаг для состояния прыжка
    this.lastBouncePlatform = null; // ФИКС: Запоминаем последнюю платформу с которой прыгнули
    this.platforms = null;
    this.score = 0;
    this.heightScore = 0;
    this.killScore = 0;
    this.scoreText = null;
    this.gameOver = false;
    this.aKey = null;
    this.dKey = null;
    this.rKey = null;
    this.escKey = null;
    this.wKey = null;
    this.minPlatformY = 0;
    this.pausedForConfirm = false;
    this.confirmElements = [];
    
    // ==================== 1V1 MODE VARIABLES ====================
    this.gameMode = 'solo'; // 'solo' или '1v1'
    this.gameSeed = null; // Seed для генерации платформ в 1v1
    this.seededRandom = null; // Экземпляр SeededRandom
    this.opponent = null; // Спрайт оппонента (ghost)
    this.opponentData = { x: 0, y: 0, isAlive: true, animation: 'idle' }; // Данные оппонента
    this.opponentNameText = null; // Текст с именем оппонента
    this.opponentScoreText = null; // Текст счета оппонента
    this.opponentFellText = null; // Текст "Opponent Fell"
    this.socket = null; // Socket.IO соединение
    this.roomId = null; // ID комнаты в 1v1
    this.gameStartTime = null; // Время старта игры
    this.gameDuration = 120000; // Длительность игры 2 минуты
    this.gameTimer = null; // Таймер 2 минуты
    this.timerText = null; // UI таймер
    this.lastUpdateTime = 0; // Последнее время отправки обновления
    this.clingPlatform = null;
    this.playerStartY = 0; // НОВОЕ: Стартовая позиция игрока для расчета score
    this.clingSide = null;
    // REMOVED: rockets и extraLives удалены - мёртвый код, никогда не использовались
    // Бустовая система работает через серверные equipped_items
    this.maxReachedY = Infinity; // НОВОЕ: Максимальная высота игрока (меньше = выше, т.к. Y инвертирован)
    this.rocketActive = false;
    this.previousAnimKey = null;
    this.dumbTimer = null;
    this.previousStandingPlatform = null;
    this.previousClingPlatform = null;
    this.ground = null;
    this.fallStartTime = null; // НОВОЕ: Время начала падения
    this.maxFallDuration = 1000; // НОВОЕ: Максимальное время падения в мс (1 секунда)
    this.groundAppeared = false; // НОВОЕ: Флаг появления земли (вместо groundMoving)
    
    // НОВОЕ: Флаги сенсорного управления
    this.touchLeft = false;
    this.touchRight = false;
    this.touchJump = false;
    this.touchZones = null;
}

    preload() {
        this.load.image('background_img', 'assets/background.png');
        this.load.image('playerSprite', 'assets/monkey_stand.png');
        this.load.image('playerJumpSprite', 'assets/monkey_jump.png');
        this.load.image('monkey_down_1', 'assets/monkey_down_1.png'); // НОВОЕ: Текстура падения 1
        this.load.image('monkey_down_2', 'assets/monkey_down_2.png'); // НОВОЕ: Текстура падения 2
        this.load.image('monkey_up', 'assets/monkey_up.png'); // НОВОЕ: Текстура подъёма (прыжка вверх)
        this.load.image('monkey_dumb', 'assets/monkey_dumb.png'); // НОВОЕ: Текстура удара головой
        this.load.image('monkey_fall_floor', 'assets/monkey_fall_floor_1.png'); // НОВОЕ: Текстура падения на землю
        this.load.image('monkey_walk_1', 'assets/monkey_walk_1.png'); // НОВОЕ: Анимация ходьбы 1
        this.load.image('monkey_walk_2', 'assets/monkey_walk_2.png'); // НОВОЕ: Анимация ходьбы 2
        this.load.image('platform', 'assets/balloon_green.png');
        this.load.image('balloon_under_player', 'assets/balloon_under_player.png'); // НОВОЕ: Текстура под игроком
        this.load.image('balloon_smash', 'assets/balloon_smash.png'); // НОВОЕ: Текстура smash
        this.load.image('balloon_unbreakable_smash', 'assets/balloon_blue_smash.png'); // НОВОЕ: Текстура smash для нелопающихся шариков
        this.load.image('balloon_dead', 'assets/balloon_dead.png'); // НОВОЕ: Текстура dead
        this.load.image('balloon_unbreakable', 'assets/balloon_blue.png'); // НОВОЕ: Текстура для нелопающихся шариков (синий цвет)
        this.load.image('ground', 'assets/ground.png');

        // Добавь логи для отладки загрузки (убери потом)
        this.load.on('filecomplete', (key) => console.log('Loaded texture:', key));
        this.load.on('loaderror', (file) => console.error('Load error:', file.key, file.src));
    }

    create(data) {
        // ==================== LOAD EQUIPPED ITEMS ====================
        const userData = getTelegramUserId();
        
        // Запускаем загрузку и продолжаем настройку игры
        this.loadEquippedItems(userData.id).then(() => {
            // После загрузки экипировки показываем бусты
            console.log('✅ Экипировка загружена, показываем бусты');
            
            // Применяем игровые эффекты бустов
            this.applyBoostEffects();
            
            this.showActiveBoosts();
        });
        
        // ==================== MODE INITIALIZATION ====================
        // Проверяем режим: solo / 1v1 (matchmaking) / duel (challenge)
        
        if (data && data.mode === 'duel') {
            // НОВОЕ: Режим дуэли (вызов на дуэль)
            this.gameMode = 'duel';
            this.gameSeed = data.seed;
            this.matchId = data.matchId;
            this.opponentUsername = data.opponentUsername || 'Opponent';
            this.duelCompleted = false;
            this.isCreator = data.isCreator || false; // Флаг создателя челленджа
            
            // Инициализируем seeded random для одинаковых платформ
            this.seededRandom = new SeededRandom(this.gameSeed);
            
            console.log('⚔️ Duel режим активирован!');
            console.log('   Match ID:', this.matchId);
            console.log('   Seed:', this.gameSeed);
            console.log('   Opponent:', this.opponentUsername);
            console.log('   Is Creator:', this.isCreator);
            
        } else if (data && data.mode === '1v1') {
            // Режим 1v1 matchmaking (существующий)
            this.gameMode = '1v1';
            this.gameSeed = data.seed;
            this.roomId = data.roomId;
            this.socket = data.socket;
            this.opponentData = {
                username: data.opponent.username,
                id: data.opponent.id,
                x: 0,
                y: 0,
                isAlive: true,
                score: 0
            };
            
            // Инициализируем seeded random
            this.seededRandom = new SeededRandom(this.gameSeed);
            
            console.log('🎮 1v1 режим активирован!');
            console.log('   Seed:', this.gameSeed);
            console.log('   Room:', this.roomId);
            console.log('   Opponent:', this.opponentData.username);
            
            // Устанавливаем обработчики Socket.IO
            this.setupSocketListeners();
        } else {
            this.gameMode = 'solo';
            console.log('🎮 Solo режим');
        }
        
        // Бусты загружаются с сервера через loadEquippedItems()
        // Старая localStorage система (rockets, extraLives) удалена как небезопасная

        // Сбрасываем счетчики
        this.score = 0;
        this.isFalling = false;
        this.heightScore = 0;
        this.killScore = 0;
        this.gameOver = false;
        this.pausedForConfirm = false;
        this.clingPlatform = null;
        this.rocketActive = false; // НОВОЕ
        this.previousAnimKey = null; // НОВОЕ: Сброс
        this.previousStandingPlatform = null;
        this.previousClingPlatform = null;
        this.fallStartTime = null; // НОВОЕ: Сброс таймера падения
        this.groundAppeared = false; // НОВОЕ: Сброс появления земли
        this.playerStartY = 0; // НОВОЕ: Сброс стартовой позиции

        // Фон с растяжкой (stretch) без повторения
        this.background = this.add.image(0, 0, 'background_img').setOrigin(0, 0).setScrollFactor(0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT); // Растягиваем на всю ширину и высоту

        // ФИКС: Более заметный счетчик (белый с черной обводкой)
        this.scoreText = this.add.text(16, 16, `Score: ${this.score}`, { 
            fontSize: '42px', 
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 6
        }).setScrollFactor(0).setDepth(100); // Увеличен depth чтобы был поверх всего

        // ==================== 1V1 UI ELEMENTS ====================
        if (this.gameMode === '1v1') {
            // Таймер (центр верху экрана)
            this.timerText = this.add.text(CONSTS.WIDTH / 2, 16, '2:00', {
                fontSize: '48px',
                fill: '#FFFF00',
                fontFamily: 'Arial Black',
                stroke: '#000000',
                strokeThickness: 6
            }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);
            
            // Счет оппонента (справа сверху)
            this.opponentScoreText = this.add.text(CONSTS.WIDTH - 16, 16, `Opponent: 0`, {
                fontSize: '32px',
                fill: '#FF6666',
                fontFamily: 'Arial',
                stroke: '#000000',
                strokeThickness: 4
            }).setOrigin(1, 0).setScrollFactor(0).setDepth(100);
            
            // Запускаем таймер обратного отсчета
            this.gameStartTime = this.time.now;
            this.gameDuration = 120000; // 2 минуты
        }

        this.anims.create({
            key: 'jump',
            frames: [{ key: 'playerJumpSprite' }, { key: 'playerSprite' }],
            frameRate: 10,
            repeat: 0,
            yoyo: false
        });

        // НОВОЕ: Анимация падения с задержкой 1 секунда на каждый фрейм
        this.anims.create({
            key: 'fall',
            frames: [
                { key: 'monkey_down_1', duration: 1000 }, // 1 секунда на первый фрейм (начало падения)
                { key: 'monkey_down_2', duration: 1000 } // 1 секунда на второй фрейм (продолжение падения)
            ],
            repeat: -1 // Зацикливаем, чтобы чередовать
        });

        // НОВОЕ: Анимация подъёма (прыжка вверх) - статичная текстура на время полёта вверх
        this.anims.create({
            key: 'rise',
            frames: [{ key: 'monkey_up' }], // Просто статичная текстура для подъёма
            frameRate: 1,
            repeat: -1 // Зацикливаем (хотя и статичная, чтобы не останавливалась)
        });

        this.createPlatforms();
        this.createPlayer();
        
        // Бусты показываются после загрузки экипировки (см. loadEquippedItems)
        
        // Коллайдер с платформами (без фильтра)
        this.collider = this.physics.add.collider(
            this.player, 
            this.platforms, 
            this.handlePlayerPlatformCollision, 
            null, // убран фильтр коллизий
            this
        );
        
        // ФИКС: Добавляем отдельный коллайдер для земли
        this.groundCollider = this.physics.add.collider(this.player, this.ground, this.handlePlayerPlatformCollision, null, this);
        // УБРАНО: startFollow - используем ручное управление камерой для избежания дерганья
        // this.cameras.main.startFollow(this.player, false, 0, 0);
        this.createKeys();
        this.physics.world.setBounds(0, -1000000, CONSTS.WIDTH, 2000000);
        this.scale.on('resize', this.handleResize, this);
        
        // ФИКС: Подписываемся на событие shutdown для очистки (важно для Telegram!)
        this.events.once('shutdown', this.cleanup, this);
    }

    createPlayer() {
        // ФИКС: Получаем землю (теперь это отдельный спрайт, не из группы)
        const ground = this.ground;

        // ФИКС: Вычисляем Y для центра игрока: центр земли минус половину высоты земли минус половину высоты игрока
        const playerHeight = 80; // ФИКС: Уменьшено (было 100) - меньше обезьянка
        const groundHalfHeight = ground.displayHeight / 2;
        const playerHalfHeight = playerHeight / 2;
        const playerY = ground.y - groundHalfHeight - playerHalfHeight;

        this.player = this.physics.add.sprite(CONSTS.WIDTH / 2, playerY, 'playerSprite');
        this.player.setScale(0.7);
        this.player.setBounce(0, CONSTS.PLAYER_BOUNCE);
        this.player.setVelocityY(0);
        
        // ФИКС Phase 2: Круглый hitbox для обезьянки - ЦЕНТРИРОВАННЫЙ
        const displayW = this.player.displayWidth;
        const displayH = this.player.displayHeight;

// Размеры квадратного хитбокса (75% от размера спрайта)
        const bodyWidth = displayW * 0.75;  // 75% от ширины
        const bodyHeight = displayH * 0.75; // 75% от высоты

// Центрируем хитбокс относительно спрайта
        const offsetX = (displayW - bodyWidth)* 1.5;
        const offsetY = (displayH - bodyHeight)* 2;

        this.player.body.setSize(bodyWidth, bodyHeight);
        this.player.body.setOffset(offsetX, offsetY);

        
        this.player.setOrigin(0.5, 0.5);
        this.player.setDepth(10);
        this.player.setCollideWorldBounds(true);
        this.player.body.maxVelocity.set(300, 1200);

        // ОТЛАДКА: Улучшенная визуализация хитбокса (ВРЕМЕННО)
        const debugGraphics = this.add.graphics();
        debugGraphics.setDepth(100);
        
        // Обновляем визуализацию каждый кадр
        this.events.on('update', () => {
            if (this.player && debugGraphics) {
                debugGraphics.clear();
                
                // 1. Красный прямоугольник = границы спрайта
                debugGraphics.lineStyle(2, 0xFF0000, 1);
                debugGraphics.strokeRect(
                    this.player.x - this.player.displayWidth / 2,
                    this.player.y - this.player.displayHeight / 2,
                    this.player.displayWidth,
                    this.player.displayHeight
                );
                
                // 2. Зеленый круг = физический хитбокс (ноги)
                debugGraphics.lineStyle(3, 0x00FF00, 1);
                debugGraphics.strokeCircle(
                    this.player.body.center.x,
                    this.player.body.center.y,
                    this.player.body.halfWidth
                );
                
                // 3. Желтая точка = центр спрайта
                debugGraphics.fillStyle(0xFFFF00, 1);
                debugGraphics.fillCircle(this.player.x, this.player.y, 3);
                
                // 4. Синяя точка = центр физического body
                debugGraphics.fillStyle(0x0000FF, 1);
                debugGraphics.fillCircle(this.player.body.center.x, this.player.body.center.y, 3);
                
                // 5. Горизонтальная линия = низ спрайта (где должны быть ноги)
                const spriteBottom = this.player.y + this.player.displayHeight / 2;
                debugGraphics.lineStyle(2, 0xFFFFFF, 1);
                debugGraphics.lineBetween(
                    this.player.x - 30, spriteBottom,
                    this.player.x + 30, spriteBottom
                );
            }
        });

        // ФИКС: Сразу idle-анимация (игрок стоит на земле)
        this.player.anims.stop();
        this.player.setTexture('playerSprite');

        // НОВОЕ: Создаем анимацию ходьбы
        this.anims.create({
            key: 'walk',
            frames: [
                { key: 'monkey_walk_1' },
                { key: 'monkey_walk_2' }
            ],
            frameRate: 10,  // Скорость анимации (кадров в секунду)
            repeat: -1       // Бесконечный повтор
        });

        // НОВОЕ: Запоминаем стартовую позицию игрока для расчета score
        this.playerStartY = playerY;
        this.maxReachedY = playerY; // НОВОЕ: Инициализируем максимальную достигнутую высоту

        console.log('✅ Player created at Y:', playerY, 'Ground Y:', ground.y);
        
        // ==================== OPPONENT GHOST (1V1 & DUEL MODES) ====================
        if (this.gameMode === '1v1') {
            this.createOpponentGhost(playerY);
            
            // ВАЖНО: Отправляем начальную позицию сразу же!
            // Это гарантирует что оппонент увидит нас в правильной позиции
            this.sendPlayerUpdate();
            console.log('📤 Отправлена начальная позиция игрока');
        } else if (this.gameMode === 'duel') {
            // НОВОЕ: Создаем ghost для режима дуэли
            this.createOpponentGhost(playerY);
            
            // Инициализируем данные оппонента для duel
            this.opponentData = {
                username: this.opponentUsername,
                x: CONSTS.WIDTH / 2,
                y: playerY,
                isAlive: true,
                score: 0,
                hasStarted: false // Флаг начала игры оппонентом
            };
            
            // Запускаем polling позиции оппонента
            this.startDuelPolling();
            console.log('⚔️ Duel: создан ghost и запущен polling');
        }
    }
    
    createOpponentGhost(startY) {
        // Создаем полупрозрачного ghost оппонента
        // ВАЖНО: Начальная позиция ВСЕГДА совпадает с позицией своего игрока
        // Реальная позиция оппонента придёт через первый opponentUpdate
        this.opponent = this.add.sprite(CONSTS.WIDTH, startY, 'playerSprite');
        this.opponent.setScale(0.7);
        this.opponent.setAlpha(0.6); // Немного увеличена прозрачность (было 0.5)
        this.opponent.setTint(0x6666FF); // Синий оттенок вместо красного (легче отличить)
        this.opponent.setDepth(9); // Чуть ниже основного игрока
        
        // ИСПРАВЛЕНИЕ: Скрываем призрака до первого opponentUpdate
        this.opponent.setVisible(false);
        this.opponentInitialized = false; // Флаг что призрак еще не получил реальную позицию
        
        // Добавляем пульсирующий эффект для лучшей видимости (запустится после показа)
        this.opponentPulseTween = this.tweens.add({
            targets: this.opponent,
            alpha: 0.4,
            duration: 1000,
            ease: 'Sine.easeInOut',
            yoyo: true,
            repeat: -1,
            paused: true // Ставим на паузу до первого показа
        });
        
        console.log('👻 Opponent ghost создан');
        console.log('   Ghost Y:', this.opponent.y, 'Player Y:', this.player.y);
        console.log('   ⚠️ Ожидаем первый opponentUpdate для реальной позиции');
        
        // Добавляем имя оппонента над ним
        this.opponentNameText = this.add.text(0, -50, this.opponentData.username, {
            fontSize: '20px',
            fill: '#6666FF', // Синий цвет (соответствует tint)
            fontFamily: 'Arial',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5).setDepth(9);
        
        // Скрываем имя до первого появления
        this.opponentNameText.setVisible(false);
        
        // Обновляем позицию текста
        this.updateOpponentNamePosition();
        
        console.log('👻 Opponent ghost создан для:', this.opponentData.username);
    }
    
    updateOpponentNamePosition() {
        if (this.opponent && this.opponentNameText) {
            // Позиция текста относительно экрана (не мировых координат)
            const screenPos = this.cameras.main.getWorldPoint(
                this.opponent.x, 
                this.opponent.y - 50
            );
            this.opponentNameText.setPosition(this.opponent.x, this.opponent.y - 50);
        }
    }

    setupPlatformBody(platform) {
        platform.refreshBody(); // Обновляем позицию/размер (общее для всех)
        const body = platform.body;

        if (platform.isGround) {
            // Для земли — прямоугольный body (полная ширина/высота после scale)
            body.setSize(platform.displayWidth, platform.displayHeight);
            body.checkCollision.down = true; // Полная коллизия снизу (не проваливаться сквозь землю)
            body.checkCollision.left = true;
            body.checkCollision.right = true;
            body.checkCollision.up = true; // Добавляем up, если нужно отскок головой от земли
            console.log('Ground body setup: Rectangle', body.width, body.height);
        } else {
            // Для обычных платформ — круглый body (как раньше)
            // ФИКС Phase 2: Уменьшаем радиус до 0.7 для еще более плавного пролета
            const radius = (platform.displayWidth / 2) * 0.7; // Было 0.8, стало 0.7
            
            // ФИКС: Центрируем круг относительно спрайта
            const offsetX = (platform.displayWidth - radius * 2) / 2;  // Центрирование по X
            const offsetY = (platform.displayHeight - radius * 2) / 2; // Центрирование по Y
            body.setCircle(radius, offsetX, offsetY);
            
            // ФИКС: Отключаем боковые коллизии чтобы обезьянка не цеплялась при пролете
            body.checkCollision.down = false; // Без коллизии снизу (прыжки сквозь)
            body.checkCollision.left = false;  // Без коллизии слева (свободный пролет)
            body.checkCollision.right = false; // Без коллизии справа (свободный пролет)
            body.checkCollision.up = true;     // Только коллизия сверху (приземление на платформу)
            console.log('Platform body setup: Circle radius', radius, 'из', platform.displayWidth, 'offset:', offsetX, offsetY);
        }
    }

    // ==================== 1V1 SOCKET.IO HANDLERS ====================
    setupSocketListeners() {
        if (!this.socket) return;
        
        // Получаем обновления позиции оппонента
        this.socket.on('opponentUpdate', (data) => {
            console.log('📥 Получено обновление оппонента:', {
                x: data.x,
                y: data.y,
                score: data.score,
                isAlive: data.isAlive
            });
            
            this.opponentData.x = data.x;
            this.opponentData.y = data.y;
            this.opponentData.isAlive = data.isAlive;
            this.opponentData.score = data.score || 0;
            
            // Если оппонент умер - показываем это и не двигаем ghost
            if (!data.isAlive && this.opponent) {
                console.log('💀 Оппонент упал!');
                
                // Оставляем ghost на его последней позиции (НЕ обновляем)
                // Но обновляем один раз если это первый раз когда он умер
                if (this.opponentData.isAlive) {
                    // Первый раз получили что он мертв
                    
                    // РЕШЕНИЕ: Проверяем виден ли ghost на экране
                    const cameraTop = this.cameras.main.scrollY;
                    const cameraBottom = this.cameras.main.scrollY + CONSTS.HEIGHT;
                    
                    // Если оппонент упал далеко вниз (за пределы камеры) - прячем ghost
                    if (data.y > cameraBottom + 200) {
                        console.log('👻 Ghost оппонента за пределами камеры - прячем');
                        this.opponent.setVisible(false);
                    } else {
                        // Если в пределах видимости - показываем серым
                        this.opponent.setPosition(data.x, data.y);
                        this.opponent.setAlpha(0.3);
                        this.opponent.setTint(0x888888); // Серый
                    }
                }
                
                // Показываем текст "Opponent Fell"
                if (!this.opponentFellText) {
                    this.opponentFellText = this.add.text(
                        CONSTS.WIDTH / 2, 
                        CONSTS.HEIGHT / 2 - 100, 
                        'Opponent Fell!',
                        {
                            fontSize: '42px',
                            fill: '#00FF00',
                            fontFamily: 'Arial Black',
                            stroke: '#000000',
                            strokeThickness: 6,
                            align: 'center'
                        }
                    ).setOrigin(0.5).setScrollFactor(0).setDepth(150);
                }
                
                // Обновляем данные (чтобы знать что он уже мертв)
                this.opponentData.isAlive = false;
                return; // Не обновляем позицию мертвого ghost
            }
            
            // Обновляем позицию ghost спрайта (с интерполяцией)
            if (this.opponent && this.opponentData.isAlive) {
                // ПЕРВОЕ ПОЯВЛЕНИЕ: Показываем призрака при первом обновлении
                if (!this.opponentInitialized) {
                    console.log('👻 ПЕРВОЕ появление призрака на реальной позиции!');
                    this.opponent.setPosition(data.x, data.y); // Ставим сразу без анимации
                    this.opponent.setVisible(true); // Показываем
                    this.opponentPulseTween.play(); // Запускаем пульсацию
                    this.opponentInitialized = true;
                    
                    // Показываем имя оппонента
                    if (this.opponentNameText) {
                        this.opponentNameText.setVisible(true);
                    }
                } else {
                    // Обычное обновление с интерполяцией
                    console.log('👻 Обновляю позицию ghost на X:', data.x, 'Y:', data.y);
                    
                    // Плавная интерполяция позиции (увеличена длительность для плавности)
                    this.tweens.add({
                        targets: this.opponent,
                        x: data.x,
                        y: data.y,
                        duration: 200, // Увеличено со 100ms до 200ms
                        ease: 'Cubic.easeOut' // Более плавное замедление
                    });
                }
                
                console.log('   Текущая позиция ghost:', this.opponent.x, this.opponent.y);
                console.log('   Ghost visible:', this.opponent.visible);
            } else {
                console.log('⚠️ Ghost не обновлен! opponent:', !!this.opponent, 'isAlive:', this.opponentData.isAlive);
            }
        });
        
        // Оппонент отключился
        this.socket.on('opponentDisconnected', (data) => {
            console.log('🔌 Оппонент отключился:', data.message);
            
            // Показываем сообщение о победе
            const winText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Соперник отключился!\nВы победили!', {
                fontSize: '42px',
                fill: '#00FF00',
                fontFamily: 'Arial Black',
                stroke: '#000000',
                strokeThickness: 6,
                align: 'center'
            }).setOrigin(0.5).setScrollFactor(0).setDepth(200);
            
            // Возврат в меню через 3 секунды
            this.time.delayedCall(3000, () => {
                this.cleanup();
                this.scene.start('MenuScene');
            });
        });
        
        // Игра окончена
        this.socket.on('gameEnd', (data) => {
            console.log('🏁 Игра окончена:', data);
            this.handleGameEnd(data);
        });
    }
    
    // Отправка обновлений позиции серверу (вызывается из update)
    sendPlayerUpdate() {
        if (this.socket && this.gameMode === '1v1') {
            const updateData = {
                x: this.player.x,
                y: this.player.y,
                isAlive: !this.gameOver,
                score: this.score
            };
            console.log('📤 Отправляю обновление:', updateData);
            this.socket.emit('playerUpdate', updateData);
        }
    }
    
    // ==================== DUEL MODE POLLING ====================
    startDuelPolling() {
        const userData = getTelegramUserId();
        
        // Polling позиции оппонента каждые 500ms
        this.duelPositionInterval = setInterval(async () => {
            if (this.gameOver || !this.matchId) {
                clearInterval(this.duelPositionInterval);
                return;
            }
            
            try {
                // Отправляем свою позицию
                await fetch(`${API_SERVER_URL}/api/duel/${this.matchId}/position`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        playerId: userData.id,
                        x: this.player.x,
                        y: this.player.y,
                        score: Math.round(this.score),
                        isAlive: !this.gameOver
                    })
                });
                
                // Получаем позицию оппонента
                const response = await fetch(`${API_SERVER_URL}/api/duel/${this.matchId}/opponent/${userData.id}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data.success && data.opponent) {
                        this.updateDuelOpponent(data.opponent);
                    }
                }
            } catch (error) {
                console.error('❌ Duel polling error:', error);
            }
        }, 500);
        
        console.log('⏰ Duel polling started');
    }
    
    updateDuelOpponent(opponentData) {
        if (!this.opponent || !opponentData) return;
        
        // Обновляем данные оппонента
        this.opponentData.hasStarted = opponentData.hasStarted;
        this.opponentData.isAlive = opponentData.isAlive;
        this.opponentData.score = opponentData.score || 0;
        
        // Если оппонент еще не начал - показываем неактивную тень
        if (!opponentData.hasStarted) {
            this.opponent.setVisible(true);
            this.opponent.setAlpha(0.2);
            this.opponent.setTint(0x555555); // Темно-серый
            // Держим на стартовой позиции
            return;
        }
        
        // Оппонент начал игру - активируем тень
        if (!this.opponentData.wasActive) {
            this.opponentData.wasActive = true;
            this.opponent.setAlpha(0.6);
            this.opponent.setTint(0xFF6B6B); // Красноватый
            console.log('✅ Оппонент начал игру!');
        }
        
        // Обновляем позицию оппонента
        if (opponentData.x !== null && opponentData.y !== null) {
            this.opponent.setVisible(true);
            
            // Если оппонент мертв - показываем как серый и неподвижный
            if (!opponentData.isAlive) {
                this.opponent.setAlpha(0.3);
                this.opponent.setTint(0x888888);
                // Не обновляем позицию - оставляем на месте падения
                return;
            }
            
            // Плавное обновление позиции
            this.tweens.add({
                targets: this.opponent,
                x: opponentData.x,
                y: opponentData.y,
                duration: 400,
                ease: 'Linear'
            });
            
            // Обновляем текст счета оппонента
            if (this.opponentScoreText) {
                this.opponentScoreText.setText(`${opponentData.score || 0}`);
            }
        }
    }
    
    // Обработка окончания 1v1 игры
    handleGameEnd(data) {
        this.gameOver = true;
        
        // Останавливаем физику
        this.physics.pause();
        
        // Показываем результаты
        const resultText = data.winner ? 'Вы победили!' : 'Вы проиграли!';
        const resultColor = data.winner ? '#00FF00' : '#FF0000';
        
        const resultBg = this.add.graphics();
        resultBg.fillStyle(0x000000, 0.8);
        resultBg.fillRect(0, 0, CONSTS.WIDTH, CONSTS.HEIGHT);
        resultBg.setScrollFactor(0).setDepth(200);
        
        this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 3, resultText, {
            fontSize: '64px',
            fill: resultColor,
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 8
        }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
        
        // Статистика (округляем счет до целых)
        const yourScoreRounded = Math.floor(data.yourScore);
        const opponentScoreRounded = Math.floor(data.opponentScore);
        const statsText = `Ваш счёт: ${yourScoreRounded}\nСоперник: ${opponentScoreRounded}\n\nПричина: ${data.reason}`;
        this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, statsText, {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial',
            align: 'center',
            lineSpacing: 10
        }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
        
        // Кнопка возврата в меню
        const menuGraphics = this.add.graphics().setScrollFactor(0).setDepth(200);
        menuGraphics.fillStyle(0x0066CC, 1);
        menuGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 120, CONSTS.HEIGHT - 120, 240, 55, 8);
        
        const menuZone = this.add.rectangle(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 92.5, 240, 55, 0x000000, 0)
            .setScrollFactor(0)
            .setDepth(202)
            .setInteractive({ useHandCursor: true });
        
        const menuButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 92.5, 'Вернуться в меню', {
            fontSize: '32px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(203);
        
        menuZone.on('pointerdown', () => {
            this.cleanup();
            this.scene.start('MenuScene');
        });
    }

    createPlatforms() {
        this.platforms = this.physics.add.staticGroup();

        // ФИКС для 1v1: Используем ФИКСИРОВАННУЮ высоту земли для синхронизации игроков
        // В solo режиме используем реальную высоту экрана
        const groundStartY = this.gameMode === '1v1' 
            ? 1334 - 100  // ФИКСИРОВАННАЯ высота (как на iPhone, самый распространенный размер)
            : CONSTS.HEIGHT - 100; // В solo - используем реальную высоту экрана
        
        // ФИКС: Создаем землю как ОТДЕЛЬНЫЙ статический спрайт (не в группе platforms!)
        this.ground = this.physics.add.staticSprite(CONSTS.WIDTH / 2, groundStartY, 'ground');
        this.ground.setScale(CONSTS.WIDTH / this.ground.displayWidth, 2); // ФИКС: Увеличена высота земли в 2 раза чтобы было сложнее промахнуться
        this.ground.setAlpha(1); // ИЗМЕНЕНО: Видимая изначально
        this.ground.isGround = true; // Пометка: это земля, не рециклить и не smash
        this.ground.isLanded = false;
        this.ground.smashStartTime = null;
        this.ground.initialY = groundStartY; // НОВОЕ: Запоминаем начальную позицию
        this.setupPlatformBody(this.ground); // ФИКС: Вызов функции
        
        console.log('🌍 Земля создана на Y:', groundStartY, '(режим:', this.gameMode + ')');

        // НОВОЕ: Вычисляем стартовую позицию игрока (чуть выше земли)
        const playerStartY = groundStartY - this.ground.displayHeight / 2 - 50; // 50 - половина высоты игрока
        
        // НОВОЕ: Обычные платформы выше игрока (относительно стартовой позиции)
        // Первая платформа ближе к земле (150px), чтобы игрок мог допрыгнуть!
        // ИЗМЕНЕНО: Увеличено количество шаров с 12 до 25
        for (let i = 1; i <= 25; i++) {
            let gap;
            if (i === 1) {
                gap = 150; // Первая платформа близко - игрок точно допрыгнет с земли
            } else if (i === 2) {
                gap = 150 + 200; // Вторая на расстоянии 200 от первой
            } else {
                gap = 150 + 200 + ((i - 2) * CONSTS.PLATFORM_GAP); // Остальные с обычным шагом
            }
            const platformY = playerStartY - gap;
            
            // Используем seeded RNG для X позиции в 1v1 режиме
            const platformX = this.gameMode === '1v1' && this.seededRandom
                ? this.seededRandom.intRange(100, CONSTS.WIDTH - 100)
                : Phaser.Math.Between(100, CONSTS.WIDTH - 100);
            
            // Строка 526 (в createPlatforms)
            let platform = this.platforms.create(platformX, platformY, 'platform');
            //platform.setScale(0.1);
            platform.isLanded = false;
            platform.smashStartTime = null;
            
            // НОВОЕ: Назначаем тип платформы
            platform.platformType = this.choosePlatformType();
            
            // ФИКС: Первый шар всегда синий (нелопающийся) - i начинается с 1!
            if (i === 1) {
                platform.platformType = 'unbreakable';
            }
            
            // НОВОЕ: Настройка для движущихся платформ
            if (platform.platformType === 'moving') {
                platform.initialX = platform.x;
                platform.moveSpeed = CONSTS.MOVING_PLATFORM_SPEED;
                platform.moveRange = CONSTS.MOVING_PLATFORM_RANGE;
                platform.moveDirection = 1; // 1 = вправо, -1 = влево
            }
            
            // НОВОЕ: Настройка для нелопающихся платформ (синий цвет)
            // ФИКС: Единый масштаб 1.8x1.5 для консистентности
            if (platform.platformType === 'unbreakable') {
                platform.setTexture('balloon_unbreakable');
                platform.setScale(1.8, 1.5);
            }
            
            this.setupPlatformBody(platform); // ФИКС: Вызов функции
            console.log('🎈 Платформа', i, 'создана на Y:', platformY, 'gap:', gap, 'тип:', platform.platformType);
        }
        
        console.log('🎈 Создано платформ (всего):', this.platforms.children.entries.length);

        // ИЗМЕНЕНО: Кэшируем нижнюю границу земли для камеры и score (не пересчитывать каждый кадр)
        this.groundBottom = this.ground.y + (this.ground.displayHeight / 2); // Должно быть 64.5 (лог: Ground bottom: 64.5)
        // Например, 50px, если height=100
        console.log('Ground bottom cached:', this.groundBottom);
        console.log('Ground Y:', this.ground.y, 'Ground Height:', this.ground.displayHeight); // Для дебага (убери потом)
    }

    createKeys() {
        this.aKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);
        this.dKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D);
        this.rKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
        this.escKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ESC); // Добавляем клавишу ESC
        this.wKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W); // Добавляем клавишу W для прыжка
        
        // НОВОЕ: Сенсорное управление для мобильных устройств
        this.setupTouchControls();
    }

    // НОВОЕ: Настройка сенсорного управления
    setupTouchControls() {
        // Флаги для отслеживания касаний
        this.touchLeft = false;
        this.touchRight = false;
        this.touchJump = false;
        
        // Создаем невидимые зоны для касаний (визуализация для отладки)
        const debugTouch = false; // Установи true для отладки зон касания
        
        // Левая зона (1/3 экрана слева) - движение влево
        const leftZone = this.add.rectangle(0, 0, CONSTS.WIDTH / 3, CONSTS.HEIGHT, debugTouch ? 0xff0000 : 0x000000, debugTouch ? 0.2 : 0)
            .setOrigin(0, 0)
            .setScrollFactor(0)
            .setDepth(90)
            .setInteractive();
        
        // Правая зона (1/3 экрана справа) - движение вправо
        const rightZone = this.add.rectangle(CONSTS.WIDTH * 2/3, 0, CONSTS.WIDTH / 3, CONSTS.HEIGHT, debugTouch ? 0x0000ff : 0x000000, debugTouch ? 0.2 : 0)
            .setOrigin(0, 0)
            .setScrollFactor(0)
            .setDepth(90)
            .setInteractive();
        
        // Центральная зона (1/3 экрана в центре) - прыжок
        const jumpZone = this.add.rectangle(CONSTS.WIDTH / 3, 0, CONSTS.WIDTH / 3, CONSTS.HEIGHT, debugTouch ? 0x00ff00 : 0x000000, debugTouch ? 0.2 : 0)
            .setOrigin(0, 0)
            .setScrollFactor(0)
            .setDepth(90)
            .setInteractive();
        
        // Обработчики для левой зоны
        leftZone.on('pointerdown', () => {
            this.touchLeft = true;
            console.log('👈 Touch LEFT start');
        });
        leftZone.on('pointerup', () => {
            this.touchLeft = false;
            console.log('👈 Touch LEFT end');
        });
        leftZone.on('pointerout', () => {
            this.touchLeft = false;
        });
        
        // Обработчики для правой зоны
        rightZone.on('pointerdown', () => {
            this.touchRight = true;
            console.log('👉 Touch RIGHT start');
        });
        rightZone.on('pointerup', () => {
            this.touchRight = false;
            console.log('👉 Touch RIGHT end');
        });
        rightZone.on('pointerout', () => {
            this.touchRight = false;
        });
        
        // Обработчики для центральной зоны (прыжок)
        jumpZone.on('pointerdown', () => {
            if (!this.touchJump) { // Только один раз на каждое касание
                this.touchJump = true;
                this.handleJump(); // Вызываем прыжок
                console.log('⬆️ Touch JUMP');
            }
        });
        jumpZone.on('pointerup', () => {
            this.touchJump = false;
        });
        jumpZone.on('pointerout', () => {
            this.touchJump = false;
        });
        
        // Сохраняем зоны для возможной очистки
        this.touchZones = [leftZone, rightZone, jumpZone];
        
        console.log('📱 Сенсорное управление активировано!');
    }
    
    // НОВОЕ: Метод для скрытия сенсорных зон (при Game Over, паузе и т.д.)
    hideTouchZones() {
        if (this.touchZones && this.touchZones.length > 0) {
            console.log('🗑️ УНИЧТОЖАЕМ сенсорные зоны полностью!');
            this.touchZones.forEach(zone => {
                if (zone && zone.destroy) {
                    zone.removeAllListeners(); // Удаляем ВСЕ обработчики
                    zone.destroy(); // ПОЛНОСТЬЮ уничтожаем объект
                }
            });
            this.touchZones = []; // Очищаем массив
            this.touchLeft = false;
            this.touchRight = false;
            this.touchJump = false;
            console.log('✅ Сенсорные зоны полностью уничтожены');
        } else {
            console.log('⚠️ Сенсорные зоны уже уничтожены или не созданы');
        }
    }
    
    // НОВОЕ: Метод для показа сенсорных зон (при рестарте)
    showTouchZones() {
        // ИЗМЕНЕНО: Пересоздаём зоны заново вместо показа старых
        console.log('� Пересоздаём сенсорные зоны...');
        this.hideTouchZones(); // Сначала удаляем старые
        this.setupTouchControls(); // Создаём новые
    }
    
    // НОВОЕ: Метод для обработки прыжка (вынесен отдельно для переиспользования)
    handleJump() {
        const standingPlatform = this.getStandingPlatform();
        // ИЗМЕНЕНО: Убрана логика с clingPlatform, только прыжок со стоящей платформы
        if (standingPlatform) {
            // НОВОЕ: Обработка ручного прыжка с нелопающихся шариков
            if (standingPlatform.platformType === 'unbreakable') {
                console.log('🔵 Прыжок с нелопающегося шарика!');
                this.player.body.setAllowGravity(true);
                this.player.setVelocityY(CONSTS.JUMP_VELOCITY * this.jumpMultiplier);
                this.player.anims.stop();
                this.player.setTexture('monkey_up'); // ФИКС: Статичная текстура вместо анимации
                return;
            }
            
            // НОВОЕ: Остановка движения для движущихся платформ при прыжке
            if (standingPlatform.platformType === 'moving' && !standingPlatform.isLanded) {
                console.log('🟢 Остановили движущийся шарик при прыжке');
                standingPlatform.isLanded = true;
            }
            
            // ФИКС: СРАЗУ ставим smash при прыжке - только для лопающихся!
            if (standingPlatform.isLanded && !standingPlatform.smashStartTime && !standingPlatform.isGround && standingPlatform.platformType !== 'unbreakable') {
                console.log('🎯 Прыжок! Сразу ставим smash, платформа:', standingPlatform.texture.key);
                standingPlatform.setTexture('balloon_smash');
                standingPlatform.smashStartTime = this.time.now;
            }
            
            this.player.body.setAllowGravity(true);
            this.player.setVelocityY(CONSTS.JUMP_VELOCITY * this.jumpMultiplier); // С учётом буста
            this.player.anims.stop();
            this.player.setTexture('monkey_up'); // ФИКС: Статичная текстура вместо анимации
        }
    }

    // НОВОЕ: Метод для случайного выбора типа платформы на основе процентов
    choosePlatformType() {
        // Используем сиженный RNG в 1v1 режиме
        const rand = this.gameMode === '1v1' && this.seededRandom
            ? this.seededRandom.intRange(1, 100)
            : Phaser.Math.Between(1, 100); // Случайное число от 1 до 100
        
        if (rand <= CONSTS.PLATFORM_TYPE_NORMAL_PERCENT) {
            return 'normal'; // 1-60: обычный (60%)
        } else if (rand <= CONSTS.PLATFORM_TYPE_NORMAL_PERCENT + CONSTS.PLATFORM_TYPE_MOVING_PERCENT) {
            return 'moving'; // 61-90: движущийся (30%)
        } else {
            return 'unbreakable'; // 91-100: нелопающийся (10%)
        }
    }

    // НОВОЕ: Метод для расчета целевого количества платформ в зависимости от очков
    getTargetPlatformCount() {
        const displayScore = Math.floor(this.score / CONSTS.SCORE_HEIGHT_INCREMENT) * CONSTS.SCORE_HEIGHT_INCREMENT;
        
        // До 5000 очков - максимум 25 шаров
        if (displayScore < 5000) {
            return 25;
        }
        
        // От 5000 до 10000 - постепенное уменьшение с 25 до 12
        if (displayScore < 10000) {
            const progress = (displayScore - 5000) / 5000; // 0.0 до 1.0
            const targetCount = Math.floor(25 - (13 * progress)); // 25 -> 12
            return Math.max(12, targetCount); // Минимум 12
        }
        
        // После 10000 - остается 12 шаров
        return 12;
    }

    handlePlayerPlatformCollision(playerObj, platformObj) {
    const player = playerObj; // Упрощаем для удобства
    
    // ВАЖНО: Обработка земли
    if (platformObj.isGround && player.body.touching.down) {
        // Если земля ПОЯВИЛАСЬ (groundAppeared = true) - это game over!
        if (this.groundAppeared) {
            console.log('💥 GAME OVER: Игрок коснулся появившейся земли!');
            // Показываем текстуру падения на землю
            this.player.anims.stop();
            this.player.setTexture('monkey_fall_floor');
            // Останавливаем движение
            player.setVelocity(0);
            this.isFalling = false;
            // Запускаем последовательность game over
            this.handleGameOverOnGround();
            return; // Выходим
        }
        // Если земля начальная (groundAppeared = false) - просто стоим на ней
        // Ничего не делаем, это нормальная коллизия
        return;
    }
    
    if (platformObj.isGround) {
        console.log('Hit ground! Touching down:', player.body.touching.down, 'Velocity Y:', player.body.velocity.y, 'groundAppeared:', this.groundAppeared);
    }
    // НОВОЕ: Обработка удара головой (touching.up)
    if (player.body.touching.up) {
        // Сохраняем предыдущую анимацию
        this.previousAnimKey = this.player.anims.currentAnim ? this.player.anims.currentAnim.key : null;
        // Останавливаем анимацию и ставим текстуру удара
        this.player.anims.stop();
        this.player.setTexture('monkey_dumb');
        // Отталкиваем вниз (маленький отскок)
        player.setVelocityY(100); // Лёгкий толчок вниз
        // Таймер для возврата (0.5 секунды)
        if (this.dumbTimer) {
            this.dumbTimer.remove(); // Удаляем предыдущий таймер, если есть
        }
        this.dumbTimer = this.time.delayedCall(500, () => {
            // Возвращаем предыдущую анимацию или idle
            if (this.previousAnimKey) {
                this.player.anims.play(this.previousAnimKey); // ФИКС: Убрали true
            } else {
                this.player.setTexture('playerSprite');
            }
            this.isFalling = false;
            this.previousAnimKey = null;
        });
        return; // Выходим, чтобы не обрабатывать другие касания
    }
    // НОВОЕ: Автоматический прыжок при касании платформы сверху (только для шариков, не земли)
    // ФИКС: Прыгаем только если это НЕ та же платформа, с которой мы только что прыгнули
    if (player.body.touching.down && !platformObj.isGround && player.body.velocity.y >= 0 && platformObj !== this.lastBouncePlatform) {
        // НОВОЕ: Обработка нелопающихся шариков
        if (platformObj.platformType === 'unbreakable') {
    console.log('🔵 Прыжок с нелопающегося шарика!');
    player.setVelocityY(CONSTS.JUMP_VELOCITY * this.jumpMultiplier); // С учётом буста
    this.player.anims.stop();
    this.player.setTexture('monkey_up');
    
    // НОВОЕ: Эффект пружины для синего шара
    platformObj.setTexture('balloon_unbreakable_smash'); // Меняем на сжатую текстуру
    
    // Анимация сжатия (пружина)
    this.tweens.add({
        targets: platformObj,
        scaleY: 0.8,  // Сжимаем по вертикали
        duration: 150, // 0.15 сек сжатия
        ease: 'Quad.easeOut',
        yoyo: true,    // Возврат к исходному размеру
        repeat: 0,
        onComplete: () => {
            // Возвращаем обычную текстуру после анимации
            platformObj.setTexture('balloon_unbreakable');
        }
    });
    
    return;
}
        
        // НОВОЕ: Остановка движения для движущихся платформ при приземлении
        if (platformObj.platformType === 'moving' && !platformObj.isLanded) {
            console.log('🟢 Остановили движущийся шарик при приземлении');
            platformObj.isLanded = true; // Помечаем что приземлились - движение остановится
        }
        
        // ФИКС: Устанавливаем isLanded ДО прыжка (если ещё не установлено)
        if (!platformObj.isLanded) {
            platformObj.setTexture('balloon_under_player');
            platformObj.isLanded = true;
        }
        
        // ФИКС #5: Ставим smash только если ещё не установлен И платформа не unbreakable
        if (!platformObj.smashStartTime && platformObj.platformType !== 'unbreakable') {
            console.log('🎯 Автопрыжок! Сразу ставим smash, платформа:', platformObj.texture.key);
            platformObj.setTexture('balloon_smash');
            platformObj.smashStartTime = this.time.now;
        }
        
        player.setVelocityY(CONSTS.JUMP_VELOCITY * this.jumpMultiplier); // Немедленный прыжок вверх (с бустом)
        this.player.anims.stop();
        this.player.setTexture('monkey_up'); // ФИКС: Статичная текстура вместо анимации
        this.isJumping = true; // НОВОЕ: Устанавливаем флаг прыжка
        this.lastBouncePlatform = platformObj; // ФИКС: Запоминаем эту платформу чтобы не прыгать с неё повторно
        return; // Выходим, чтобы не обрабатывать другие касания в этом кадре
    }
    // УБРАНО: Логика зацепления за бока шариков (left/right) полностью удалена
}

    // НОВОЕ: Метод для появления земли после 2 секунд падения
    makeGroundAppear() {
        if (this.groundAppeared || !this.ground) return;
        
        console.log('🌍 Земля перемещается вниз! (прошло 2 секунды падения)');
        this.groundAppeared = true;
        
        // НОВОЕ: Позиционируем землю ниже игрока (на расстоянии ~0.7 секунды падения)
        const fallDistance = CONSTS.GRAVITY * 0.7; // ФИКС: Уменьшено с 1.5 до 0.7 - земля появляется ближе чтобы игрок успел до неё долететь
        const newGroundY = this.player.y + fallDistance;
        
        this.ground.y = newGroundY;
        this.ground.refreshBody(); // ФИКС: Обновляем физику ТОЛЬКО земли (не всей группы platforms!)
        this.groundBottom = this.ground.y + (this.ground.displayHeight / 2);
        
        console.log('🌍 Земля теперь на Y:', newGroundY, 'Игрок на Y:', this.player.y);
    }

    // НОВОЕ: Метод для обработки game over при падении на землю
    handleGameOverOnGround() {
        console.log('💥 Обезьяна упала на землю!');
        
        // НОВОЕ: Проверка щита
        if (this.hasShield) {
            console.log('🛡️ Щит активирован! Спасён от падения!');
            this.hasShield = false; // Расходуем щит
            
            // Визуальный эффект щита
            const shieldText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, '🛡️ SHIELD!', {
                fontSize: '48px',
                fill: '#00FFFF',
                fontStyle: 'bold',
                stroke: '#000',
                strokeThickness: 6
            }).setOrigin(0.5).setDepth(1000).setScrollFactor(0);
            
            // Подбрасываем игрока вверх
            this.player.setVelocityY(CONSTS.JUMP_VELOCITY * 1.2);
            
            // Убираем текст через 1 секунду
            this.time.delayedCall(1000, () => {
                shieldText.destroy();
            });
            
            return; // НЕ заканчиваем игру!
        }
        
        // Останавливаем физику
        this.physics.pause();
        this.gameOver = true;
        
        // ==================== 1V1 MODE: НЕ ПОКАЗЫВАЕМ GAME OVER ====================
        // В 1v1 режиме ждем события gameEnd от сервера
        if (this.gameMode === '1v1') {
            console.log('💀 1v1 режим: отправляю isAlive=false серверу');
            // Сразу отправляем что мы мертвы
            if (this.socket) {
                this.socket.emit('playerUpdate', {
                    x: this.player.x,
                    y: this.player.y,
                    isAlive: false,
                    score: this.score
                });
            }
            
            // Показываем временное сообщение "You Fell"
            this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Вы упали!\nОжидание результата...', {
                fontSize: '42px',
                fill: '#FF0000',
                fontFamily: 'Arial Black',
                stroke: '#000000',
                strokeThickness: 6,
                align: 'center'
            }).setOrigin(0.5).setScrollFactor(0).setDepth(200);
            
            return; // Не показываем обычный Game Over
        }
        
        // SOLO режим: обычный Game Over
        // НОВОЕ: Последовательность анимаций:
        // 1. monkey_fall_floor показывается сразу (уже установлена в handlePlayerPlatformCollision)
        // 2. Через 1 секунду меняем на monkey_dumb
        this.time.delayedCall(1000, () => {
            console.log('👊 Меняем текстуру на monkey_dumb (злая обезьяна)');
            this.player.setTexture('monkey_dumb');
            
            // 3. Ещё через небольшую паузу показываем окно Game Over
            this.time.delayedCall(500, () => {
                this.showGameOverScreen();
            });
        });
    }

    // НОВОЕ: Универсальный метод показа экрана Game Over
    showGameOverScreen() {
        console.log('💀 Game Over! Показываем экран...');
        
        // НОВОЕ: Если режим дуэли - завершаем дуэль через API
        if (this.gameMode === 'duel' && this.matchId && !this.duelCompleted) {
            this.completeDuel();
        }
        
        // ФИКС: КРИТИЧНО - Полностью уничтожаем сенсорные зоны ПЕРЕД созданием UI
        this.hideTouchZones();
        
        // Останавливаем физику для предотвращения фоновой активности
        if (this.physics && this.physics.world) {
            this.physics.pause();
        }
        
        // Пытаемся отправить неотправленные ранее счеты
        retryPendingScores();

        // НОВОЕ: Зарабатываем бананы за сессию
        let bananas = parseInt(localStorage.getItem('bananas')) || 0;
        const earnedBananas = Math.floor(this.score / 100); // Чем выше счёт, тем больше
        bananas += earnedBananas;
        localStorage.setItem('bananas', bananas);

        // Получаем предыдущий лучший счёт (до сохранения нового)
        let highScores = JSON.parse(localStorage.getItem('highScores')) || [];
        const previousBest = highScores.length > 0 ? highScores[0] : 0;
        const isNewRecord = this.score > previousBest;

        // Сохраняем рекорд
        highScores.push(this.score);
        highScores.sort((a, b) => b - a); // Сортировка по убыванию
        highScores = highScores.slice(0, 10); // Только топ-10
        localStorage.setItem('highScores', JSON.stringify(highScores));
        
        // Получаем текущий лучший счёт (после сохранения)
        const currentBest = highScores[0];

        // Форматируем счёт (округляем до SCORE_HEIGHT_INCREMENT)
        const displayScore = Math.floor(this.score / CONSTS.SCORE_HEIGHT_INCREMENT) * CONSTS.SCORE_HEIGHT_INCREMENT;
        const displayBest = Math.floor(currentBest / CONSTS.SCORE_HEIGHT_INCREMENT) * CONSTS.SCORE_HEIGHT_INCREMENT;

        // Фон для Game Over (поднимаем выше на 40px)
        const gameOverBg = this.add.graphics();
        gameOverBg.fillStyle(0x000000, 0.8);
        gameOverBg.fillRoundedRect(CONSTS.WIDTH / 2 - 180, CONSTS.HEIGHT / 2 - 180, 360, 280, 15);
        gameOverBg.setScrollFactor(0).setDepth(14);

        // Тень (поднимаем выше на 40px)
        const shadowGraphics = this.add.graphics();
        shadowGraphics.fillStyle(0x000000, 0.5);
        shadowGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 175, CONSTS.HEIGHT / 2 - 175, 360, 280, 15);
        shadowGraphics.setScrollFactor(0).setDepth(13);

        // Заголовок "Game Over!" (поднимаем выше на 40px)
        const gameOverText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 140, 'Игра окончена!', { 
            fontSize: '40px', 
            fill: '#FF0000', 
            fontFamily: 'Arial Black', 
            stroke: '#000000', 
            strokeThickness: 4 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(15);

        // Статус сервера (поднимаем выше на 40px)
        const serverStatusText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 100, '📤 Отправка...', { 
            fontSize: '14px', 
            fill: '#FFFF00', 
            fontFamily: 'Arial' 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(15);

        // НОВОЕ: Текст для отображения полученных Monkey Coins
        const coinsEarnedText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 80, '', { 
            fontSize: '16px', 
            fill: '#FFD700', 
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5).setScrollFactor(0).setDepth(15).setVisible(false);

        // NEW RECORD (если есть) (поднимаем выше на 40px)
        let newRecordText = null;
        if (isNewRecord) {
            newRecordText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 75, '★ Новый РЕКОРД! ★', { 
                fontSize: '20px', 
                fill: '#FFD700', 
                fontFamily: 'Arial Black' 
            }).setOrigin(0.5).setScrollFactor(0).setDepth(15);
        }

        // Текущий счёт (поднимаем выше на 40px)
        const currentScoreText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 45, `Очки: ${displayScore}`, { 
            fontSize: '28px', 
            fill: '#FFFFFF', 
            fontFamily: 'Arial Black' 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(15);

        // Лучший счёт (поднимаем выше на 40px)
        const bestScoreText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 15, `Рекорд: ${displayBest}`, { 
            fontSize: '20px', 
            fill: '#00FF00', 
            fontFamily: 'Arial' 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(15);

        // Бананы (поднимаем выше на 40px)
        const bananasText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 + 10, `+${earnedBananas} 🍌`, { 
            fontSize: '18px', 
            fill: '#FFA500', 
            fontFamily: 'Arial' 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(15);

        // Кнопка "Рестарт" (поднимаем выше на 40px)
        const restartGraphics = this.add.graphics().setDepth(150); // ФИКС: Увеличен depth выше сенсорных зон (90)
        restartGraphics.fillStyle(0x4CAF50, 1);
        restartGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 140, CONSTS.HEIGHT / 2 + 45, 120, 45, 8);
        restartGraphics.setScrollFactor(0);

        // ФИКС: Создаем невидимую интерактивную зону ПОВЕРХ кнопки (поднимаем выше на 40px)
        const restartZone = this.add.rectangle(CONSTS.WIDTH / 2 - 80, CONSTS.HEIGHT / 2 + 67, 120, 45, 0x000000, 0)
            .setOrigin(0.5)
            .setScrollFactor(0)
            .setDepth(151) // ФИКС: Еще выше
            .setInteractive({ useHandCursor: true });

        const restartText = this.add.text(CONSTS.WIDTH / 2 - 80, CONSTS.HEIGHT / 2 + 67, 'Заново', { 
            fontSize: '20px', 
            fill: '#FFF', 
            fontFamily: 'Arial Black' 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(152); // ФИКС: Текст поверх всего
        
        restartZone.on('pointerdown', () => {
            console.log('🔄🔄🔄 РЕСТАРТ НАЖАТ! Перезапускаем игру...');
            this.scene.restart();

        });

        // Кнопка "Меню" (поднимаем выше на 40px)
        const menuGraphics = this.add.graphics().setDepth(150); // ФИКС: Увеличен depth выше сенсорных зон (90)
        menuGraphics.fillStyle(0x2196F3, 1);
        menuGraphics.fillRoundedRect(CONSTS.WIDTH / 2 + 20, CONSTS.HEIGHT / 2 + 45, 120, 45, 8);
        menuGraphics.setScrollFactor(0);

        // ФИКС: Создаем невидимую интерактивную зону ПОВЕРХ кнопки (поднимаем выше на 40px)
        const menuZone = this.add.rectangle(CONSTS.WIDTH / 2 + 80, CONSTS.HEIGHT / 2 + 67, 120, 45, 0x000000, 0)
            .setOrigin(0.5)
            .setScrollFactor(0)
            .setDepth(151) // ФИКС: Еще выше
            .setInteractive({ useHandCursor: true });

        const menuText = this.add.text(CONSTS.WIDTH / 2 + 80, CONSTS.HEIGHT / 2 + 67, 'Меню', { 
            fontSize: '20px', 
            fill: '#FFF', 
            fontFamily: 'Arial Black' 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(152); // ФИКС: Текст поверх всего
        
        menuZone.on('pointerdown', () => {
            console.log('🔙🔙🔙 МЕНЮ НАЖАТО! Выход в меню...');
            // ФИКС: Останавливаем GameScene перед запуском MenuScene (важно для Telegram!)
            this.scene.stop('GameScene');
            this.scene.start('MenuScene');
        });

        // НОВОЕ: Отправляем счет на сервер АСИНХРОННО (не блокирует UI)
        const userData = getTelegramUserId();
        
        // Применяем бонусы от экипированных бустов
        this.applyBoostBonuses(this.score).then(finalScore => {
            if (finalScore > this.score) {
                console.log(`🚀 Буст применён! ${this.score} → ${finalScore} (+${finalScore - this.score})`);
                // Показываем бонус на экране
                const boostText = this.add.text(CONSTS.WIDTH / 2, 250, `🚀 БУСТ: +${finalScore - this.score}`, {
                    fontSize: '24px',
                    fill: '#FFD700',
                    fontStyle: 'bold',
                    stroke: '#000',
                    strokeThickness: 4
                }).setOrigin(0.5).setDepth(1000);
            }
            
            // Сохраняем финальный счёт с бонусами
            saveScoreToServer(userData.id, userData.username, finalScore)
            .then(serverResult => {
                if (serverResult.success) {
                    serverStatusText.setText('✅ Сохранено!');
                    serverStatusText.setColor('#00FF00');
                    if (serverResult.isNewRecord) {
                        serverStatusText.setText('✅ Новый рекорд!');
                    }
                    
                    // НОВОЕ: Расходуем буст после завершения игры (если был экипирован)
                    this.consumeBoostAfterGame(userData.id);
                    
                    // НОВОЕ: Отправляем результат в турнир (если играем в турнире)
                    const tournamentId = localStorage.getItem('currentTournamentId');
                    if (tournamentId) {
                        this.submitTournamentScore(userData.id, tournamentId, finalScore);
                    }
                    
                    // НОВОЕ: Показываем полученные Monkey Coins
                    if (serverResult.coinsEarned > 0) {
                        coinsEarnedText.setText(`+${serverResult.coinsEarned} 🐵 Monkey Coins!`);
                        coinsEarnedText.setVisible(true);
                        
                        // Анимация появления монет
                        this.tweens.add({
                            targets: coinsEarnedText,
                            scaleX: { from: 0.5, to: 1.2 },
                            scaleY: { from: 0.5, to: 1.2 },
                            alpha: { from: 0, to: 1 },
                            duration: 300,
                            ease: 'Back.easeOut',
                            yoyo: true,
                            hold: 1000
                        });
                        
                        console.log(`💰 Получено монет: ${serverResult.coinsEarned}, новый баланс: ${serverResult.newBalance}`);
                    }
                } else {
                    serverStatusText.setText('⚠️ Локально');
                    serverStatusText.setColor('#FFA500');
                }
            })
            .catch(err => {
                console.error('Ошибка отправки:', err);
                serverStatusText.setText('❌ Ошибка');
                serverStatusText.setColor('#FF0000');
            });
        }); // Закрываем applyBoostBonuses
    }
    
    // НОВОЕ: Завершение дуэли через API
    async completeDuel() {
        if (this.duelCompleted) return; // Защита от двойного вызова
        this.duelCompleted = true;
        
        // НОВОЕ: Останавливаем polling позиций
        if (this.duelPositionInterval) {
            clearInterval(this.duelPositionInterval);
            console.log('⏰ Duel polling stopped');
        }
        
        const userData = getTelegramUserId();
        const roundedScore = Math.round(this.score);
        
        try {
            console.log(`⚔️ Завершаем дуэль: matchId=${this.matchId}, score=${roundedScore}`);
            
            const response = await fetch(`${API_SERVER_URL}/api/duel/${this.matchId}/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playerId: userData.id,
                    score: roundedScore
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const result = await response.json();
            console.log('✅ Duel complete response:', result);
            
            if (result.completed) {
                // Оба игрока завершили - показываем результаты
                this.showDuelResults(result);
            } else {
                // Ждем второго игрока
                this.showWaitingForOpponent(roundedScore);
            }
            
        } catch (error) {
            console.error('❌ Error completing duel:', error);
            // Продолжаем показывать обычный Game Over экран
        }
    }
    
    // НОВОЕ: Экран ожидания результата соперника
    showWaitingForOpponent(myScore) {
        // Создаем overlay поверх Game Over экрана
        const overlay = this.add.rectangle(
            0, 0,
            CONSTS.WIDTH,
            CONSTS.HEIGHT,
            0x000000,
            0.9
        ).setOrigin(0, 0).setScrollFactor(0).setDepth(20);
        
        // Если это создатель челленджа - показываем кнопку Share
        if (this.isCreator) {
            // Заголовок
            this.add.text(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2 - 150,
                '✅ Challenge Complete!',
                {
                    fontSize: '28px',
                    fill: '#2ecc71',
                    fontFamily: 'Arial Black',
                    stroke: '#000',
                    strokeThickness: 4
                }
            ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
            
            // Твой результат
            this.add.text(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2 - 80,
                `Your score: ${myScore}`,
                {
                    fontSize: '24px',
                    fill: '#FFD700',
                    fontFamily: 'Arial Black'
                }
            ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
            
            // Информация
            this.add.text(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2 - 20,
                'Now share this challenge\nwith your friend!',
                {
                    fontSize: '18px',
                    fill: '#FFFFFF',
                    fontFamily: 'Arial',
                    align: 'center',
                    lineSpacing: 5
                }
            ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
            
            // Кнопка "Share in Telegram"
            const shareBtn = this.add.rectangle(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2 + 50,
                280,
                60,
                0x0088cc
            ).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(21);
            
            this.add.text(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2 + 50,
                '📤 Share in Telegram',
                {
                    fontSize: '20px',
                    fill: '#FFFFFF',
                    fontFamily: 'Arial Black'
                }
            ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
            
            shareBtn.on('pointerdown', () => {
                // Формируем ссылку для шаринга
                const duelLink = `https://t.me/monkey_test_crypto_bot/monkeytest?startapp=${this.matchId}`;
                const shareText = `🐵 I challenge you to a duel in Crypto Monkey! My score: ${myScore}. Can you beat it?`;
                
                if (window.Telegram?.WebApp) {
                    window.Telegram.WebApp.openTelegramLink(
                        `https://t.me/share/url?url=${encodeURIComponent(duelLink)}&text=${encodeURIComponent(shareText)}`
                    );
                } else {
                    // Fallback: копируем ссылку
                    navigator.clipboard?.writeText(duelLink);
                    alert('Link copied to clipboard!');
                }
            });
            
            // Кнопка "Back to Menu"
            const menuBtn = this.add.rectangle(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2 + 130,
                200,
                50,
                0x34495e
            ).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(21);
            
            this.add.text(
                CONSTS.WIDTH / 2,
                CONSTS.HEIGHT / 2 + 130,
                '← Back to Menu',
                {
                    fontSize: '18px',
                    fill: '#FFFFFF',
                    fontFamily: 'Arial'
                }
            ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
            
            menuBtn.on('pointerdown', () => {
                this.scene.start('MenuScene');
            });
            
            return; // Не показываем экран ожидания
        }
        
        // Обычный экран ожидания для принявшего челлендж
        // Заголовок
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 100,
            '⏳ Ожидание соперника...',
            {
                fontSize: '32px',
                fill: '#FFD700',
                fontFamily: 'Arial Black',
                stroke: '#000',
                strokeThickness: 4
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
        
        // Твой результат
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2,
            `Ваш счёт: ${myScore}`,
            {
                fontSize: '24px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
        
        // Анимация точек
        const dotsText = this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 60,
            '.',
            {
                fontSize: '48px',
                fill: '#FFD700',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
        
        let dotCount = 1;
        const dotsTimer = this.time.addEvent({
            delay: 500,
            loop: true,
            callback: () => {
                dotCount = (dotCount % 3) + 1;
                dotsText.setText('.'.repeat(dotCount));
            }
        });
        
        // Опрос API каждые 3 секунды
        const checkTimer = this.time.addEvent({
            delay: 3000,
            loop: true,
            callback: async () => {
                try {
                    const response = await fetch(`${API_SERVER_URL}/api/duel/${this.matchId}`);
                    const data = await response.json();
                    
                    if (data.duel.status === 'completed') {
                        // Второй игрок завершил!
                        dotsTimer.remove();
                        checkTimer.remove();
                        
                        overlay.destroy();
                        dotsText.destroy();
                        
                        const result = {
                            completed: true,
                            winner: data.duel.winner,
                            score1: data.duel.score1,
                            score2: data.duel.score2
                        };
                        
                        this.showDuelResults(result);
                    }
                } catch (error) {
                    console.error('Error checking duel status:', error);
                }
            }
        });
        
        // Кнопка "Back to Menu" (если долго ждать)
        const backBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 140,
            200,
            50,
            0x34495e
        ).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(21);
        
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 140,
            'Back to Menu',
            {
                fontSize: '18px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(21);
        
        backBtn.on('pointerdown', () => {
            dotsTimer.remove();
            checkTimer.remove();
            this.scene.start('MenuScene');
        });
    }
    
    // НОВОЕ: Показать результаты дуэли
    showDuelResults(result) {
        const userData = getTelegramUserId();
        const isPlayer1 = result.score1 !== null && result.score1 !== undefined;
        const myScore = isPlayer1 ? result.score1 : result.score2;
        const opponentScore = isPlayer1 ? result.score2 : result.score1;
        
        let statusText = '';
        let statusColor = '#95a5a6';
        
        if (result.winner === 'draw') {
            statusText = '🤝 DRAW!';
            statusColor = '#f39c12';
        } else if (result.winner === userData.id) {
            statusText = '🏆 YOU WON!';
            statusColor = '#2ecc71';
        } else {
            statusText = '😔 YOU LOST';
            statusColor = '#e74c3c';
        }
        
        // Overlay
        const overlay = this.add.rectangle(
            0, 0,
            CONSTS.WIDTH,
            CONSTS.HEIGHT,
            0x000000,
            0.9
        ).setOrigin(0, 0).setScrollFactor(0).setDepth(25);
        
        // Результат
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 120,
            statusText,
            {
                fontSize: '48px',
                fill: statusColor,
                fontFamily: 'Arial Black',
                stroke: '#000',
                strokeThickness: 6
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(26);
        
        // Счета
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 - 20,
            `You: ${myScore}`,
            {
                fontSize: '28px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(26);
        
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 30,
            `${this.opponentUsername}: ${opponentScore}`,
            {
                fontSize: '28px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(26);
        
        // Кнопки
        const rematchBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 100,
            200,
            50,
            0xFF6B35
        ).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(26);
        
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 100,
            '🔄 Rematch',
            {
                fontSize: '20px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(26);
        
        rematchBtn.on('pointerdown', () => {
            this.scene.start('DuelHistoryScene');
        });
        
        const menuBtn = this.add.rectangle(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 170,
            200,
            50,
            0x34495e
        ).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(26);
        
        this.add.text(
            CONSTS.WIDTH / 2,
            CONSTS.HEIGHT / 2 + 170,
            '← Menu',
            {
                fontSize: '20px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }
        ).setOrigin(0.5).setScrollFactor(0).setDepth(26);
        
        menuBtn.on('pointerdown', () => {
            this.scene.start('MenuScene');
        });
    }

    getStandingPlatform() {
        // ФИКС: Сначала проверяем землю (она теперь не в группе platforms)
        if (this.ground && this.ground.body) {
            const playerBottom = this.player.body.bottom;
            const groundTop = this.ground.body.top;
            if (Math.abs(playerBottom - groundTop) < 5 && this.player.body.right > this.ground.body.left && this.player.body.left < this.ground.body.right) {
                return this.ground;
            }
        }
        
        // Затем проверяем обычные платформы
        return this.platforms.children.entries.find(platform => {
            const playerBottom = this.player.body.bottom;
            const platformTop = platform.body.top;
            return Math.abs(playerBottom - platformTop) < 5 && this.player.body.right > platform.body.left && this.player.body.left < platform.body.right;
        });
    }

    update() {
    // ФИКС: Не выполняем update если сцена не активна (критично для Telegram!)
    if (!this.scene.isActive('GameScene')) {
        return;
    }
    if (this.gameOver) {
        return;
    }
    if (this.pausedForConfirm) {
        return;
    }
    
    // ==================== 1V1 MODE: SEND PLAYER UPDATES ====================
    // Отправляем обновления каждые 100ms
    if (this.gameMode === '1v1') {
        if (!this.lastUpdateTime) {
            this.lastUpdateTime = 0;
        }
        
        const now = this.time.now;
        if (now - this.lastUpdateTime >= 100) {
            this.sendPlayerUpdate();
            this.lastUpdateTime = now;
        }
        
        // Обновляем позицию имени оппонента
        this.updateOpponentNamePosition();
        
        // Обновляем таймер
        if (this.gameStartTime && this.timerText) {
            const elapsed = now - this.gameStartTime;
            const remaining = Math.max(0, this.gameDuration - elapsed);
            const minutes = Math.floor(remaining / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            this.timerText.setText(`${minutes}:${seconds.toString().padStart(2, '0')}`);
            
            // Красный цвет на последних 30 секундах
            if (remaining <= 30000) {
                this.timerText.setFill('#FF0000');
            }
        }
        
        // Обновляем счет оппонента
        if (this.gameMode === '1v1' && this.opponentScoreText && this.opponentData) {
            const opponentScore = Math.floor(this.opponentData.score || 0);
            this.opponentScoreText.setText(`Opponent: ${opponentScore}`);
        }
    }
    
    const standingPlatform = this.getStandingPlatform();
    if (!standingPlatform && this.player.body.velocity.y > 0 && !this.rocketActive) {
        // НОВОЕ: Начинаем отсчет времени падения
        if (!this.isFalling) {
            this.fallStartTime = this.time.now; // Запоминаем время начала падения
        }
        this.isFalling = true;
        
        // НОВОЕ: Проверяем, не падаем ли мы слишком долго (больше 2 секунд)
        if (this.fallStartTime && this.time.now - this.fallStartTime >= this.maxFallDuration && !this.groundAppeared) {
            console.log('⏰ Падали 2 секунды! Земля появляется!');
            this.makeGroundAppear(); // Показываем землю
        }
    } else if (standingPlatform || this.player.body.velocity.y <= 0) {
        this.isFalling = false;
        this.fallStartTime = null; // Сбрасываем таймер падения
    }
    
    // ФИКС: Проверка - если игрок пролетел мимо земли (ниже на 200px) - game over
    if (this.groundAppeared && this.player.y > this.groundBottom + 200 && !this.gameOver) {
        console.log('💥 Пролетел мимо земли! Game Over!');
        this.isFalling = true;
        this.handleGameOverOnGround();
        return;
    }
    
    if (Phaser.Input.Keyboard.JustDown(this.escKey)) {
        this.showConfirmExit();
        return;
    }
    
    // ФИКС: Сбрасываем isJumping когда игрок достиг апогея и начал падать
    // Это означает что прыжок закончился (даже если игрок соскользнул с края платформы)
    if (this.isJumping && this.player.body.velocity.y > 50 && !this.rocketActive) {
        console.log('🔄 Прыжок закончен, начинается падение (velocity.y > 50)');
        this.isJumping = false;
    }
    
    // НОВОЕ: Логика анимаций с учётом isJumping
    if (!this.dumbTimer || !this.dumbTimer.isRunning) {
        const standingPlatform = this.getStandingPlatform();
        // ФИКС: Добавлена мёртвая зона (deadzone) для velocity чтобы избежать дёргания текстур
        const velocityDeadzone = 30; // Игнорируем малые скорости
        const isFalling = !standingPlatform && this.player.body.velocity.y > velocityDeadzone && !this.rocketActive && !this.isJumping;
        const isRising = !standingPlatform && this.player.body.velocity.y < -velocityDeadzone && !this.rocketActive && !this.isJumping;
        
        // ФИКС: Используем статичные текстуры вместо анимаций для устранения джиттера
        if (isFalling) {
            // Используем статичную текстуру падения
            if (this.player.texture.key !== 'monkey_down_1') {
                this.player.anims.stop();
                this.player.setTexture('monkey_down_1');
            }
        } else if (isRising) {
            // Используем статичную текстуру подъема
            if (this.player.texture.key !== 'monkey_up') {
                this.player.anims.stop();
                this.player.setTexture('monkey_up');
            }
        } else if (standingPlatform && !this.isJumping) { // ИЗМЕНЕНО: Добавлена проверка !this.isJumping
            // НОВОЕ: Логика анимации ходьбы на земле
            if (Math.abs(this.player.body.velocity.x) > 10) {
                // Игрок движется - играем анимацию ходьбы
                this.player.anims.play('walk', true);
            } else {
                // Игрок стоит на месте - idle текстура
                if (this.player.texture.key !== 'playerSprite') {
                    this.player.anims.stop();
                    this.player.setTexture('playerSprite');
                }
            }
            this.isJumping = false; // Сбрасываем isJumping на платформе
        }
    }
    this.checkMovement();
    this.checkJump();
    this.updateMovingPlatforms(); // НОВОЕ: Обновляем движущиеся платформы
    this.refactorPlatforms();
    this.checkGameOver();
    
    // REMOVED: Старая система ракет (rockets) удалена как небезопасная
    // Бусты теперь работают через серверную систему equipped_items
    
    const currentStanding = this.getStandingPlatform();
    // УБРАНО: currentCling теперь всегда null (зацепление отключено)
    const wasOnPlatform = this.previousStandingPlatform;
    const nowOnPlatform = currentStanding;
    if (wasOnPlatform && !nowOnPlatform) {
        let jumpedPlatform = this.previousStandingPlatform;
        // ИЗМЕНЕНО: Не применяем smash к нелопающимся шарикам!
        if (jumpedPlatform && jumpedPlatform.isLanded && !jumpedPlatform.smashStartTime && !jumpedPlatform.isGround && jumpedPlatform.platformType !== 'unbreakable') {
            console.log('🎯 [FALLBACK] Прыгнули с платформы, ставим smash, платформа:', jumpedPlatform.texture.key);
            jumpedPlatform.setTexture('balloon_smash');
            jumpedPlatform.smashStartTime = this.time.now;
        }
    }
    // ИЗМЕНЕНО: Не устанавливаем isLanded для нелопающихся шариков!
    if (currentStanding && !currentStanding.isLanded && !currentStanding.isGround && this.player.body.velocity.y >= 0 && currentStanding.platformType !== 'unbreakable') {
        currentStanding.setTexture('balloon_under_player');
        currentStanding.isLanded = true;
    }
    this.platforms.children.entries.forEach(platform => {
        // ИЗМЕНЕНО: Не применяем dead к нелопающимся шарикам!
        if (platform.smashStartTime && this.time.now - platform.smashStartTime >= CONSTS.BALLOON_SMASH_DURATION && platform.texture.key !== 'balloon_dead' && !platform.isGround && platform.platformType !== 'unbreakable') {
            console.log('💀 Платформа стала dead:', platform.x, platform.y);
            platform.setTexture('balloon_dead');
            platform.deadStartTime = this.time.now; // НОВОЕ: Запоминаем время смерти
            
            // ФИКС: ОТКЛЮЧАЕМ коллизию для взорванного шарика!
            platform.body.checkCollision.none = true; // Полностью отключаем все коллизии
            platform.setAlpha(0.5); // НОВОЕ: Делаем полупрозрачным для визуального эффекта
        }
    });
    this.previousStandingPlatform = currentStanding;
    // УБРАНО: previousClingPlatform больше не используется
    
    const camera = this.cameras.main;
    
    // ФИКС: Единый lerp для плавности камеры (одинаковый для X и Y устраняет дёргание)
    const cameraLerp = 0.1; // Единое значение для обоих осей
    
    // ФИКС: Камера следует за игроком по X с ограничением границ
    const desiredScrollX = this.player.x - (CONSTS.WIDTH / 2);
    const minScrollX = 0; // Не уходить левее начала мира
    const maxScrollX = 0; // Не уходить правее (мир шириной 640px)
    const targetScrollX = Phaser.Math.Clamp(desiredScrollX, minScrollX, maxScrollX);
    
    // ФИКС: Плавное движение камеры по X с единым lerp
    camera.scrollX = Phaser.Math.Linear(camera.scrollX, targetScrollX, cameraLerp);
    
    // ФИКС: Камера следует за игроком по Y (центрируем по вертикали)
    const desiredScrollY = this.player.y - (CONSTS.HEIGHT / 2);
    const maxScrollY = this.groundBottom - CONSTS.HEIGHT;
    
    // ФИКС: Камера не должна уходить ниже земли (ограничиваем снизу тоже)
    const minScrollY = -Infinity; // Можно уходить вверх бесконечно
    const targetScrollY = Phaser.Math.Clamp(desiredScrollY, minScrollY, maxScrollY);

    // ФИКС: Плавное движение камеры по Y с единым lerp (устраняет дёргание при прыжке)
    camera.scrollY = Phaser.Math.Linear(camera.scrollY, targetScrollY, cameraLerp);
    
    // ФИКС: Обновляем счет каждый кадр!
    this.updateScore();
    
    // ФИКС: Сбрасываем флаг прыжка когда обезьяна начинает падать вниз (с мёртвой зоной для избежания дёргания)
    if (this.isJumping && this.player.body.velocity.y > 50) {
        this.isJumping = false;
    }
    
    // ФИКС: Сбрасываем lastBouncePlatform когда обезьяна находится в воздухе достаточно долго
    if (!standingPlatform && this.player.body.velocity.y > 100) {
        this.lastBouncePlatform = null;
    }
}

    checkMovement() {
        const { player, aKey, dKey } = this;
        
        // НОВОЕ: Объединяем клавиатуру и сенсорный ввод
        const isMovingLeft = aKey.isDown || this.touchLeft;
        const isMovingRight = dKey.isDown || this.touchRight;
        
        // ФИКС: Плавное изменение скорости вместо резкого setVelocityX
        const targetVelocityX = isMovingLeft && !isMovingRight ? -CONSTS.MOVE_VELOCITY :
                               isMovingRight && !isMovingLeft ? CONSTS.MOVE_VELOCITY :
                               0;
        
        // ФИКС: Применяем lerp для плавного ускорения/замедления
        const currentVelocityX = player.body.velocity.x;
        const newVelocityX = Phaser.Math.Linear(currentVelocityX, targetVelocityX, 0.3);
        player.setVelocityX(newVelocityX);
        
        // Обновляем направление спрайта
        if (targetVelocityX < 0) {
            player.flipX = true;
        } else if (targetVelocityX > 0) {
            player.flipX = false;
        }
    }

    // НОВОЕ: Метод для обновления движения платформ
    updateMovingPlatforms() {
        let anyPlatformMoved = false;
        
        this.platforms.children.entries.forEach(platform => {
            // Двигаем только платформы типа 'moving', которые не приземлились
            if (platform.platformType === 'moving' && !platform.isLanded) {
                // Вычисляем новую позицию
                const newX = platform.x + (platform.moveSpeed * platform.moveDirection * (1/60));
                
                // Проверяем границы движения
                const leftBound = platform.initialX - platform.moveRange / 2;
                const rightBound = platform.initialX + platform.moveRange / 2;
                
                if (newX <= leftBound) {
                    platform.x = leftBound;
                    platform.moveDirection = 1;
                } else if (newX >= rightBound) {
                    platform.x = rightBound;
                    platform.moveDirection = -1;
                } else {
                    platform.x = newX;
                }
                
                // ФИКС #3: Обновляем только body этой конкретной платформы (оптимизация)
                platform.refreshBody();
                anyPlatformMoved = true;
            }
        });
        
        // Логируем только при первом движении для отладки
        if (anyPlatformMoved && !this._movingLogged) {
            console.log('🟢 Движущиеся платформы активны');
            this._movingLogged = true;
        }
    }

    checkJump() {
        // ИЗМЕНЕНО: Прыжок через клавишу W (сенсорный прыжок обрабатывается в setupTouchControls)
        if (Phaser.Input.Keyboard.JustDown(this.wKey)) {
            this.handleJump();
        }
    }

    refactorPlatforms() {
        this.minPlatformY = Math.min(...this.platforms.children.entries.map(p => p.y));
        
        // НОВОЕ: Получаем целевое количество платформ в зависимости от очков
        const targetPlatformCount = this.getTargetPlatformCount();
        const activePlatforms = this.platforms.children.entries.filter(p => !p.isGround);
        const currentPlatformCount = activePlatforms.length;
        
        // Подсчитываем платформы для переработки
        let platformsToRecycle = [];
        
        this.platforms.children.entries.forEach(platform => {
            // ФИКС: Рециклим платформу если она далеко внизу ИЛИ если она "мертвая" (balloon_dead) достаточно долго
            const isFarBehind = platform.y > this.player.y && Phaser.Math.Distance.Between(this.player.body.center.x, this.player.body.center.y, platform.body.center.x, platform.body.center.y) > CONSTS.RECYCLE_DISTANCE;
            const isDead = platform.texture.key === 'balloon_dead';
            const isDeadLongEnough = isDead && platform.deadStartTime && this.time.now - platform.deadStartTime >= 500; // НОВОЕ: Показываем dead 1.5 секунды
            
            // НОВОЕ: Если земля появилась и игрок падает вниз - рециклим ВСЕ платформы выше игрока (включая синие!)
            const isAbovePlayerWhenFalling = this.groundAppeared && platform.y < this.player.y - 300; // Платформа выше игрока на 300px когда земля появилась
            
            if ((isFarBehind || isDeadLongEnough || isAbovePlayerWhenFalling) && !platform.isGround) { // ФИКС: Рециклим dead только через 1.5 сек
                platformsToRecycle.push(platform);
            }
        });
        
        // НОВОЕ: Если платформ больше чем нужно, удаляем лишние (не перерабатываем)
        if (currentPlatformCount > targetPlatformCount) {
            const excessCount = currentPlatformCount - targetPlatformCount;
            let removed = 0;
            
            // Удаляем самые дальние платформы
            const sortedByDistance = [...platformsToRecycle].sort((a, b) => {
                const distA = Phaser.Math.Distance.Between(this.player.body.center.x, this.player.body.center.y, a.body.center.x, a.body.center.y);
                const distB = Phaser.Math.Distance.Between(this.player.body.center.x, this.player.body.center.y, b.body.center.x, b.body.center.y);
                return distB - distA; // От дальних к ближним
            });
            
            for (let i = 0; i < sortedByDistance.length && removed < excessCount; i++) {
                const platform = sortedByDistance[i];
                console.log('🗑️ Удаляем лишнюю платформу (уменьшение количества)');
                platform.destroy();
                platformsToRecycle = platformsToRecycle.filter(p => p !== platform);
                removed++;
            }
        }
        
        // Перерабатываем оставшиеся платформы
        platformsToRecycle.forEach(platform => {
            // ФИКС: Если земля появилась - прячем платформы (игра заканчивается)
            if (this.groundAppeared) {
                platform.y = -10000; // Прячем далеко за экраном
                platform.setAlpha(0); // Делаем невидимым
                platform.body.checkCollision.none = true; // Отключаем коллизию
                return; // Пропускаем остальную логику рецикла - игра скоро закончится
            }
            
            // НОВОЕ: Назначаем новый случайный тип платформы
            platform.platformType = this.choosePlatformType();
            
            // НОВОЕ: Устанавливаем текстуру в зависимости от типа
            // ФИКС: Единый масштаб 1.8x1.5 для синих шаров (консистентно с createPlatforms)
            if (platform.platformType === 'unbreakable') {
                platform.setTexture('balloon_unbreakable');
                platform.setScale(1.8, 1.5);
            } else {
                platform.setTexture('platform'); // normal и moving используют обычную зеленую текстуру
                platform.setScale(1, 1); // ФИКС: Сбрасываем масштаб для нормальных платформ
            }
            
            platform.isLanded = false;
            platform.smashStartTime = null;
            platform.deadStartTime = null; // НОВОЕ: Сброс времени смерти
            
            // ФИКС: ВОССТАНАВЛИВАЕМ коллизию при рецикле!
            platform.body.checkCollision.none = false; // Включаем коллизии обратно
            platform.setAlpha(1); // Восстанавливаем полную непрозрачность
            
            // ФИКС #7: Шарики появляются с отступом от краёв (не на x=0 или x=WIDTH)
            platform.x = Phaser.Math.Between(80, CONSTS.WIDTH - 80);
            const randomGap = Phaser.Math.Between(200, 280);
            
            // Обычная логика размещения - используем minPlatformY
            // (groundAppeared обрабатывается выше с return)
            platform.y = this.minPlatformY - randomGap;
            
            // НОВОЕ: Настройка для движущихся платформ
            if (platform.platformType === 'moving') {
                platform.initialX = platform.x;
                platform.moveSpeed = CONSTS.MOVING_PLATFORM_SPEED;
                platform.moveRange = CONSTS.MOVING_PLATFORM_RANGE;
                platform.moveDirection = 1; // 1 = вправо, -1 = влево
            }
            
            this.setupPlatformBody(platform); // ФИКС: Вызов функции (включает refreshBody + setCircle + collisions)
            this.minPlatformY = Math.min(this.minPlatformY, platform.y);
            console.log('♻️ Новый тип платформы:', platform.platformType);
        });
    }

    checkGameOver() {
        // Fallback удалён: game over теперь только на земле с impact в handlePlayerPlatformCollision.
        // Убрали проверку на player.body.y > gameOverDistance, чтобы избежать ранней смерти в воздухе.
        // Если нужно fallback для "бесконечного падения" (редко), добавь фиксированную границу ниже земли,
        // например: if (this.player.y > this.groundBottom + 100) { ... }
    }

    showConfirmExit() {
        // ФИКС: Скрываем сенсорные зоны при показе диалога выхода
        this.hideTouchZones();
        
        this.physics.pause();
        this.pausedForConfirm = true;

        // Фон для подтверждения
        const confirmBg = this.add.graphics();
        confirmBg.fillStyle(0x000000, 0.7);
        confirmBg.fillRoundedRect(CONSTS.WIDTH / 2 - 200, CONSTS.HEIGHT / 2 - 100, 400, 200, 15);
        confirmBg.setScrollFactor(0).setDepth(14).setAlpha(0).setScale(0).setVisible(false);
        this.confirmElements.push(confirmBg);

        // Тень для текста
        const shadowGraphics = this.add.graphics();
        shadowGraphics.fillStyle(0x000000, 0.5);
        shadowGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 195, CONSTS.HEIGHT / 2 - 95, 400, 200, 15);
        shadowGraphics.setScrollFactor(0).setDepth(13).setAlpha(0).setScale(0).setVisible(false);
        this.confirmElements.push(shadowGraphics);

        // Основной текст
        const confirmText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 50, 'Вы точно хотите выйти?', { fontSize: '32px', fill: '#FFFFFF', fontFamily: 'Arial Black', stroke: '#000000', strokeThickness: 4, align: 'center' }).setOrigin(0.5).setScrollFactor(0).setDepth(15).setAlpha(0).setScale(0).setVisible(false);
        this.confirmElements.push(confirmText);

        // Кнопка "Да"
        const yesGraphics = this.add.graphics().setDepth(15);
        yesGraphics.fillStyle(0xFFFFFF, 1);
        yesGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 150, CONSTS.HEIGHT / 2 + 20, 120, 50, 10);
        yesGraphics.setScrollFactor(0).setAlpha(0).setScale(0).setVisible(false);
        this.confirmElements.push(yesGraphics);

        const yesText = this.add.text(CONSTS.WIDTH / 2 - 90, CONSTS.HEIGHT / 2 + 45, 'Да', { fontSize: '24px', fill: '#000', fontFamily: 'Arial' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(16).setAlpha(0).setScale(0).setVisible(false);
        this.confirmElements.push(yesText);
        yesText.on('pointerdown', () => {
            console.log('🔙 Возврат в меню через ESC...');
            // ФИКС: Останавливаем GameScene перед запуском MenuScene (важно для Telegram!)
            this.scene.stop('GameScene');
            this.scene.start('MenuScene');
        });

        // Кнопка "Нет"
        const noGraphics = this.add.graphics().setDepth(15);
        noGraphics.fillStyle(0xFFFFFF, 1);
        noGraphics.fillRoundedRect(CONSTS.WIDTH / 2 + 30, CONSTS.HEIGHT / 2 + 20, 120, 50, 10);
        noGraphics.setScrollFactor(0).setAlpha(0).setScale(0).setVisible(false);
        this.confirmElements.push(noGraphics);

        const noText = this.add.text(CONSTS.WIDTH / 2 + 90, CONSTS.HEIGHT / 2 + 45, 'Нет', { fontSize: '24px', fill: '#000', fontFamily: 'Arial' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setScrollFactor(0).setDepth(16).setAlpha(0).setScale(0).setVisible(false);
        this.confirmElements.push(noText);
        noText.on('pointerdown', () => {
            this.hideConfirmExit();
        });

        // Анимация появления с задержкой для текста
        this.tweens.add({
            targets: [confirmBg, shadowGraphics, yesGraphics, noGraphics],
            scale: { from: 0, to: 1 },
            alpha: { from: 0, to: 1 },
            duration: 800,
            ease: 'Power2',
            onStart: () => {
                [confirmBg, shadowGraphics, yesGraphics, noGraphics].forEach(target => target.setVisible(true));
            }
        });

        this.tweens.add({
            targets: [confirmText, yesText, noText],
            scale: { from: 0, to: 1 },
            alpha: { from: 0, to: 1 },
            duration: 800,
            delay: 400, // Задержка 200 мс для текста
            ease: 'Power2',
            onStart: () => {
                [confirmText, yesText, noText].forEach(target => target.setVisible(true));
            }
        });
    }

    // Метод для скрытия окна подтверждения и возобновления игры
    hideConfirmExit() {
        this.confirmElements.forEach(element => {
            element.destroy();
        });
        this.confirmElements = [];
        this.physics.resume();
        this.pausedForConfirm = false;
        
        // ФИКС: Показываем сенсорные зоны обратно при возобновлении игры
        this.showTouchZones();
    }

    updateScore() {
        // НОВОЕ: Обновляем максимальную высоту только если игрок поднялся выше предыдущего максимума
        if (this.player.y < this.maxReachedY) {
            this.maxReachedY = this.player.y;
            console.log('🎯 Новая максимальная высота достигнута! maxReachedY:', this.maxReachedY);
        }
        
        // ИЗМЕНЕНО: Height считается от maxReachedY (не от текущей позиции)
        // Очки растут только когда игрок поднимается выше своего максимума
        const currentHeight = Math.max(0, this.playerStartY - this.maxReachedY);
        this.heightScore = Math.max(this.heightScore, currentHeight);
        this.score = this.heightScore + this.killScore;
        this.scoreText.setText(`Score: ${Math.floor(this.score / CONSTS.SCORE_HEIGHT_INCREMENT) * CONSTS.SCORE_HEIGHT_INCREMENT}`);
    }

    handleResize() {
        // ФИКС: При RESIZE режиме обновляем размеры камеры под новый viewport
        const { width, height } = this.scale;
        const camera = this.cameras.main;
        camera.setSize(width, height);
        
        // Обновляем фон под новый размер
        if (this.background) {
            this.background.setDisplaySize(width, height);
        }
        
        console.log('📐 Resize:', width, 'x', height);
    }

    // ФИКС: Очистка при выходе из сцены (критично для Telegram!)
    cleanup() {
        console.log('🧹 Очистка GameScene при выходе в меню...');
        
        // Останавливаем все таймеры
        if (this.dumbTimer) {
            this.dumbTimer.remove();
            this.dumbTimer = null;
        }
        
        // НОВОЕ: Очищаем сенсорные зоны
        if (this.touchZones) {
            this.touchZones.forEach(zone => {
                if (zone && zone.destroy) {
                    zone.destroy();
                }
            });
            this.touchZones = null;
        }
        
        // Сбрасываем флаги касаний
        this.touchLeft = false;
        this.touchRight = false;
        this.touchJump = false;
        
        // Очищаем все события клавиатуры
        if (this.input && this.input.keyboard) {
            this.input.keyboard.removeAllListeners();
        }
        
        // Отписываемся от resize
        this.scale.off('resize', this.handleResize, this);
        
        // Останавливаем физику
        if (this.physics && this.physics.world) {
            this.physics.pause();
        }
        
        // Удаляем коллайдеры
        if (this.collider) {
            this.collider.destroy();
            this.collider = null;
        }
        if (this.groundCollider) {
            this.groundCollider.destroy();
            this.groundCollider = null;
        }
        
        // Очищаем confirmElements
        if (this.confirmElements && this.confirmElements.length > 0) {
            this.confirmElements.forEach(element => {
                if (element && element.destroy) {
                    element.destroy();
                }
            });
            this.confirmElements = [];
        }
        
        console.log('✅ GameScene очищен успешно');
    }

    // ==================== EQUIPPED ITEMS SYSTEM ====================
    async loadEquippedItems(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/user/equipped/${userId}`);
            const data = await response.json();
            
            if (data.success && data.equipped) {
                this.equippedItems = data.equipped;
                console.log('✅ Загружены экипированные предметы:', this.equippedItems);
                
                // Применяем скин если есть
                if (this.equippedItems.skin) {
                    this.playerSkin = this.equippedItems.skin;
                    this.applySkinToPlayer();
                }
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки экипировки:', error);
        }
    }

    applySkinToPlayer() {
        if (!this.player || !this.playerSkin) return;
        
        // Меняем цвет/эффект в зависимости от скина
        const skinEffects = {
            'skin_golden_monkey': { tint: 0xFFD700, glow: true },  // Золотой
            'skin_cyber_monkey': { tint: 0x00FFFF, glow: true },   // Киберпанк
            'skin_ninja_monkey': { tint: 0x1A1A1A, alpha: 0.9 },   // Ниндзя (темный)
            'skin_fire': { tint: 0xFF4500, glow: true },           // Огненный
            'skin_golden': { tint: 0xFFD700 }                      // Золотой (старый)
        };

        const effect = skinEffects[this.playerSkin];
        if (effect) {
            if (effect.tint) this.player.setTint(effect.tint);
            if (effect.alpha) this.player.setAlpha(effect.alpha);
            if (effect.glow) {
                // Добавляем свечение (можно улучшить через шейдеры)
                this.tweens.add({
                    targets: this.player,
                    alpha: 0.8,
                    duration: 1000,
                    yoyo: true,
                    repeat: -1
                });
            }
            console.log('🎨 Применён скин:', this.playerSkin);
        }
    }

    // Применяет игровые эффекты от бустов (высота прыжка, щит и т.д.)
    // ВАЖНО: Прыжковые бусты работают только первые 3 секунды!
    applyBoostEffects() {
        if (!this.equippedItems || !this.equippedItems.boost) {
            console.log('ℹ️ Нет бустов для применения эффектов');
            return;
        }

        const boostId = this.equippedItems.boost;
        console.log('🎮 Применяем игровые эффекты буста:', boostId);

        // Super Jump - увеличивает высоту прыжка на 30% НА 3 СЕКУНДЫ
        if (boostId === 'boost_super_jump') {
            this.activateTimedBoost('jump', 1.3); // 3 секунды
            console.log('🚀 Высота прыжка увеличена на 30% (3 сек)');
        }
        
        // Shield - защита от одного падения (работает всю игру, но одноразово)
        if (boostId === 'boost_shield') {
            this.hasShield = true;
            console.log('🛡️ Щит активирован');
        }
        
        // Mega Pack - комбо (прыжок НА 3 СЕК + щит)
        if (boostId === 'boost_mega_pack') {
            this.activateTimedBoost('jump', 1.3); // 3 секунды
            this.hasShield = true;
            console.log('⭐ МЕГА БУСТ: Прыжок +30% (3 сек) + Щит');
        }
        
        // Double Coins - только бонус к финальному счёту (нет игровых эффектов)
        if (boostId === 'boost_double_coins') {
            console.log('💰 Double Coins: бонус будет начислен в конце игры');
        }
    }

    // НОВОЕ: Активация временного буста с таймером
    activateTimedBoost(type, multiplier) {
        if (type === 'jump') {
            this.jumpMultiplier = multiplier;
            this.boostActive = true;
            
            // Создаём UI таймер буста
            this.showBoostTimer();
            
            // Запускаем таймер на 3 секунды
            this.boostTimer = this.time.delayedCall(this.boostDuration, () => {
                this.deactivateTimedBoost();
            });
            
            // Обновляем UI таймера каждые 100мс
            this.updateBoostTimerInterval = this.time.addEvent({
                delay: 100,
                callback: () => this.updateBoostTimerUI(),
                loop: true
            });
        }
    }
    
    // НОВОЕ: Деактивация временного буста
    deactivateTimedBoost() {
        console.log('⏱️ Буст закончился!');
        this.jumpMultiplier = 1.0; // Сбрасываем множитель
        this.boostActive = false;
        
        // Убираем UI таймера
        if (this.boostTimerText) {
            // Анимация исчезновения
            this.tweens.add({
                targets: this.boostTimerText,
                alpha: 0,
                scale: 0.5,
                duration: 300,
                onComplete: () => {
                    if (this.boostTimerText) {
                        this.boostTimerText.destroy();
                        this.boostTimerText = null;
                    }
                }
            });
        }
        
        // Останавливаем интервал обновления
        if (this.updateBoostTimerInterval) {
            this.updateBoostTimerInterval.remove();
            this.updateBoostTimerInterval = null;
        }
        
        // Показываем уведомление
        const endText = this.add.text(CONSTS.WIDTH / 2, 150, '⏱️ Буст закончился!', {
            fontSize: '28px',
            fill: '#FF6600',
            fontStyle: 'bold',
            stroke: '#000',
            strokeThickness: 4
        }).setOrigin(0.5).setDepth(100).setScrollFactor(0);
        
        this.tweens.add({
            targets: endText,
            alpha: 0,
            y: 100,
            duration: 1500,
            onComplete: () => endText.destroy()
        });
    }
    
    // НОВОЕ: Показываем UI таймера буста
    showBoostTimer() {
        const boostId = this.equippedItems?.boost;
        const boostIcons = {
            'boost_super_jump': '🚀',
            'boost_mega_pack': '⭐'
        };
        const icon = boostIcons[boostId] || '⚡';
        
        this.boostTimerText = this.add.text(CONSTS.WIDTH / 2, 100, `${icon} 3.0s`, {
            fontSize: '32px',
            fill: '#00FF00',
            fontStyle: 'bold',
            stroke: '#000',
            strokeThickness: 4,
            backgroundColor: '#000000AA',
            padding: { x: 15, y: 8 }
        }).setOrigin(0.5).setDepth(100).setScrollFactor(0);
        
        // Анимация появления
        this.boostTimerText.setAlpha(0);
        this.boostTimerText.setScale(0.5);
        this.tweens.add({
            targets: this.boostTimerText,
            alpha: 1,
            scale: 1,
            duration: 300
        });
    }
    
    // НОВОЕ: Обновление UI таймера
    updateBoostTimerUI() {
        if (!this.boostTimerText || !this.boostTimer) return;
        
        const remaining = this.boostTimer.getRemaining() / 1000;
        const boostId = this.equippedItems?.boost;
        const boostIcons = {
            'boost_super_jump': '🚀',
            'boost_mega_pack': '⭐'
        };
        const icon = boostIcons[boostId] || '⚡';
        
        this.boostTimerText.setText(`${icon} ${remaining.toFixed(1)}s`);
        
        // Меняем цвет когда мало времени
        if (remaining <= 1) {
            this.boostTimerText.setFill('#FF0000');
        } else if (remaining <= 2) {
            this.boostTimerText.setFill('#FFFF00');
        }
    }

    async applyBoostBonuses(baseScore) {
        console.log('🎯 applyBoostBonuses вызван с baseScore:', baseScore);
        console.log('🎯 equippedItems:', this.equippedItems);
        
        if (!this.equippedItems || !this.equippedItems.boost) {
            console.log('⚠️ Нет экипированных бустов, возврат базового счёта');
            return baseScore; // Нет бустов
        }

        const boostId = this.equippedItems.boost;
        console.log('✅ Применяем буст:', boostId);
        let bonusScore = 0;

        // Бонусы от разных бустов (к финальному счёту)
        const boostBonuses = {
            'boost_super_jump': baseScore * 0.15,       // +15% к счёту
            'boost_double_coins': baseScore * 0.5,      // +50% к счёту
            'boost_shield': baseScore * 0.1,            // +10% к счёту (+ защита от падения)
            'boost_mega_pack': baseScore * 0.5,         // +50% к счёту (+ прыжок 3сек + щит)
            'trail_effect': 500,                        // +500 фиксированных очков
            'basic_platform_skin': 300                  // +300 фиксированных очков
        };

        bonusScore = boostBonuses[boostId] || 0;
        
        if (bonusScore === 0) {
            console.warn(`⚠️ Буст ${boostId} не найден в boostBonuses! Доступные:`, Object.keys(boostBonuses));
        }
        
        const finalScore = Math.floor(baseScore + bonusScore);

        console.log(`💎 Буст ${boostId}: ${baseScore} + ${bonusScore} = ${finalScore}`);
        
        return finalScore;
    }

    showActiveBoosts() {
        console.log('🔍 showActiveBoosts вызван, equippedItems:', this.equippedItems);
        
        if (!this.equippedItems) {
            console.log('⚠️ equippedItems не загружены');
            return;
        }

        // Показываем активный буст (только для бустов без таймера)
        if (this.equippedItems.boost) {
            console.log('✅ Найден экипированный буст:', this.equippedItems.boost);
            
            const boostId = this.equippedItems.boost;
            
            // Для временных бустов (super_jump, mega_pack) таймер уже показывается
            // Показываем иконку только для постоянных бустов (shield, double_coins)
            if (boostId === 'boost_shield' || boostId === 'boost_double_coins') {
                const boostIcons = {
                    'boost_double_coins': '💰',
                    'boost_shield': '🛡️'
                };
                
                const icon = boostIcons[boostId] || '🎁';
                console.log('💎 Отображаем иконку буста:', icon);

                // Иконка в правом верхнем углу
                const boostIcon = this.add.text(CONSTS.WIDTH - 50, 30, icon, {
                    fontSize: '40px',
                    fill: '#FFD700'
                }).setOrigin(0.5).setDepth(100).setScrollFactor(0);

                // Анимация пульсации
                this.tweens.add({
                    targets: boostIcon,
                    scale: 1.2,
                    duration: 800,
                    yoyo: true,
                    repeat: -1,
                    ease: 'Sine.easeInOut'
                });
            }
        } else {
            console.log('⚠️ Нет активного буста для отображения');
        }
    }

    // Расходование буста после завершения игры
    async consumeBoostAfterGame(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/user/consume-boost`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            });

            const data = await response.json();

            if (data.success && data.consumedBoostId) {
                console.log(`🔥 Буст израсходован: ${data.consumedBoostId}`);
            } else {
                console.log('ℹ️ Буст не был экипирован');
            }
        } catch (error) {
            console.error('❌ Ошибка расходования буста:', error);
        }
    }

    // Отправка результата в турнир
    async submitTournamentScore(userId, tournamentId, score) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/tournaments/${tournamentId}/submit-score`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, score })
            });

            const data = await response.json();

            if (data.success) {
                if (data.newBest) {
                    console.log(`🏆 Новый рекорд турнира: ${score} (был ${data.previousBest})`);
                    
                    // Показываем уведомление
                    const notif = this.add.text(CONSTS.WIDTH / 2, 200, '🏆 Новый рекорд турнира!', {
                        fontSize: '24px',
                        fill: '#FFD700',
                        fontStyle: 'bold',
                        stroke: '#000',
                        strokeThickness: 4,
                        backgroundColor: '#000000AA',
                        padding: { x: 20, y: 10 }
                    }).setOrigin(0.5).setDepth(1001).setScrollFactor(0);
                    
                    this.tweens.add({
                        targets: notif,
                        alpha: 0,
                        y: 150,
                        duration: 3000,
                        delay: 1000,
                        onComplete: () => notif.destroy()
                    });
                } else {
                    console.log(`🎯 Турнир: ${score}, лучший: ${data.best}`);
                }
            } else {
                console.log('⚠️ Турнир не активен или вы не участник');
            }
            
            // Очищаем ID турнира
            localStorage.removeItem('currentTournamentId');
            
        } catch (error) {
            console.error('❌ Ошибка отправки результата в турнир:', error);
        }
    }
}

// ==================== INVENTORY SCENE ====================
class InventoryScene extends Phaser.Scene {
    constructor() {
        super({ key: 'InventoryScene' });
        this.purchases = [];
        this.equipped = {};
    }

    async create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // Заголовок - улучшенный стиль как в меню
        this.add.text(CONSTS.WIDTH / 2, 50, '🎒 Инвентарь', {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);

        // Загружаем данные
        const userData = getTelegramUserId();
        await this.loadInventory(userData.id);

        // Кнопка назад - улучшенный стиль
        const backBtn = this.add.graphics();
        backBtn.fillStyle(0xFF4444, 1);
        backBtn.fillRoundedRect(20, CONSTS.HEIGHT - 70, 120, 50, 8);
        
        const backText = this.add.text(80, CONSTS.HEIGHT - 45, 'Назад', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);

        const backZone = this.add.rectangle(80, CONSTS.HEIGHT - 45, 120, 50, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.scene.start('MenuScene'));
    }

    async loadInventory(userId) {
        try {
            // Загружаем покупки и экипировку
            const [purchasesRes, equippedRes] = await Promise.all([
                fetch(`${API_SERVER_URL}/api/shop/purchases/${userId}`),
                fetch(`${API_SERVER_URL}/api/user/equipped/${userId}`)
            ]);

            const purchasesData = await purchasesRes.json();
            const equippedData = await equippedRes.json();

            if (purchasesData.success) {
                this.purchases = purchasesData.purchases;
            }

            if (equippedData.success) {
                this.equipped = equippedData.equipped;
            }

            this.displayItems();
        } catch (error) {
            console.error('❌ Ошибка загрузки инвентаря:', error);
            this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Ошибка загрузки', {
                fontSize: '20px',
                fill: '#F00'
            }).setOrigin(0.5);
        }
    }

    displayItems() {
        if (this.purchases.length === 0) {
            this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Инвентарь пуст\n\nПокупайте предметы в магазине!', {
                fontSize: '18px',
                fill: '#FFFFFF',
                fontFamily: 'Arial',
                align: 'center',
                stroke: '#000000',
                strokeThickness: 2
            }).setOrigin(0.5);
            return;
        }

        const startY = 120;
        const itemHeight = 85;

        this.purchases.forEach((item, index) => {
            const y = startY + (index * itemHeight);
            const isEquipped = Object.values(this.equipped).includes(item.item_id);
            
            // Подсчитываем общее количество (active + equipped)
            const activeCount = parseInt(item.count) || 0;
            const equippedCount = parseInt(item.equipped_count) || 0;
            const totalCount = activeCount + equippedCount;

            // Фон предмета с обводкой
            const bg = this.add.graphics();
            bg.fillStyle(isEquipped ? 0x4CAF50 : 0x2a2a2a, 0.9);
            bg.fillRoundedRect(20, y, CONSTS.WIDTH - 40, 75, 12);
            bg.lineStyle(2, isEquipped ? 0x81C784 : 0x444444, 1);
            bg.strokeRoundedRect(20, y, CONSTS.WIDTH - 40, 75, 12);

            // Название с количеством - улучшенный стиль
            const countText = totalCount > 1 ? ` x${totalCount}` : '';
            this.add.text(35, y + 12, item.item_name + countText, {
                fontSize: '16px',
                fill: '#FFFFFF',
                fontFamily: 'Arial',
                fontStyle: 'bold',
                stroke: '#000000',
                strokeThickness: 1
            });

            // Статус - улучшенный стиль
            const statusText = isEquipped ? '✅ ЭКИПИРОВАНО' : '📦 В инвентаре';
            this.add.text(35, y + 38, statusText, {
                fontSize: '13px',
                fill: isEquipped ? '#90EE90' : '#BBBBBB',
                fontFamily: 'Arial'
            });

            // Кнопки справа - улучшенный стиль
            if (isEquipped) {
                // Кнопка "Снять" для экипированных предметов
                const unequipBtn = this.add.graphics();
                unequipBtn.fillStyle(0xFF5722, 1);
                unequipBtn.fillRoundedRect(CONSTS.WIDTH - 130, y + 18, 100, 38, 8);

                this.add.text(CONSTS.WIDTH - 80, y + 37, 'Снять', {
                    fontSize: '14px',
                    fill: '#FFFFFF',
                    fontFamily: 'Arial',
                    fontStyle: 'bold',
                    stroke: '#000000',
                    strokeThickness: 1
                }).setOrigin(0.5);

                const unequipZone = this.add.rectangle(CONSTS.WIDTH - 80, y + 37, 100, 38, 0x000000, 0)
                    .setInteractive({ useHandCursor: true })
                    .on('pointerdown', () => this.unequipItem(item));
            } else {
                // Кнопка "Надеть" (короче чем "Экипировать")
                const equipBtn = this.add.graphics();
                equipBtn.fillStyle(0x2196F3, 1);
                equipBtn.fillRoundedRect(CONSTS.WIDTH - 130, y + 18, 100, 38, 8);

                this.add.text(CONSTS.WIDTH - 80, y + 37, 'Надеть', {
                    fontSize: '14px',
                    fill: '#FFFFFF',
                    fontFamily: 'Arial',
                    fontStyle: 'bold',
                    stroke: '#000000',
                    strokeThickness: 1
                }).setOrigin(0.5);

                const equipZone = this.add.rectangle(CONSTS.WIDTH - 80, y + 37, 100, 38, 0x000000, 0)
                    .setInteractive({ useHandCursor: true })
                    .on('pointerdown', () => this.equipItem(item));
            }
        });
    }

    async equipItem(item) {
        const userData = getTelegramUserId();
        
        // Определяем тип предмета по ID
        let itemType = 'skin';
        if (item.item_id.includes('nft_')) itemType = 'nft';
        else if (item.item_id.includes('boost_')) itemType = 'boost';

        try {
            const response = await fetch(`${API_SERVER_URL}/api/user/equip`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userData.id,
                    itemId: item.item_id,
                    itemType: itemType
                })
            });

            const data = await response.json();

            if (data.success) {
                console.log('✅ Экипировано:', item.item_name);
                // Перезагружаем сцену
                this.scene.restart();
            } else {
                console.error('❌ Ошибка экипировки:', data.error);
            }
        } catch (error) {
            console.error('❌ Ошибка запроса:', error);
        }
    }

    async unequipItem(item) {
        const userData = getTelegramUserId();
        
        // Определяем тип предмета
        let itemType = 'skin';
        if (item.item_id.includes('nft_')) itemType = 'nft';
        else if (item.item_id.includes('boost_')) itemType = 'boost';

        try {
            const response = await fetch(`${API_SERVER_URL}/api/user/unequip`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userData.id,
                    itemType: itemType,
                    itemId: item.item_id // Передаем itemId для возврата в active
                })
            });

            const data = await response.json();

            if (data.success) {
                console.log('✅ Снято:', item.item_name);
                // Перезагружаем сцену
                this.scene.restart();
            } else {
                console.error('❌ Ошибка снятия:', data.error);
            }
        } catch (error) {
            console.error('❌ Ошибка запроса:', error);
        }
    }
}

// ==================== STATS SCENE ====================
class StatsScene extends Phaser.Scene {
    constructor() {
        super({ key: 'StatsScene' });
        this.stats = null;
    }

    async create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // Заголовок
        this.add.text(CONSTS.WIDTH / 2, 45, '📊 Статистика', {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);

        // Загрузка...
        this.loadingText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, '⏳ Загрузка...', {
            fontSize: '20px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        // Загружаем данные
        const userData = getTelegramUserId();
        await this.loadStats(userData.id, userData.username);

        // Кнопка назад
        const backBtn = this.add.graphics();
        backBtn.fillStyle(0xFF4444, 1);
        backBtn.fillRoundedRect(20, CONSTS.HEIGHT - 70, 120, 50, 8);
        
        this.add.text(80, CONSTS.HEIGHT - 45, 'Назад', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);

        this.add.rectangle(80, CONSTS.HEIGHT - 45, 120, 50, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.scene.start('MenuScene'));
    }

    async loadStats(userId, username) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/stats/${userId}`);
            const data = await response.json();

            if (data.success) {
                this.stats = data.stats;
                this.loadingText.destroy();
                this.displayStats(username);
            } else {
                this.loadingText.setText('❌ Ошибка загрузки');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки статистики:', error);
            this.loadingText.setText('❌ Ошибка соединения');
        }
    }

    displayStats(username) {
        const s = this.stats;
        const startY = 90;
        const lineHeight = 32;
        let y = startY;

        // Имя игрока и ранг
        this.createCard(20, y, CONSTS.WIDTH - 40, 70, 0x4a148c);
        this.add.text(CONSTS.WIDTH / 2, y + 20, `👤 ${username}`, {
            fontSize: '22px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);
        
        const rankText = s.rank !== '-' ? `🏆 #${s.rank} в рейтинге` : '🏆 Нет в рейтинге';
        this.add.text(CONSTS.WIDTH / 2, y + 48, rankText, {
            fontSize: '14px',
            fill: '#FFD700',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        y += 85;

        // Секция: Игры
        this.createSectionTitle(y, '🎮 Игры');
        y += 30;
        
        this.createCard(20, y, CONSTS.WIDTH - 40, 100, 0x1a237e);
        this.createStatRow(y + 15, '📈 Всего игр:', s.totalGames.toLocaleString());
        this.createStatRow(y + 40, '🏅 Лучший счёт:', s.bestScore.toLocaleString());
        this.createStatRow(y + 65, '📊 Средний счёт:', s.avgScore.toLocaleString());
        y += 115;

        // Секция: Дуэли
        this.createSectionTitle(y, '⚔️ Дуэли');
        y += 30;
        
        this.createCard(20, y, CONSTS.WIDTH - 40, 100, 0x1b5e20);
        this.createStatRow(y + 15, '🎯 Всего дуэлей:', s.totalDuels.toLocaleString());
        this.createStatRow(y + 40, '✅ Победы:', `${s.duelsWon} (${s.winRate}%)`);
        this.createStatRow(y + 65, '❌ Поражения:', s.duelsLost.toLocaleString());
        y += 115;

        // Секция: Экономика
        this.createSectionTitle(y, '💰 Экономика');
        y += 30;
        
        this.createCard(20, y, CONSTS.WIDTH - 40, 75, 0xb71c1c);
        this.createStatRow(y + 15, '🍌 Monkey Coins:', s.monkeyCoins.toLocaleString());
        this.createStatRow(y + 40, '🛒 Покупки:', s.totalPurchases.toLocaleString());
        y += 90;

        // Общий счёт внизу
        this.createCard(20, y, CONSTS.WIDTH - 40, 50, 0xff6f00);
        this.add.text(CONSTS.WIDTH / 2, y + 25, `🔥 Всего очков: ${s.totalScore.toLocaleString()}`, {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);
    }

    createCard(x, y, width, height, color) {
        const card = this.add.graphics();
        card.fillStyle(color, 0.85);
        card.fillRoundedRect(x, y, width, height, 12);
        card.lineStyle(2, 0xffffff, 0.3);
        card.strokeRoundedRect(x, y, width, height, 12);
    }

    createSectionTitle(y, text) {
        this.add.text(30, y + 5, text, {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 3
        });
    }

    createStatRow(y, label, value) {
        this.add.text(35, y, label, {
            fontSize: '14px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        });
        
        this.add.text(CONSTS.WIDTH - 35, y, String(value), {
            fontSize: '14px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(1, 0);
    }
}

// ==================== WALLET SCENE (TON CONNECT) ====================
class WalletScene extends Phaser.Scene {
    constructor() {
        super({ key: 'WalletScene' });
        this.tonConnectUI = null;
        this.walletInfo = null;
        this.isConnecting = false;
    }

    async create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // Заголовок
        this.add.text(CONSTS.WIDTH / 2, 45, '💎 TON Кошелёк', {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);

        // Загрузка
        this.statusText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, '⏳ Загрузка...', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        // Инициализируем TON Connect
        await this.initTonConnect();

        // Загружаем данные кошелька
        const userData = getTelegramUserId();
        await this.loadWalletInfo(userData.id);

        // Кнопка назад
        this.createBackButton();
    }

    async initTonConnect() {
        try {
            // Проверяем наличие TON Connect UI
            if (typeof TON_CONNECT_UI === 'undefined' && typeof window.TonConnectUI === 'undefined') {
                console.warn('⚠️ TON Connect UI не загружен');
                return;
            }

            const TonConnectUIClass = window.TonConnectUI || TON_CONNECT_UI?.TonConnectUI;
            
            if (!TonConnectUIClass) {
                console.warn('⚠️ TonConnectUI class не найден');
                return;
            }

            // Создаём экземпляр TON Connect UI
            // Манифест хостится на API сервере
            this.tonConnectUI = new TonConnectUIClass({
                manifestUrl: 'https://monkey-flipper-djm1.onrender.com/tonconnect-manifest.json',
                buttonRootId: null // Мы не используем встроенную кнопку
            });

            // Подписываемся на изменения статуса подключения
            this.tonConnectUI.onStatusChange((wallet) => {
                console.log('🔄 TON Wallet status changed:', wallet);
                if (wallet) {
                    this.onWalletConnected(wallet);
                } else {
                    this.onWalletDisconnected();
                }
            });

            // Проверяем, может кошелёк уже подключён (из localStorage)
            const currentWallet = this.tonConnectUI.wallet;
            if (currentWallet) {
                console.log('📱 Найден уже подключённый кошелёк:', currentWallet);
                await this.onWalletConnected(currentWallet);
            }

            console.log('✅ TON Connect UI инициализирован');
        } catch (error) {
            console.error('❌ Ошибка инициализации TON Connect:', error);
        }
    }

    async loadWalletInfo(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/wallet/ton-info/${userId}`);
            const data = await response.json();

            this.statusText.destroy();

            if (data.success) {
                this.walletInfo = data;
                this.displayWalletUI();
            } else {
                this.showError('Ошибка загрузки');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки кошелька:', error);
            this.statusText.setText('❌ Ошибка соединения');
        }
    }

    displayWalletUI() {
        const startY = 100;

        if (this.walletInfo.connected) {
            // Кошелёк подключён
            this.showConnectedWallet(startY);
        } else {
            // Кошелёк не подключён
            this.showConnectPrompt(startY);
        }
    }

    showConnectedWallet(startY) {
        const wallet = this.walletInfo.wallet;
        let y = startY;

        // Карточка с информацией о кошельке
        this.createCard(20, y, CONSTS.WIDTH - 40, 120, 0x0088cc);
        
        // Статус
        this.add.text(CONSTS.WIDTH / 2, y + 20, '✅ Кошелёк подключён', {
            fontSize: '18px',
            fill: '#00FF00',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);

        // Адрес
        this.add.text(CONSTS.WIDTH / 2, y + 50, wallet.shortAddress, {
            fontSize: '22px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5);

        // Баланс TON
        this.add.text(CONSTS.WIDTH / 2, y + 85, `💎 ${wallet.tonBalance.toFixed(4)} TON`, {
            fontSize: '16px',
            fill: '#FFD700',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        y += 140;

        // Информация о возможностях
        this.createCard(20, y, CONSTS.WIDTH - 40, 100, 0x1a237e);
        
        this.add.text(CONSTS.WIDTH / 2, y + 20, '🎮 Возможности:', {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);

        this.add.text(CONSTS.WIDTH / 2, y + 45, '• Покупка NFT и предметов за TON', {
            fontSize: '13px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        this.add.text(CONSTS.WIDTH / 2, y + 65, '• Вывод заработанных наград', {
            fontSize: '13px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        this.add.text(CONSTS.WIDTH / 2, y + 85, '• Торговля на маркетплейсе', {
            fontSize: '13px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        y += 120;

        // Кнопка отключения
        this.createButton(
            CONSTS.WIDTH / 2, y + 30,
            '🔌 Отключить кошелёк',
            0xFF5722,
            () => this.disconnectWallet()
        );
    }

    showConnectPrompt(startY) {
        let y = startY;

        // Описание
        this.createCard(20, y, CONSTS.WIDTH - 40, 150, 0x1a237e);
        
        this.add.text(CONSTS.WIDTH / 2, y + 25, '💎 Подключите TON кошелёк', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);

        this.add.text(CONSTS.WIDTH / 2, y + 55, 'Для доступа к:', {
            fontSize: '14px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        const features = [
            '• NFT коллекциям и предметам',
            '• Выводу наград за игру',
            '• Торговле на маркетплейсе'
        ];

        features.forEach((text, i) => {
            this.add.text(CONSTS.WIDTH / 2, y + 80 + (i * 20), text, {
                fontSize: '13px',
                fill: '#AAAAAA',
                fontFamily: 'Arial'
            }).setOrigin(0.5);
        });

        y += 170;

        // Кнопка подключения (основная)
        this.createButton(
            CONSTS.WIDTH / 2, y + 30,
            '🔗 Подключить кошелёк',
            0x0088cc,
            () => this.connectWallet()
        );

        y += 80;

        // Поддерживаемые кошельки
        this.add.text(CONSTS.WIDTH / 2, y, 'Поддерживаются: Tonkeeper, TON Space, MyTonWallet', {
            fontSize: '11px',
            fill: '#888888',
            fontFamily: 'Arial'
        }).setOrigin(0.5);
    }

    async connectWallet() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        try {
            if (!this.tonConnectUI) {
                // Fallback: открываем Tonkeeper напрямую
                this.openTonkeeperConnect();
                return;
            }

            console.log('🔗 Открываем TON Connect модальное окно...');
            
            // Открываем модальное окно TON Connect и ждём результат
            const connectedWallet = await this.tonConnectUI.connectWallet();
            
            console.log('📱 connectWallet результат:', connectedWallet);
            
            // Если подключение успешно - сохраняем
            if (connectedWallet) {
                await this.onWalletConnected(connectedWallet);
            }
            
        } catch (error) {
            console.error('❌ Ошибка подключения:', error);
            // Не показываем ошибку если пользователь просто закрыл окно
            if (error?.message !== 'User closed the modal window') {
                this.showError('Ошибка подключения к кошельку');
            }
        } finally {
            this.isConnecting = false;
        }
    }

    openTonkeeperConnect() {
        // Fallback для Telegram - открываем Tonkeeper
        const userData = getTelegramUserId();
        const returnUrl = encodeURIComponent('https://t.me/MonkeyFlipperBot/app');
        
        // Deep link для Tonkeeper
        const tonkeeperUrl = `https://app.tonkeeper.com/ton-connect?` +
            `v=2&id=${userData.id}&r=${returnUrl}`;
        
        if (window.Telegram?.WebApp) {
            window.Telegram.WebApp.openLink(tonkeeperUrl);
        } else {
            window.open(tonkeeperUrl, '_blank');
        }
        
        this.isConnecting = false;
    }

    async onWalletConnected(wallet) {
        console.log('✅ Кошелёк подключён:', JSON.stringify(wallet, null, 2));
        
        const userData = getTelegramUserId();
        
        // TON Connect возвращает адрес в wallet.account.address (raw format)
        // или может быть в wallet.account.publicKey
        const address = wallet.account?.address || wallet.address;
        
        console.log('📍 Извлечённый адрес:', address);

        if (!address) {
            console.error('❌ Нет адреса в wallet. Структура:', Object.keys(wallet));
            this.showError('Не удалось получить адрес кошелька');
            return;
        }

        // Сохраняем на сервер
        try {
            console.log('📤 Отправка на сервер:', { userId: userData.id, walletAddress: address });
            
            const response = await fetch(`${API_SERVER_URL}/api/wallet/connect-ton`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userData.id,
                    walletAddress: address
                })
            });

            const data = await response.json();
            console.log('📥 Ответ сервера:', data);

            if (data.success) {
                console.log('✅ Кошелёк сохранён на сервере');
                // Перезагружаем сцену
                this.scene.restart();
            } else {
                this.showError(data.error || 'Ошибка сохранения');
            }
        } catch (error) {
            console.error('❌ Ошибка сохранения кошелька:', error);
            this.showError('Ошибка соединения');
        }
    }

    async onWalletDisconnected() {
        console.log('🔌 Кошелёк отключён');
    }

    async disconnectWallet() {
        const userData = getTelegramUserId();

        try {
            // Отключаем через TON Connect UI если есть
            if (this.tonConnectUI) {
                await this.tonConnectUI.disconnect();
            }

            // Удаляем с сервера
            const response = await fetch(`${API_SERVER_URL}/api/wallet/disconnect-ton`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: userData.id })
            });

            const data = await response.json();

            if (data.success) {
                console.log('✅ Кошелёк отключён');
                this.scene.restart();
            } else {
                this.showError('Ошибка отключения');
            }
        } catch (error) {
            console.error('❌ Ошибка отключения:', error);
            this.showError('Ошибка соединения');
        }
    }

    createCard(x, y, width, height, color) {
        const card = this.add.graphics();
        card.fillStyle(color, 0.85);
        card.fillRoundedRect(x, y, width, height, 12);
        card.lineStyle(2, 0xffffff, 0.3);
        card.strokeRoundedRect(x, y, width, height, 12);
    }

    createButton(x, y, text, color, callback) {
        const btn = this.add.graphics();
        btn.fillStyle(color, 1);
        btn.fillRoundedRect(x - 130, y - 22, 260, 44, 10);

        const btnText = this.add.text(x, y, text, {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);

        const btnZone = this.add.rectangle(x, y, 260, 44, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', callback)
            .on('pointerover', () => btn.setAlpha(0.8))
            .on('pointerout', () => btn.setAlpha(1));
    }

    createBackButton() {
        const backBtn = this.add.graphics();
        backBtn.fillStyle(0xFF4444, 1);
        backBtn.fillRoundedRect(20, CONSTS.HEIGHT - 70, 120, 50, 8);
        
        this.add.text(80, CONSTS.HEIGHT - 45, 'Назад', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);

        this.add.rectangle(80, CONSTS.HEIGHT - 45, 120, 50, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.scene.start('MenuScene'));
    }

    showError(message) {
        const errorText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 120, `❌ ${message}`, {
            fontSize: '14px',
            fill: '#FF6666',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        this.time.delayedCall(3000, () => errorText.destroy());
    }
}

// ==================== ACHIEVEMENTS SCENE ====================
class AchievementsScene extends Phaser.Scene {
    constructor() {
        super({ key: 'AchievementsScene' });
        this.achievementsData = null;
        this.scrollY = 0;
        this.maxScroll = 0;
        this.achievementCards = [];
    }

    async create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // Заголовок
        this.add.text(CONSTS.WIDTH / 2, 45, '🎯 Достижения', {
            fontSize: '28px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);

        // Загрузка
        this.statusText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, '⏳ Загрузка...', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        // Загружаем достижения
        const userData = getTelegramUserId();
        
        // Сначала проверяем новые достижения
        await this.checkNewAchievements(userData.id);
        await this.loadAchievements(userData.id);

        // Кнопка назад
        this.createBackButton();
        
        // Настраиваем скролл
        this.setupScroll();
    }

    async checkNewAchievements(userId) {
        try {
            await fetch(`${API_SERVER_URL}/api/achievements/check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            });
        } catch (error) {
            console.error('Check achievements error:', error);
        }
    }

    async loadAchievements(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/achievements/${userId}`);
            const data = await response.json();

            this.statusText.destroy();

            if (data.success) {
                this.achievementsData = data;
                this.displayAchievementsUI(userId);
            } else {
                this.showError('Ошибка загрузки');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки достижений:', error);
            this.statusText.setText('❌ Ошибка соединения');
        }
    }

    displayAchievementsUI(userId) {
        const stats = this.achievementsData.stats;
        let y = 85;

        // Статистика сверху
        this.createCard(20, y, CONSTS.WIDTH - 40, 70, 0x1a237e);
        
        this.add.text(CONSTS.WIDTH / 2, y + 20, `🏆 ${stats.unlocked}/${stats.total} достижений`, {
            fontSize: '18px',
            fill: '#FFD700',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);

        if (stats.unclaimedRewards > 0) {
            const claimAllBtn = this.add.text(CONSTS.WIDTH / 2, y + 48, `💰 Забрать всё: +${stats.unclaimedRewards} 🪙`, {
                fontSize: '14px',
                fill: '#00FF00',
                fontFamily: 'Arial Black',
                backgroundColor: '#2e7d32',
                padding: { x: 15, y: 5 }
            }).setOrigin(0.5).setInteractive({ useHandCursor: true });
            
            claimAllBtn.on('pointerdown', () => this.claimAllRewards(userId));
        }

        y += 90;

        // Создаём контейнер для скролла
        this.scrollContainer = this.add.container(0, 0);
        
        // Группируем по категориям
        const categories = [
            { id: 'game', name: '🎮 Игровые', color: 0x1976d2 },
            { id: 'progress', name: '📈 Прогресс', color: 0x7b1fa2 },
            { id: 'social', name: '👥 Социальные', color: 0x388e3c },
            { id: 'economy', name: '💰 Экономика', color: 0xf57c00 },
            { id: 'duel', name: '⚔️ Дуэли', color: 0xd32f2f },
            { id: 'streak', name: '🔥 Серии', color: 0x512da8 }
        ];

        let scrollY = y;
        
        categories.forEach(cat => {
            const catAchievements = this.achievementsData.achievements.filter(a => a.category === cat.id);
            if (catAchievements.length === 0) return;
            
            // Заголовок категории
            const catTitle = this.add.text(25, scrollY, cat.name, {
                fontSize: '16px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            });
            this.scrollContainer.add(catTitle);
            
            scrollY += 30;
            
            // Достижения в категории
            catAchievements.forEach(ach => {
                const card = this.createAchievementCard(20, scrollY, ach, userId, cat.color);
                this.scrollContainer.add(card);
                this.achievementCards.push({ y: scrollY, card });
                scrollY += 75;
            });
            
            scrollY += 10;
        });

        this.maxScroll = Math.max(0, scrollY - CONSTS.HEIGHT + 150);
        
        // Маска для скролла
        const maskShape = this.make.graphics();
        maskShape.fillRect(0, y - 10, CONSTS.WIDTH, CONSTS.HEIGHT - y - 60);
        const mask = maskShape.createGeometryMask();
        this.scrollContainer.setMask(mask);
    }

    createAchievementCard(x, y, achievement, userId, categoryColor) {
        const container = this.add.container(0, 0);
        const cardWidth = CONSTS.WIDTH - 40;
        const cardHeight = 65;
        
        // Фон карточки
        const bg = this.add.graphics();
        const bgColor = achievement.unlocked ? (achievement.claimed ? 0x37474f : 0x2e7d32) : 0x263238;
        bg.fillStyle(bgColor, 0.9);
        bg.fillRoundedRect(x, y, cardWidth, cardHeight, 10);
        
        // Граница
        const borderColor = achievement.unlocked ? (achievement.claimed ? 0x546e7a : 0x4caf50) : 0x455a64;
        bg.lineStyle(2, borderColor, 1);
        bg.strokeRoundedRect(x, y, cardWidth, cardHeight, 10);
        container.add(bg);
        
        // Иконка
        const icon = this.add.text(x + 30, y + cardHeight/2, achievement.icon, {
            fontSize: '28px'
        }).setOrigin(0.5);
        container.add(icon);
        
        // Название
        const nameColor = achievement.unlocked ? '#FFFFFF' : '#888888';
        const name = this.add.text(x + 60, y + 15, achievement.name, {
            fontSize: '14px',
            fill: nameColor,
            fontFamily: 'Arial Black'
        });
        container.add(name);
        
        // Описание
        const desc = this.add.text(x + 60, y + 33, achievement.description, {
            fontSize: '11px',
            fill: '#AAAAAA',
            fontFamily: 'Arial'
        });
        container.add(desc);
        
        // Прогресс или награда
        if (!achievement.unlocked) {
            // Прогресс бар
            const progressWidth = 80;
            const progressPercent = Math.min(achievement.progress / achievement.target, 1);
            
            const progressBg = this.add.graphics();
            progressBg.fillStyle(0x455a64, 1);
            progressBg.fillRoundedRect(x + cardWidth - progressWidth - 15, y + 20, progressWidth, 12, 6);
            container.add(progressBg);
            
            if (progressPercent > 0) {
                const progressFill = this.add.graphics();
                progressFill.fillStyle(categoryColor, 1);
                progressFill.fillRoundedRect(x + cardWidth - progressWidth - 15, y + 20, progressWidth * progressPercent, 12, 6);
                container.add(progressFill);
            }
            
            const progressText = this.add.text(x + cardWidth - progressWidth/2 - 15, y + 26, 
                `${achievement.progress}/${achievement.target}`, {
                fontSize: '9px',
                fill: '#FFFFFF',
                fontFamily: 'Arial'
            }).setOrigin(0.5);
            container.add(progressText);
            
            // Награда внизу
            const rewardText = this.add.text(x + cardWidth - 50, y + 48, `+${achievement.reward}🪙`, {
                fontSize: '11px',
                fill: '#888888',
                fontFamily: 'Arial'
            }).setOrigin(0.5);
            container.add(rewardText);
        } else if (!achievement.claimed) {
            // Кнопка забрать
            const claimBtn = this.add.graphics();
            claimBtn.fillStyle(0x4caf50, 1);
            claimBtn.fillRoundedRect(x + cardWidth - 90, y + 18, 75, 30, 8);
            container.add(claimBtn);
            
            const claimText = this.add.text(x + cardWidth - 52, y + 33, `+${achievement.reward}🪙`, {
                fontSize: '12px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }).setOrigin(0.5);
            container.add(claimText);
            
            const claimZone = this.add.rectangle(x + cardWidth - 52, y + 33, 75, 30, 0x000000, 0)
                .setInteractive({ useHandCursor: true })
                .on('pointerdown', () => this.claimReward(userId, achievement.id));
            container.add(claimZone);
        } else {
            // Уже забрано
            const claimed = this.add.text(x + cardWidth - 50, y + 33, '✅', {
                fontSize: '20px'
            }).setOrigin(0.5);
            container.add(claimed);
        }
        
        return container;
    }

    async claimReward(userId, achievementId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/achievements/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, achievementId })
            });

            const data = await response.json();

            if (data.success) {
                this.showRewardPopup(data.achievement, data.reward);
                this.time.delayedCall(1500, () => this.scene.restart());
            } else {
                this.showError(data.error || 'Ошибка');
            }
        } catch (error) {
            console.error('Claim error:', error);
            this.showError('Ошибка соединения');
        }
    }

    async claimAllRewards(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/achievements/claim-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            });

            const data = await response.json();

            if (data.success && data.claimed > 0) {
                this.showBigRewardPopup(data.claimed, data.totalReward);
                this.time.delayedCall(2000, () => this.scene.restart());
            } else if (data.claimed === 0) {
                this.showError('Нет наград для получения');
            }
        } catch (error) {
            console.error('Claim all error:', error);
            this.showError('Ошибка соединения');
        }
    }

    showRewardPopup(achievement, reward) {
        const overlay = this.add.rectangle(0, 0, CONSTS.WIDTH, CONSTS.HEIGHT, 0x000000, 0.7)
            .setOrigin(0, 0).setDepth(100);
        
        const popup = this.add.graphics().setDepth(101);
        popup.fillStyle(0x2e7d32, 1);
        popup.fillRoundedRect(CONSTS.WIDTH/2 - 120, CONSTS.HEIGHT/2 - 60, 240, 120, 12);
        
        this.add.text(CONSTS.WIDTH/2, CONSTS.HEIGHT/2 - 30, `${achievement.icon} ${achievement.name}`, {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5).setDepth(102);
        
        this.add.text(CONSTS.WIDTH/2, CONSTS.HEIGHT/2 + 10, `+${reward} 🪙`, {
            fontSize: '28px',
            fill: '#FFD700',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5).setDepth(102);
    }

    showBigRewardPopup(count, totalReward) {
        const overlay = this.add.rectangle(0, 0, CONSTS.WIDTH, CONSTS.HEIGHT, 0x000000, 0.8)
            .setOrigin(0, 0).setDepth(100);
        
        const popup = this.add.graphics().setDepth(101);
        popup.fillStyle(0x4caf50, 1);
        popup.fillRoundedRect(CONSTS.WIDTH/2 - 140, CONSTS.HEIGHT/2 - 80, 280, 160, 15);
        popup.lineStyle(4, 0xffd700, 1);
        popup.strokeRoundedRect(CONSTS.WIDTH/2 - 140, CONSTS.HEIGHT/2 - 80, 280, 160, 15);
        
        this.add.text(CONSTS.WIDTH/2, CONSTS.HEIGHT/2 - 50, '🎉 Награды получены!', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5).setDepth(102);
        
        this.add.text(CONSTS.WIDTH/2, CONSTS.HEIGHT/2, `${count} достижений`, {
            fontSize: '14px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0.5).setDepth(102);
        
        this.add.text(CONSTS.WIDTH/2, CONSTS.HEIGHT/2 + 40, `+${totalReward} 🪙`, {
            fontSize: '32px',
            fill: '#FFD700',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5).setDepth(102);
    }

    setupScroll() {
        this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
            this.scrollY = Phaser.Math.Clamp(this.scrollY + deltaY * 0.5, 0, this.maxScroll);
            if (this.scrollContainer) {
                this.scrollContainer.y = -this.scrollY;
            }
        });
        
        // Touch scroll
        let startY = 0;
        let startScrollY = 0;
        
        this.input.on('pointerdown', (pointer) => {
            startY = pointer.y;
            startScrollY = this.scrollY;
        });
        
        this.input.on('pointermove', (pointer) => {
            if (pointer.isDown) {
                const deltaY = startY - pointer.y;
                this.scrollY = Phaser.Math.Clamp(startScrollY + deltaY, 0, this.maxScroll);
                if (this.scrollContainer) {
                    this.scrollContainer.y = -this.scrollY;
                }
            }
        });
    }

    createCard(x, y, width, height, color) {
        const card = this.add.graphics();
        card.fillStyle(color, 0.85);
        card.fillRoundedRect(x, y, width, height, 12);
        card.lineStyle(2, 0xffffff, 0.3);
        card.strokeRoundedRect(x, y, width, height, 12);
    }

    createBackButton() {
        const btn = this.add.text(80, CONSTS.HEIGHT - 45, '← Назад', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5).setDepth(200);

        this.add.rectangle(80, CONSTS.HEIGHT - 45, 120, 50, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.scene.start('MenuScene'))
            .setDepth(200);
    }

    showError(message) {
        const errorText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 100, `❌ ${message}`, {
            fontSize: '14px',
            fill: '#FF6666',
            fontFamily: 'Arial'
        }).setOrigin(0.5).setDepth(200);

        this.time.delayedCall(3000, () => errorText.destroy());
    }
}

// ==================== DAILY REWARD SCENE ====================
class DailyRewardScene extends Phaser.Scene {
    constructor() {
        super({ key: 'DailyRewardScene' });
        this.rewardStatus = null;
    }

    async create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // Заголовок
        this.add.text(CONSTS.WIDTH / 2, 45, '🏆 Ежедневные награды', {
            fontSize: '26px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);

        // Загрузка
        this.statusText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, '⏳ Загрузка...', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        // Загружаем статус
        const userData = getTelegramUserId();
        await this.loadRewardStatus(userData.id);

        // Кнопка назад
        this.createBackButton();
    }

    async loadRewardStatus(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/daily-reward/status/${userId}`);
            const data = await response.json();

            this.statusText.destroy();

            if (data.success) {
                this.rewardStatus = data;
                this.displayRewardUI(userId);
            } else {
                this.showError('Ошибка загрузки');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки наград:', error);
            this.statusText.setText('❌ Ошибка соединения');
        }
    }

    displayRewardUI(userId) {
        let y = 90;

        // Статус streak
        this.createCard(20, y, CONSTS.WIDTH - 40, 80, 0x1a237e);
        
        const streakText = this.rewardStatus.currentStreak === 0 
            ? 'Начни серию!' 
            : `🔥 Серия: ${this.rewardStatus.currentStreak} дней`;
        
        this.add.text(CONSTS.WIDTH / 2, y + 25, streakText, {
            fontSize: '20px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5);

        this.add.text(CONSTS.WIDTH / 2, y + 55, `Всего получено: ${this.rewardStatus.totalClaimed} 🪙`, {
            fontSize: '14px',
            fill: '#AAAAAA',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        y += 100;

        // Календарь наград (7 дней)
        this.createCard(20, y, CONSTS.WIDTH - 40, 280, 0x2e3b4e);
        
        this.add.text(CONSTS.WIDTH / 2, y + 20, '📅 Награды по дням', {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);

        // Рисуем календарь (3 ряда по дням)
        const rewards = this.rewardStatus.rewards;
        const cardSize = 80;
        const gap = 15;
        const startX = (CONSTS.WIDTH - (3 * cardSize + 2 * gap)) / 2;
        
        rewards.forEach((reward, i) => {
            if (i >= 7) return; // Показываем только текущую неделю
            
            const row = Math.floor(i / 3);
            const col = i % 3;
            const cardX = startX + col * (cardSize + gap);
            const cardY = y + 55 + row * (cardSize + gap);
            
            this.drawRewardCard(cardX, cardY, cardSize, reward, i + 1);
        });

        y += 300;

        // Кнопка получения награды или информация
        if (this.rewardStatus.canClaim) {
            const nextReward = this.rewardStatus.nextReward;
            
            // Информация о награде
            this.add.text(CONSTS.WIDTH / 2, y, `День ${nextReward.day}`, {
                fontSize: '16px',
                fill: '#FFFFFF',
                fontFamily: 'Arial Black'
            }).setOrigin(0.5);
            
            const rewardText = nextReward.multiplier 
                ? `+${nextReward.coins} 🪙 (${nextReward.multiplier})`
                : `+${nextReward.coins} 🪙`;
            
            this.add.text(CONSTS.WIDTH / 2, y + 25, rewardText, {
                fontSize: '24px',
                fill: '#FFD700',
                fontFamily: 'Arial Black',
                stroke: '#000000',
                strokeThickness: 3
            }).setOrigin(0.5);
            
            if (nextReward.bonus) {
                this.add.text(CONSTS.WIDTH / 2, y + 55, nextReward.bonus, {
                    fontSize: '14px',
                    fill: '#00FF00',
                    fontFamily: 'Arial'
                }).setOrigin(0.5);
            }
            
            // Кнопка забрать
            this.createButton(
                CONSTS.WIDTH / 2, y + 90,
                '🎁 Забрать награду',
                0x4CAF50,
                () => this.claimReward(userId)
            );
        } else {
            // Уже забрал сегодня
            this.add.text(CONSTS.WIDTH / 2, y + 20, '✅ Награда получена!', {
                fontSize: '18px',
                fill: '#00FF00',
                fontFamily: 'Arial Black'
            }).setOrigin(0.5);
            
            this.add.text(CONSTS.WIDTH / 2, y + 50, 'Возвращайся завтра за новой наградой', {
                fontSize: '13px',
                fill: '#AAAAAA',
                fontFamily: 'Arial'
            }).setOrigin(0.5);
        }
    }

    drawRewardCard(x, y, size, reward, dayNum) {
        const card = this.add.graphics();
        
        // Определяем цвет карточки
        let bgColor = 0x37474f; // Серый (не получено)
        let borderColor = 0x546e7a;
        
        if (reward.completed) {
            bgColor = 0x2e7d32; // Зелёный (получено)
            borderColor = 0x4caf50;
        } else if (reward.current) {
            bgColor = 0x1976d2; // Синий (текущий день)
            borderColor = 0x2196f3;
        }
        
        // Рисуем карточку
        card.fillStyle(bgColor, 0.9);
        card.fillRoundedRect(x, y, size, size, 8);
        card.lineStyle(2, borderColor, 1);
        card.strokeRoundedRect(x, y, size, size, 8);
        
        // День
        const dayText = this.add.text(x + size / 2, y + 15, `День ${dayNum}`, {
            fontSize: '11px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);
        
        // Награда
        const coinText = this.add.text(x + size / 2, y + 40, `${reward.coins}`, {
            fontSize: '18px',
            fill: '#FFD700',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);
        
        this.add.text(x + size / 2, y + 58, '🪙', {
            fontSize: '14px',
        }).setOrigin(0.5);
        
        // Статус
        if (reward.completed) {
            this.add.text(x + size / 2, y + size - 10, '✅', {
                fontSize: '12px',
            }).setOrigin(0.5);
        } else if (reward.current) {
            // Анимация мерцания для текущего дня
            this.tweens.add({
                targets: [dayText, coinText],
                alpha: 0.5,
                duration: 800,
                yoyo: true,
                repeat: -1
            });
        }
    }

    async claimReward(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/daily-reward/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
            });

            const data = await response.json();

            if (data.success) {
                // Показываем анимацию получения награды
                this.showRewardAnimation(data.reward);
                
                // Перезагружаем сцену через 3 секунды
                this.time.delayedCall(3000, () => {
                    this.scene.restart();
                });
            } else if (data.alreadyClaimed) {
                this.showError('Уже забрал сегодня!');
            } else {
                this.showError(data.error || 'Ошибка');
            }
        } catch (error) {
            console.error('❌ Ошибка получения награды:', error);
            this.showError('Ошибка соединения');
        }
    }

    showRewardAnimation(reward) {
        // Затемнение
        const overlay = this.add.rectangle(0, 0, CONSTS.WIDTH, CONSTS.HEIGHT, 0x000000, 0.8)
            .setOrigin(0, 0)
            .setDepth(100);

        // Контейнер награды
        const rewardBg = this.add.graphics().setDepth(101);
        rewardBg.fillStyle(0x4caf50, 1);
        rewardBg.fillRoundedRect(CONSTS.WIDTH / 2 - 140, CONSTS.HEIGHT / 2 - 100, 280, 200, 12);
        rewardBg.lineStyle(4, 0xffd700, 1);
        rewardBg.strokeRoundedRect(CONSTS.WIDTH / 2 - 140, CONSTS.HEIGHT / 2 - 100, 280, 200, 12);

        // Текст
        const congrats = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 60, '🎉 Награда получена!', {
            fontSize: '20px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5).setDepth(102);

        const coins = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 10, `+${reward.coins} 🪙`, {
            fontSize: '32px',
            fill: '#FFD700',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5).setDepth(102);

        if (reward.bonus) {
            this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 + 35, reward.bonus, {
                fontSize: '14px',
                fill: '#00FF00',
                fontFamily: 'Arial'
            }).setOrigin(0.5).setDepth(102);
        }

        const streak = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 + 65, `🔥 Серия: ${reward.newStreak || 1} дней`, {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5).setDepth(102);

        // Анимация появления
        [overlay, rewardBg, congrats, coins, streak].forEach(obj => {
            obj.setAlpha(0);
            this.tweens.add({
                targets: obj,
                alpha: 1,
                duration: 500,
                ease: 'Power2'
            });
        });

        // Анимация монет
        this.tweens.add({
            targets: coins,
            scale: { from: 0.5, to: 1.2 },
            duration: 600,
            ease: 'Back.easeOut'
        });
    }

    createButton(x, y, text, color, callback) {
        const btnWidth = 220;
        const btnHeight = 45;

        const btnGraphics = this.add.graphics();
        btnGraphics.fillStyle(color, 1);
        btnGraphics.fillRoundedRect(x - btnWidth/2, y - btnHeight/2, btnWidth, btnHeight, 10);

        const btnText = this.add.text(x, y, text, {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);

        const btnZone = this.add.rectangle(x, y, btnWidth, btnHeight, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', callback)
            .on('pointerover', () => {
                btnGraphics.clear();
                btnGraphics.fillStyle(color, 0.8);
                btnGraphics.fillRoundedRect(x - btnWidth/2, y - btnHeight/2, btnWidth, btnHeight, 10);
            })
            .on('pointerout', () => {
                btnGraphics.clear();
                btnGraphics.fillStyle(color, 1);
                btnGraphics.fillRoundedRect(x - btnWidth/2, y - btnHeight/2, btnWidth, btnHeight, 10);
            });

        return { graphics: btnGraphics, text: btnText, zone: btnZone };
    }

    createCard(x, y, width, height, color) {
        const card = this.add.graphics();
        card.fillStyle(color, 0.85);
        card.fillRoundedRect(x, y, width, height, 12);
        card.lineStyle(2, 0xffffff, 0.3);
        card.strokeRoundedRect(x, y, width, height, 12);
    }

    createBackButton() {
        this.add.text(80, CONSTS.HEIGHT - 45, '← Назад', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5);

        this.add.rectangle(80, CONSTS.HEIGHT - 45, 120, 50, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.scene.start('MenuScene'));
    }

    showError(message) {
        const errorText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 100, `❌ ${message}`, {
            fontSize: '14px',
            fill: '#FF6666',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        this.time.delayedCall(3000, () => errorText.destroy());
    }
}

// ==================== REFERRAL SCENE ====================
class ReferralScene extends Phaser.Scene {
    constructor() {
        super({ key: 'ReferralScene' });
        this.referralStats = null;
    }

    async create() {
        // Фон
        this.background = this.add.image(0, 0, 'background_img_menu').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // Заголовок
        this.add.text(CONSTS.WIDTH / 2, 45, '🎁 Рефералы', {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 4
        }).setOrigin(0.5);

        // Загрузка
        this.statusText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, '⏳ Загрузка...', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        // Загружаем статистику
        const userData = getTelegramUserId();
        await this.loadReferralStats(userData.id);

        // Кнопка назад
        this.createBackButton();
    }

    async loadReferralStats(userId) {
        try {
            const response = await fetch(`${API_SERVER_URL}/api/referral/stats/${userId}`);
            const data = await response.json();

            this.statusText.destroy();

            if (data.success) {
                this.referralStats = data;
                this.displayReferralUI(userId);
            } else {
                this.showError('Ошибка загрузки');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки рефералов:', error);
            this.statusText.setText('❌ Ошибка соединения');
        }
    }

    displayReferralUI(userId) {
        let y = 90;

        // Реферальная ссылка
        this.createCard(20, y, CONSTS.WIDTH - 40, 130, 0x1a237e);
        
        this.add.text(CONSTS.WIDTH / 2, y + 20, '📤 Твоя реферальная ссылка:', {
            fontSize: '14px',
            fill: '#AAAAAA',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        // Формируем ссылку для Mini App
        const botUsername = 'monkey_test_crypto_bot'; // Имя бота
        const referralLink = `https://t.me/${botUsername}?startapp=ref_${userId}`;
        
        // Показываем короткую версию
        const shortLink = `t.me/${botUsername}?startapp=ref_${userId}`;
        
        this.add.text(CONSTS.WIDTH / 2, y + 50, shortLink, {
            fontSize: '13px',
            fill: '#00BFFF',
            fontFamily: 'Arial',
            wordWrap: { width: CONSTS.WIDTH - 60 }
        }).setOrigin(0.5);

        // Кнопка копирования/отправки
        this.createButton(
            CONSTS.WIDTH / 2, y + 95,
            '📋 Поделиться ссылкой',
            0x4CAF50,
            () => this.shareReferralLink(referralLink)
        );

        y += 150;

        // Статистика
        this.createCard(20, y, CONSTS.WIDTH - 40, 120, 0x2e7d32);
        
        this.add.text(CONSTS.WIDTH / 2, y + 20, '📊 Твоя статистика', {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);

        const stats = this.referralStats.stats;
        
        this.add.text(CONSTS.WIDTH / 2 - 60, y + 50, `👥 Приглашено:`, {
            fontSize: '14px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0, 0.5);
        
        this.add.text(CONSTS.WIDTH / 2 + 80, y + 50, `${stats.totalReferrals}`, {
            fontSize: '14px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(1, 0.5);

        this.add.text(CONSTS.WIDTH / 2 - 60, y + 75, `💰 Заработано:`, {
            fontSize: '14px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0, 0.5);
        
        this.add.text(CONSTS.WIDTH / 2 + 80, y + 75, `${stats.totalEarned} 🪙`, {
            fontSize: '14px',
            fill: '#FFD700',
            fontFamily: 'Arial Black'
        }).setOrigin(1, 0.5);

        this.add.text(CONSTS.WIDTH / 2 - 60, y + 100, `🎁 За друга:`, {
            fontSize: '14px',
            fill: '#CCCCCC',
            fontFamily: 'Arial'
        }).setOrigin(0, 0.5);
        
        this.add.text(CONSTS.WIDTH / 2 + 80, y + 100, `+${stats.bonusPerReferral} 🪙`, {
            fontSize: '14px',
            fill: '#00FF00',
            fontFamily: 'Arial Black'
        }).setOrigin(1, 0.5);

        y += 140;

        // Список приглашённых
        this.createCard(20, y, CONSTS.WIDTH - 40, 180, 0x37474f);
        
        this.add.text(CONSTS.WIDTH / 2, y + 20, '👥 Приглашённые друзья', {
            fontSize: '16px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);

        const referrals = this.referralStats.referrals;
        
        if (referrals.length === 0) {
            this.add.text(CONSTS.WIDTH / 2, y + 90, 'Пока никого не пригласили\nПоделись ссылкой с друзьями!', {
                fontSize: '13px',
                fill: '#888888',
                fontFamily: 'Arial',
                align: 'center'
            }).setOrigin(0.5);
        } else {
            // Показываем до 5 последних рефералов
            const displayRefs = referrals.slice(0, 5);
            displayRefs.forEach((ref, i) => {
                const refY = y + 45 + (i * 25);
                const statusIcon = ref.bonusPaid ? '✅' : '⏳';
                const username = ref.username.length > 15 
                    ? ref.username.slice(0, 15) + '...' 
                    : ref.username;
                
                this.add.text(40, refY, `${statusIcon} @${username}`, {
                    fontSize: '12px',
                    fill: '#FFFFFF',
                    fontFamily: 'Arial'
                });
                
                this.add.text(CONSTS.WIDTH - 40, refY, ref.bonusPaid ? `+${ref.bonusAmount}🪙` : 'ждём игру', {
                    fontSize: '12px',
                    fill: ref.bonusPaid ? '#00FF00' : '#FFD700',
                    fontFamily: 'Arial'
                }).setOrigin(1, 0);
            });
            
            if (referrals.length > 5) {
                this.add.text(CONSTS.WIDTH / 2, y + 165, `... и ещё ${referrals.length - 5}`, {
                    fontSize: '11px',
                    fill: '#888888',
                    fontFamily: 'Arial'
                }).setOrigin(0.5);
            }
        }

        y += 200;

        // Инструкция
        this.add.text(CONSTS.WIDTH / 2, y + 10, '💡 Ты получишь бонус, когда друг\nсыграет свою первую игру!', {
            fontSize: '12px',
            fill: '#AAAAAA',
            fontFamily: 'Arial',
            align: 'center'
        }).setOrigin(0.5);
    }

    shareReferralLink(link) {
        const text = `🐵 Играй в Monkey Flipper!\n\n🎮 Прыгай, собирай монеты и соревнуйся с друзьями!\n\n🎁 Переходи по ссылке и получи бонус:`;
        
        // Используем Telegram Share
        if (window.Telegram?.WebApp) {
            // Открываем Telegram share диалог
            const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
            window.Telegram.WebApp.openTelegramLink(shareUrl);
        } else {
            // Fallback - копируем в буфер
            navigator.clipboard.writeText(link).then(() => {
                this.showMessage('✅ Ссылка скопирована!');
            }).catch(() => {
                this.showError('Не удалось скопировать');
            });
        }
    }

    showMessage(message) {
        const msgText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 100, message, {
            fontSize: '16px',
            fill: '#00FF00',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);

        this.time.delayedCall(2000, () => msgText.destroy());
    }

    createButton(x, y, text, color, callback) {
        const btnWidth = 200;
        const btnHeight = 40;

        const btnGraphics = this.add.graphics();
        btnGraphics.fillStyle(color, 1);
        btnGraphics.fillRoundedRect(x - btnWidth/2, y - btnHeight/2, btnWidth, btnHeight, 8);

        const btnText = this.add.text(x, y, text, {
            fontSize: '14px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black'
        }).setOrigin(0.5);

        const btnZone = this.add.rectangle(x, y, btnWidth, btnHeight, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', callback)
            .on('pointerover', () => {
                btnGraphics.clear();
                btnGraphics.fillStyle(color, 0.8);
                btnGraphics.fillRoundedRect(x - btnWidth/2, y - btnHeight/2, btnWidth, btnHeight, 8);
            })
            .on('pointerout', () => {
                btnGraphics.clear();
                btnGraphics.fillStyle(color, 1);
                btnGraphics.fillRoundedRect(x - btnWidth/2, y - btnHeight/2, btnWidth, btnHeight, 8);
            });

        return { graphics: btnGraphics, text: btnText, zone: btnZone };
    }

    createCard(x, y, width, height, color) {
        const card = this.add.graphics();
        card.fillStyle(color, 0.85);
        card.fillRoundedRect(x, y, width, height, 12);
        card.lineStyle(2, 0xffffff, 0.3);
        card.strokeRoundedRect(x, y, width, height, 12);
    }

    createBackButton() {
        this.add.text(80, CONSTS.HEIGHT - 45, '← Назад', {
            fontSize: '18px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5);

        this.add.rectangle(80, CONSTS.HEIGHT - 45, 120, 50, 0x000000, 0)
            .setInteractive({ useHandCursor: true })
            .on('pointerdown', () => this.scene.start('MenuScene'));
    }

    showError(message) {
        const errorText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 100, `❌ ${message}`, {
            fontSize: '14px',
            fill: '#FF6666',
            fontFamily: 'Arial'
        }).setOrigin(0.5);

        this.time.delayedCall(3000, () => errorText.destroy());
    }
}

// Конфиг Phaser
const config = {
    type: Phaser.CANVAS, // Canvas рендерер - четче для текста чем WebGL
    width: CONSTS.WIDTH,
    height: CONSTS.HEIGHT,
    parent: 'game-container',
    scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    render: {
        antialias: true,
        pixelArt: false,
        roundPixels: false
    },
    physics: {
        default: 'arcade',
        arcade: {
            gravity: { y: CONSTS.GRAVITY },
            debug: CONSTS.DEBUG_PHYSICS
        },
    },
    scene: [MenuScene, LeaderboardScene, InventoryScene, StatsScene, WalletScene, AchievementsScene, DailyRewardScene, ReferralScene, TournamentScene, MatchmakingScene, DuelHistoryScene, GameScene]
};

// Инициализация
const game = new Phaser.Game(config);