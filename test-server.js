// Быстрый тест подключения к продакшн серверу
const io = require('socket.io-client');

const SERVER_URL = 'https://monkey-flipper.onrender.com';

console.log('🔗 Подключение к серверу:', SERVER_URL);

const socket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnection: false
});

socket.on('connect', () => {
    console.log('✅ ПОДКЛЮЧЕНО! Socket ID:', socket.id);
    
    // Тестируем поиск матча
    console.log('🔍 Отправляю findMatch...');
    socket.emit('findMatch', {
        userId: 'test_user_' + Date.now(),
        username: 'Test Player'
    });
});

socket.on('searching', () => {
    console.log('🔍 Сервер ответил: searching');
    console.log('✅ ВСЁ РАБОТАЕТ!');
    
    setTimeout(() => {
        console.log('\n📊 ИТОГ: Сервер полностью работоспособен');
        socket.disconnect();
        process.exit(0);
    }, 1000);
});

socket.on('connect_error', (err) => {
    console.error('❌ ОШИБКА подключения:', err.message);
    process.exit(1);
});

socket.on('error', (err) => {
    console.error('❌ ОШИБКА Socket.IO:', err);
    process.exit(1);
});

// Таймаут на случай зависания
setTimeout(() => {
    console.error('⏱️ ТАЙМАУТ: Сервер не ответил за 10 секунд');
    process.exit(1);
}, 10000);
