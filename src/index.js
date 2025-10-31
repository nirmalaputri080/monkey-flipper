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
    : 'https://monkey-flipper-1v1-server.onrender.com';

// API сервер (Vercel) - для сохранения счетов и лидерборда
const API_SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3000'  // Для локальной разработки
    : window.location.origin;  // Используем тот же домен (Vercel)

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
        console.log(`📤 Отправка счета на сервер: userId=${userId}, score=${score}`);
        
        const response = await fetch(`${API_SERVER_URL}/api/save-score`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                userId: userId,
                username: username,
                score: score,
                timestamp: new Date().toISOString()
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        console.log('✅ Сервер ответил:', result);
        
        // Возвращаем результат (новый рекорд или нет)
        return {
            success: true,
            isNewRecord: result.isNewRecord,
            bestScore: result.bestScore,
            gamesPlayed: result.gamesPlayed
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
        const pending = JSON.parse(localStorage.getItem('pendingScores') || '[]');
        pending.push({
            userId: userId,
            username: username,
            score: score,
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

class MenuScene extends Phaser.Scene {
    constructor() {
        super({ key: 'MenuScene' });
        this.scoreBoardElements = []; // Массив для элементов экрана рекордов
        this.shopElements = []; // НОВОЕ: Массив для элементов экрана магазина
    }

    preload() {
        this.load.image('background_img', 'assets/background.png');
        this.load.image('logo', 'assets/LogoJumper.png');
    }

    create() {
        // Фон с растяжкой (stretch) без повторения, как в GameScene
        this.background = this.add.image(0, 0, 'background_img').setOrigin(0, 0);
        this.background.setDisplaySize(CONSTS.WIDTH, CONSTS.HEIGHT);

        // НОВОЕ: Отладочная информация о Telegram пользователе
        const userData = getTelegramUserId();
        const isTelegram = window.Telegram?.WebApp?.initDataUnsafe?.user ? '✅' : '❌';
        
        // Фон для отладочной панели
        const debugBg = this.add.graphics();
        debugBg.fillStyle(0x000000, 0.8);
        debugBg.fillRoundedRect(10, 10, CONSTS.WIDTH - 20, 100, 10);
        debugBg.setDepth(20);
        
        // Информация о пользователе
        const debugText = this.add.text(20, 20, 
            `${isTelegram} Telegram SDK\n` +
            `👤 Player: ${userData.username}\n` +
            `🆔 ID: ${userData.id}`,
            { 
                fontSize: '16px', 
                fill: '#FFFFFF', 
                fontFamily: 'Arial',
                lineSpacing: 5
            }
        ).setDepth(21);

        const titleImage = this.add.image(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 4, 'logo').setOrigin(0.5).setAlpha(0);
        this.tweens.add({
            targets: titleImage,
            scale: { from: 0, to: 1 },
            alpha: { from: 0, to: 1 },
            duration: 1000,
            ease: 'Bounce.easeOut'
        });

        // Кнопки (увеличили расстояние между ними)
        const buttons = [
            { text: 'Start', y: CONSTS.HEIGHT / 2, callback: () => this.scene.start('GameScene') },
            { text: '1v1 Online', y: CONSTS.HEIGHT / 2 + 80, callback: () => this.scene.start('MatchmakingScene') }, // НОВОЕ: 1v1 режим
            { text: 'Leaderboard', y: CONSTS.HEIGHT / 2 + 160, callback: () => this.openLeaderboard() },
            { text: 'Shop', y: CONSTS.HEIGHT / 2 + 240, callback: () => this.showShop() }, // НОВОЕ: Кнопка для магазина
            {
                text: 'Exit', y: CONSTS.HEIGHT / 2 + 320, callback: () => { // НОВОЕ: Сдвинул Exit еще ниже
                    if (!window.close()) {
                        this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 + 200, 'Please close the tab', { fontSize: '24px', fill: '#F00' }).setOrigin(0.5);
                    }
                }
            }
        ];

        buttons.forEach(btnData => {
            const btnGraphics = this.add.graphics().setDepth(1);
            btnGraphics.fillStyle(0xFFFFFF, 1);
            btnGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 100, btnData.y - 30, 200, 60, 10);

            const btnText = this.add.text(CONSTS.WIDTH / 2, btnData.y, btnData.text, { fontSize: '32px', fill: '#000', fontFamily: 'Arial' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(2);

            const setButtonColor = (hover) => {
                btnGraphics.clear();
                btnGraphics.fillStyle(hover ? 0xCCCCCC : 0xFFFFFF, 1);
                btnGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 100, btnData.y - 30, 200, 60, 10);
            };

            btnText.on('pointerover', () => setButtonColor(true));
            btnText.on('pointerout', () => setButtonColor(false));
            btnText.on('pointerdown', btnData.callback);

            // Анимация появления
            [btnGraphics, btnText].forEach(obj => {
                obj.setAlpha(0);
                this.tweens.add({
                    targets: obj,
                    alpha: 1,
                    duration: 800,
                    ease: 'Power2'
                });
            });
        });
    }

    // Метод для показа экрана рекордов
    // ФИКС: Открываем leaderboard.html вместо показа локальных рекордов
    openLeaderboard() {
        console.log('📊 Открываем таблицу лидеров...');
        
        // Проверяем, запущено ли в Telegram
        if (window.Telegram && window.Telegram.WebApp) {
            const tg = window.Telegram.WebApp;
            
            // Получаем текущий URL игры
            const currentUrl = window.location.origin;
            const leaderboardUrl = `${currentUrl}/leaderboard.html`;
            
            console.log('🔗 Открываем URL:', leaderboardUrl);
            
            // Открываем в Telegram через openLink
            tg.openLink(leaderboardUrl);
        } else {
            // Если не в Telegram - открываем в новой вкладке браузера
            console.log('🌐 Открываем в новой вкладке браузера');
            window.open('/leaderboard.html', '_blank');
        }
    }

    // УБРАНО: Старый метод showScoreBoard() больше не используется
    // Метод для скрытия экрана рекордов - больше не нужен
    hideScoreBoard() {
        // Пустой метод для обратной совместимости
    }

    // НОВОЕ: Метод для показа экрана магазина
    showShop() {
        // Загружаем валюту из localStorage
        let bananas = parseInt(localStorage.getItem('bananas')) || 0;
        let coins = parseInt(localStorage.getItem('coins')) || 0;

        // Динамическая высота для магазина (для скинов, бустов и заработка)
        const shopHeight = 500;
        const shopWidth = 400;

        // Фон для Shop
        const shopBg = this.add.graphics();
        shopBg.fillStyle(0x000000, 0.7);
        shopBg.fillRoundedRect(CONSTS.WIDTH / 2 - shopWidth / 2, CONSTS.HEIGHT / 2 - shopHeight / 2, shopWidth, shopHeight, 15);
        shopBg.setDepth(14).setAlpha(0).setScale(0);
        this.shopElements.push(shopBg);

        // Тень
        const shadowGraphics = this.add.graphics();
        shadowGraphics.fillStyle(0x000000, 0.5);
        shadowGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - shopWidth / 2 + 5, CONSTS.HEIGHT / 2 - shopHeight / 2 + 5, shopWidth, shopHeight, 15);
        shadowGraphics.setDepth(13).setAlpha(0).setScale(0);
        this.shopElements.push(shadowGraphics);

        // Заголовок
        const titleText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 30, 'Shop', { fontSize: '32px', fill: '#FFFFFF', fontFamily: 'Arial Black', stroke: '#000000', strokeThickness: 4, align: 'center' }).setOrigin(0.5).setDepth(15).setAlpha(0).setScale(0);
        this.shopElements.push(titleText);

        // Отображение валюты
        const bananasText = this.add.text(CONSTS.WIDTH / 2 - 100, CONSTS.HEIGHT / 2 - shopHeight / 2 + 70, `Bananas: ${bananas}`, { fontSize: '24px', fill: '#FFFFFF' }).setOrigin(0.5).setDepth(15).setAlpha(0).setScale(0);
        this.shopElements.push(bananasText);

        const coinsText = this.add.text(CONSTS.WIDTH / 2 + 100, CONSTS.HEIGHT / 2 - shopHeight / 2 + 70, `Coins: ${coins}`, { fontSize: '24px', fill: '#FFFFFF' }).setOrigin(0.5).setDepth(15).setAlpha(0).setScale(0);
        this.shopElements.push(coinsText);

        // Секция заработка бананов (моки)
        const dailyButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 110, 'Daily Quest (+50 Bananas)', { fontSize: '20px', fill: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(15).setAlpha(0).setScale(0);
        dailyButton.on('pointerdown', () => {
            bananas += 50;
            localStorage.setItem('bananas', bananas);
            bananasText.setText(`Bananas: ${bananas}`);
        });
        this.shopElements.push(dailyButton);

        const adButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 140, 'Watch Ad (+100 Bananas)', { fontSize: '20px', fill: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(15).setAlpha(0).setScale(0);
        adButton.on('pointerdown', () => {
            bananas += 100;
            localStorage.setItem('bananas', bananas);
            bananasText.setText(`Bananas: ${bananas}`);
        });
        this.shopElements.push(adButton);

        const buyCoinsButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 170, 'Buy Coins (+100 for real, mock)', { fontSize: '20px', fill: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(15).setAlpha(0).setScale(0);
        buyCoinsButton.on('pointerdown', () => {
            coins += 100;
            localStorage.setItem('coins', coins);
            coinsText.setText(`Coins: ${coins}`);
        });
        this.shopElements.push(buyCoinsButton);

        // Секция скинов (моки)
        const skin1Button = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 210, 'Normal skin (100 Bananas)', { fontSize: '20px', fill: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(15).setAlpha(0).setScale(0);
        skin1Button.on('pointerdown', () => {
            if (bananas >= 100) {
                bananas -= 100;
                localStorage.setItem('bananas', bananas);
                bananasText.setText(`Bananas: ${bananas}`);
                console.log('Normal skin purchased and applied (mock)');
                // Here you can add the logic to apply the skin in GameScene, but for now it's a mock
            }
        });
        this.shopElements.push(skin1Button);

        const skin2Button = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 240, 'Exclusive skin (500 Bananas)', { fontSize: '20px', fill: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(15).setAlpha(0).setScale(0);
        skin2Button.on('pointerdown', () => {
            if (bananas >= 500) {
                bananas -= 500;
                localStorage.setItem('bananas', bananas);
                bananasText.setText(`Bananas: ${bananas}`);
                console.log('Exclusive skin purchased and applied (mock)');
            }
        });
        this.shopElements.push(skin2Button);

        // Секция бустов
        const rocketButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 280, 'Rocket (50 Bananas)', { fontSize: '20px', fill: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(15).setAlpha(0).setScale(0);
        rocketButton.on('pointerdown', () => {
            if (bananas >= 50) {
                bananas -= 50;
                let rockets = parseInt(localStorage.getItem('rockets')) || 0;
                rockets += 1;
                localStorage.setItem('bananas', bananas);
                localStorage.setItem('rockets', rockets);
                bananasText.setText(`Bananas: ${bananas}`);
            }
        });
        this.shopElements.push(rocketButton);

        const lifeButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - shopHeight / 2 + 310, 'Extra Life (20 Coins, max 3)', { fontSize: '20px', fill: '#FFFFFF' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(15).setAlpha(0).setScale(0);
        lifeButton.on('pointerdown', () => {
            let extraLives = parseInt(localStorage.getItem('extraLives')) || 0;
            if (coins >= 20 && extraLives < 3) {
                coins -= 20;
                extraLives += 1;
                localStorage.setItem('coins', coins);
                localStorage.setItem('extraLives', extraLives);
                coinsText.setText(`Монеты: ${coins}`);
            }
        });
        this.shopElements.push(lifeButton);

        // Кнопка "Назад"
        const backGraphics = this.add.graphics().setDepth(15);
        backGraphics.fillStyle(0xFFFFFF, 1);
        backGraphics.fillRoundedRect(CONSTS.WIDTH / 2 - 60, CONSTS.HEIGHT / 2 + shopHeight / 2 - 60, 120, 50, 10);
        backGraphics.setAlpha(0).setScale(0);
        this.shopElements.push(backGraphics);

        const backText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 + shopHeight / 2 - 35, 'Back', { fontSize: '24px', fill: '#000', fontFamily: 'Arial' }).setOrigin(0.5).setInteractive({ useHandCursor: true }).setDepth(16).setAlpha(0).setScale(0);
        this.shopElements.push(backText);

        backText.on('pointerdown', () => {
            this.hideShop();
        });

        // Анимация появления
        this.tweens.add({
            targets: [shopBg, shadowGraphics, backGraphics],
            scale: { from: 0, to: 1 },
            alpha: { from: 0, to: 1 },
            duration: 800,
            ease: 'Power2'
        });

        this.tweens.add({
            targets: [titleText, bananasText, coinsText, dailyButton, adButton, buyCoinsButton, skin1Button, skin2Button, rocketButton, lifeButton, backText],
            scale: { from: 0, to: 1 },
            alpha: { from: 0, to: 1 },
            duration: 800,
            delay: 400,
            ease: 'Power2'
        });
    }

    // НОВОЕ: Метод для скрытия экрана магазина
    hideShop() {
        this.shopElements.forEach(element => element.destroy());
        this.shopElements = [];
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
        this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 4, '1v1 Online Mode', {
            fontSize: '42px',
            fill: '#FFFFFF',
            fontFamily: 'Arial Black',
            stroke: '#000000',
            strokeThickness: 6
        }).setOrigin(0.5);
        
        // Статус поиска
        this.searchingText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Searching for opponent', {
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
                this.searchingText.setText('Searching for opponent' + this.dots);
            },
            loop: true
        });
        
        // Кнопка отмены
        const cancelButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 100, 'Cancel', {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial',
            backgroundColor: '#FF0000',
            padding: { x: 20, y: 10 }
        }).setOrigin(0.5).setInteractive({ useHandCursor: true });
        
        cancelButton.on('pointerdown', () => {
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
        
        this.socket = io(socketUrl);
        
        this.socket.on('connect', () => {
            console.log('✅ Подключено к серверу Socket.IO:', this.socket.id);
            
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
            this.searchingText.setText(`Game starts in ${seconds}...`);
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('❌ Ошибка подключения:', error);
            this.searchingText.setText('Connection error!\nReturning to menu...');
            
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

// Класс сцены игры (с возвратом в меню при проигрыше)
class GameScene extends Phaser.Scene {
    constructor() {
    super({ key: 'GameScene' });
    this.player = null;
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
    this.rockets = 0;
    this.extraLives = 0;
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
        // ==================== 1V1 MODE INITIALIZATION ====================
        // Проверяем, запускаемся ли в 1v1 режиме
        if (data && data.mode === '1v1') {
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
        
        // НОВОЕ: Загружаем бусты из localStorage перед стартом игры
        this.rockets = parseInt(localStorage.getItem('rockets')) || 0;
        this.extraLives = parseInt(localStorage.getItem('extraLives')) || 0;

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
        this.collider = this.physics.add.collider(this.player, this.platforms, this.handlePlayerPlatformCollision, null, this);
        // ФИКС: Добавляем отдельный коллайдер для земли (она теперь не в группе platforms)
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

        this.player = this.physics.add.sprite(CONSTS.WIDTH / 2, playerY, 'playerSprite'); // ФИКС: Устанавливаем правильный Y на земле
        this.player.setScale(0.7); // ФИКС: Уменьшаем размер спрайта обезьянки до 70%
        this.player.setBounce(0, CONSTS.PLAYER_BOUNCE);
        this.player.setVelocityY(0); // ФИКС: Явно нулевая скорость вниз (гравитация включена по умолчанию)
        
        // ФИКС: Устанавливаем hitbox с правильным offset для центрирования
        const bodyWidth = 62 * 0.7 * 0.8;  // Ширина тела (уменьшена на 20%)
        const bodyHeight = playerHeight * 0.8; // Высота тела (уменьшена на 20%)
        const offsetX = (this.player.displayWidth - bodyWidth) / 2; // Центрируем по X
        const offsetY = (this.player.displayHeight - bodyHeight) / 2; // Центрируем по Y
        this.player.body.setSize(bodyWidth, bodyHeight);
        this.player.body.setOffset(offsetX, offsetY); // КРИТИЧНО: Центрируем тело!
        
        this.player.setOrigin(0.5, 0.5);
        this.player.setDepth(10);
        this.player.setCollideWorldBounds(true); // ФИКС: Включаем коллизию с границами мира
        this.player.body.maxVelocity.set(300, 1200); // ФИКС: Увеличена максимальная скорость падения (было 800)

        // ФИКС: Сразу idle-анимация (игрок стоит на земле)
        this.player.anims.stop();
        this.player.setTexture('playerSprite');

        // НОВОЕ: Запоминаем стартовую позицию игрока для расчета score
        this.playerStartY = playerY;
        this.maxReachedY = playerY; // НОВОЕ: Инициализируем максимальную достигнутую высоту

        console.log('Player Y:', playerY, 'Ground Y:', ground.y, 'Ground Half Height:', groundHalfHeight, 'Player Half Height:', playerHalfHeight);
        
        // ==================== OPPONENT GHOST (1V1 MODE) ====================
        if (this.gameMode === '1v1') {
            this.createOpponentGhost(playerY);
            
            // ВАЖНО: Отправляем начальную позицию сразу же!
            // Это гарантирует что оппонент увидит нас в правильной позиции
            this.sendPlayerUpdate();
            console.log('📤 Отправлена начальная позиция игрока');
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
            // ФИКС: Уменьшаем радиус на 20% чтобы физическое тело было внутри видимой части шарика
            const radius = (platform.displayWidth / 2) * 0.8; // Было 0.5 (половина), стало 0.4
            
            // ФИКС: Центрируем круг относительно спрайта
            const offsetX = (platform.displayWidth - radius * 2) / 4;  // Сдвиг по X для центрирования
            const offsetY = (platform.displayHeight - radius * 2) / 4; // Сдвиг по Y для центрирования
            body.setCircle(radius, offsetX, offsetY);
            
            body.checkCollision.down = false; // Как было: без коллизии снизу (прыжки сквозь?)
            body.checkCollision.left = true;
            body.checkCollision.right = true;
            body.checkCollision.up = true; // Добавляем up для отскока головой (если нужно)
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
            const winText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'Opponent Disconnected!\nYou Win!', {
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
    
    // Обработка окончания 1v1 игры
    handleGameEnd(data) {
        this.gameOver = true;
        
        // Останавливаем физику
        this.physics.pause();
        
        // Показываем результаты
        const resultText = data.winner ? 'You Win!' : 'You Lose!';
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
        const statsText = `Your Score: ${yourScoreRounded}\nOpponent: ${opponentScoreRounded}\n\nReason: ${data.reason}`;
        this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, statsText, {
            fontSize: '28px',
            fill: '#FFFFFF',
            fontFamily: 'Arial',
            align: 'center',
            lineSpacing: 10
        }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
        
        // Кнопка возврата в меню
        const menuButton = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT - 100, 'Return to Menu', {
            fontSize: '32px',
            fill: '#FFFFFF',
            fontFamily: 'Arial',
            backgroundColor: '#0066CC',
            padding: { x: 20, y: 10 }
        }).setOrigin(0.5).setScrollFactor(0).setDepth(201).setInteractive({ useHandCursor: true });
        
        menuButton.on('pointerdown', () => {
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
            
            // ФИКС: Первый шар всегда синий (нелопающийся)
            if (i === 0) {
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
            if (platform.platformType === 'unbreakable') {
                platform.setTexture('balloon_unbreakable');
                platform.setScale(59/30, 110/73);
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
                this.player.setVelocityY(CONSTS.JUMP_VELOCITY);
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
            this.player.setVelocityY(CONSTS.JUMP_VELOCITY);
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
    // НОВОЕ: Обработка падения на землю (touching.down + isGround + groundAppeared)
    if (platformObj.isGround && player.body.touching.down && this.groundAppeared) {
        console.log('💥 GAME OVER: Игрок коснулся земли!');
        // Показываем текстуру падения на землю
        this.player.anims.stop();
        this.player.setTexture('monkey_fall_floor');
        // Останавливаем движение
        player.setVelocity(0);
        this.isFalling = false;
        // Запускаем последовательность game over
        this.handleGameOverOnGround();
        return; // Выходим, чтобы не обрабатывать другие коллизии
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
    player.setVelocityY(CONSTS.JUMP_VELOCITY);
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
        
        // ФИКС: СРАЗУ ставим smash при прыжке (не ждём update())
        if (!platformObj.smashStartTime) {
            console.log('🎯 Автопрыжок! Сразу ставим smash, платформа:', platformObj.texture.key);
            platformObj.setTexture('balloon_smash');
            platformObj.smashStartTime = this.time.now;
        }
        
        player.setVelocityY(CONSTS.JUMP_VELOCITY); // Немедленный прыжок вверх
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
            this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2, 'You Fell!\nWaiting for result...', {
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
        const gameOverText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 140, 'Game Over!', { 
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

        // NEW RECORD (если есть) (поднимаем выше на 40px)
        let newRecordText = null;
        if (isNewRecord) {
            newRecordText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 75, '★ New RECORD! ★', { 
                fontSize: '20px', 
                fill: '#FFD700', 
                fontFamily: 'Arial Black' 
            }).setOrigin(0.5).setScrollFactor(0).setDepth(15);
        }

        // Текущий счёт (поднимаем выше на 40px)
        const currentScoreText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 45, `Score: ${displayScore}`, { 
            fontSize: '28px', 
            fill: '#FFFFFF', 
            fontFamily: 'Arial Black' 
        }).setOrigin(0.5).setScrollFactor(0).setDepth(15);

        // Лучший счёт (поднимаем выше на 40px)
        const bestScoreText = this.add.text(CONSTS.WIDTH / 2, CONSTS.HEIGHT / 2 - 15, `Best: ${displayBest}`, { 
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

        const restartText = this.add.text(CONSTS.WIDTH / 2 - 80, CONSTS.HEIGHT / 2 + 67, 'Restart', { 
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

        const menuText = this.add.text(CONSTS.WIDTH / 2 + 80, CONSTS.HEIGHT / 2 + 67, 'Menu', { 
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
        saveScoreToServer(userData.id, userData.username, this.score)
            .then(serverResult => {
                if (serverResult.success) {
                    serverStatusText.setText('✅ Сохранено!');
                    serverStatusText.setColor('#00FF00');
                    if (serverResult.isNewRecord) {
                        serverStatusText.setText('✅ Новый рекорд!');
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
        const isFalling = !standingPlatform && this.player.body.velocity.y > 0 && !this.rocketActive && !this.isJumping;
        const isRising = !standingPlatform && this.player.body.velocity.y < 0 && !this.rocketActive && !this.isJumping;
        
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
            if (this.player.texture.key !== 'playerSprite') {
                this.player.anims.stop();
                this.player.setTexture('playerSprite');
            }
            this.isJumping = false; // Сбрасываем isJumping на платформе
        }
    }
    this.checkMovement();
    this.checkJump();
    this.updateMovingPlatforms(); // НОВОЕ: Обновляем движущиеся платформы
    this.refactorPlatforms();
    this.checkGameOver();
    // УБРАНО: Логика зацепления за бока (clingPlatform) полностью удалена
    if (Phaser.Input.Keyboard.JustDown(this.rKey) && this.rockets > 0 && !this.rocketActive) {
        this.rocketActive = true;
        this.rockets -= 1;
        localStorage.setItem('rockets', this.rockets);
        this.physics.world.removeCollider(this.collider);
        this.player.body.setAllowGravity(false);
        const rocketSpeed = - (500 * CONSTS.SCORE_HEIGHT_INCREMENT) / (2000 / 1000);
        this.player.setVelocityY(rocketSpeed);
        this.player.anims.stop();
        this.player.setTexture('monkey_up'); // ФИКС: Статичная текстура для ракеты
        this.time.delayedCall(2000, () => {
            this.rocketActive = false;
            this.player.setVelocityY(CONSTS.JUMP_VELOCITY / 2);
            this.player.body.setAllowGravity(true);
            this.collider = this.physics.add.collider(this.player, this.platforms, this.handlePlayerPlatformCollision, null, this);
            const overlappedPlatform = this.platforms.children.entries.find(platform => this.physics.overlap(this.player, platform));
            if (overlappedPlatform) {
                this.player.y = overlappedPlatform.y - (overlappedPlatform.displayHeight / 2) - (this.player.displayHeight / 2) - 1;
                this.player.setVelocityY(0);
            }
            this.refactorPlatforms();
        });
    }
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
    
    // ФИКС: Камера следует за игроком по X с ограничением границ
    const desiredScrollX = this.player.x - (CONSTS.WIDTH / 2);
    const minScrollX = 0; // Не уходить левее начала мира
    const maxScrollX = 0; // Не уходить правее (мир шириной 640px)
    const targetScrollX = Phaser.Math.Clamp(desiredScrollX, minScrollX, maxScrollX);
    
    // ФИКС: ПЛАВНОЕ движение камеры по X (lerp 0.05 вместо 0.1 — более мягко)
    camera.scrollX = Phaser.Math.Linear(camera.scrollX, targetScrollX, 0.05);
    
    // ФИКС: Камера следует за игроком по Y (центрируем по вертикали)
    const desiredScrollY = this.player.y - (CONSTS.HEIGHT / 2);
    const maxScrollY = this.groundBottom - CONSTS.HEIGHT;
    
    // ФИКС: Камера не должна уходить ниже земли (ограничиваем снизу тоже)
    const minScrollY = -Infinity; // Можно уходить вверх бесконечно
    const targetScrollY = Phaser.Math.Clamp(desiredScrollY, minScrollY, maxScrollY);

    // ФИКС: ЕЩЕ БОЛЕЕ ПЛАВНОЕ движение камеры (lerp 0.08 для Y — быстрее следит за прыжком)
    camera.scrollY = Phaser.Math.Linear(camera.scrollY, targetScrollY, 0.08);
    
    // ФИКС: Обновляем счет каждый кадр!
    this.updateScore();
    
    // ФИКС: Сбрасываем флаг прыжка когда обезьяна начинает падать вниз
    if (this.isJumping && this.player.body.velocity.y > 0) {
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
        let anyPlatformMoved = false; // ФИКС: Флаг - двигалась ли хоть одна платформа
        
        this.platforms.children.entries.forEach(platform => {
            // Двигаем только платформы типа 'moving', которые не приземлились
            if (platform.platformType === 'moving' && !platform.isLanded) {
                // Вычисляем новую позицию
                const newX = platform.x + (platform.moveSpeed * platform.moveDirection * (1/60));
                
                // Проверяем границы движения
                const leftBound = platform.initialX - platform.moveRange / 2;
                const rightBound = platform.initialX + platform.moveRange / 2;
                
                if (newX <= leftBound) {
                    // Достигли левой границы - меняем направление
                    platform.x = leftBound;
                    platform.moveDirection = 1; // Меняем на вправо
                    anyPlatformMoved = true;
                } else if (newX >= rightBound) {
                    // Достигли правой границы - меняем направление
                    platform.x = rightBound;
                    platform.moveDirection = -1; // Меняем на влево
                    anyPlatformMoved = true;
                } else {
                    // Продолжаем движение
                    platform.x = newX;
                    anyPlatformMoved = true;
                }
            }
        });
        
        // ФИКС: Обновляем физическое тело ОДИН РАЗ для всех платформ (не в цикле!)
        if (anyPlatformMoved) {
            this.platforms.refresh();
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
            console.log('♻️ Рециклим платформу:', 'текстура:', platform.texture.key);
            
            // ФИКС: Если земля появилась - просто прячем платформы далеко за экраном (не рециклим!)
            if (this.groundAppeared) {
                platform.y = -10000; // Прячем далеко за экраном
                platform.setAlpha(0); // Делаем невидимым
                platform.body.checkCollision.none = true; // Отключаем коллизию
                console.log('🙈 Прячем платформу т.к. земля появилась');
                return; // Пропускаем остальную логику рецикла
            }
            
            // НОВОЕ: Назначаем новый случайный тип платформы
            platform.platformType = this.choosePlatformType();
            
            // НОВОЕ: Устанавливаем текстуру в зависимости от типа
            if (platform.platformType === 'unbreakable') {
                platform.setTexture('balloon_unbreakable');
                platform.setScale(50/30, 100/73);
            } else {
                platform.setTexture('platform'); // normal и moving используют обычную зеленую текстуру
            }
            
            platform.isLanded = false;
            platform.smashStartTime = null;
            platform.deadStartTime = null; // НОВОЕ: Сброс времени смерти
            
            // ФИКС: ВОССТАНАВЛИВАЕМ коллизию при рецикле!
            platform.body.checkCollision.none = false; // Включаем коллизии обратно
            platform.setAlpha(1); // Восстанавливаем полную непрозрачность
            
            platform.x = Phaser.Math.Between(0, CONSTS.WIDTH);
            const randomGap = Phaser.Math.Between(200, 280);
            
            // ФИКС: Если земля появилась - размещаем платформы ВЫШЕ игрока (не используем minPlatformY!)
            if (this.groundAppeared) {
                // Размещаем платформу выше игрока на случайном расстоянии
                platform.y = this.player.y - 800 - Phaser.Math.Between(0, 400); // Выше игрока на 800-1200px
            } else {
                // Обычная логика - используем minPlatformY
                platform.y = this.minPlatformY - randomGap;
            }
            
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
}

// Конфиг Phaser
const config = {
    type: Phaser.WEBGL,
    width: CONSTS.WIDTH,
    height: CONSTS.HEIGHT,
    parent: 'game-container', // Контейнер для canvas
    scale: {
        mode: Phaser.Scale.RESIZE, // RESIZE адаптируется под любой экран
        autoCenter: Phaser.Scale.CENTER_BOTH, // Центрируем
        width: CONSTS.WIDTH,
        height: CONSTS.HEIGHT
    },
    // ФИКС: Настройки рендеринга для четкого изображения
    render: {
        antialias: true, // Включаем сглаживание для плавной картинки
        pixelArt: false, // Не пиксель-арт (для плавных спрайтов)
        roundPixels: false, // ФИКС: ОТКЛЮЧАЕМ округление — причина дерганья!
        powerPreference: 'high-performance' // Максимальная производительность GPU
    },
    physics: {
        default: 'arcade',
        arcade: {
            gravity: { y: CONSTS.GRAVITY },
            debug: CONSTS.DEBUG_PHYSICS
            // ФИКС: Убрали fps и fixedStep для поддержки 120Hz дисплеев
            // Физика теперь адаптируется к частоте дисплея (60/120/144 Hz)
        },
    },
    scene: [MenuScene, MatchmakingScene, GameScene]
};

// Инициализация
const game = new Phaser.Game(config);