// Тест Vercel API функций
// Запуск: node test-vercel-api.js

const path = require('path');

console.log('🧪 Тестирование Vercel API функций\n');

// Имитация запроса и ответа
function createMockRequest(method, body = {}, query = {}) {
    return {
        method,
        body,
        query,
        headers: {
            host: 'localhost:3000'
        },
        url: '/test'
    };
}

function createMockResponse() {
    const res = {
        _status: 200,
        _headers: {},
        _data: null,
        
        setHeader(key, value) {
            this._headers[key] = value;
            return this;
        },
        
        status(code) {
            this._status = code;
            return this;
        },
        
        json(data) {
            this._data = data;
            return this;
        },
        
        end() {
            return this;
        },
        
        redirect(code, url) {
            this._status = code;
            this._data = { redirect: url };
            return this;
        }
    };
    
    return res;
}

async function testSaveScore() {
    console.log('📝 Тест 1: Сохранение счета (POST /api/save-score)');
    
    try {
        // Импортируем функцию
        const handler = require('./api/save-score.js').default;
        
        const req = createMockRequest('POST', {
            userId: 'test123',
            score: 150,
            username: 'TestPlayer'
        });
        
        const res = createMockResponse();
        
        await handler(req, res);
        
        if (res._status === 200 && res._data && res._data.success) {
            console.log('✅ УСПЕХ: Счет сохранен');
            console.log('   Ответ:', res._data);
        } else {
            console.log('❌ ОШИБКА:', res._data);
        }
    } catch (err) {
        console.log('❌ ОШИБКА:', err.message);
    }
    
    console.log('');
}

async function testGetLeaderboard() {
    console.log('📊 Тест 2: Получение лидерборда (GET /api/save-score)');
    
    try {
        const handler = require('./api/save-score.js').default;
        
        const req = createMockRequest('GET', {}, { limit: '10' });
        const res = createMockResponse();
        
        await handler(req, res);
        
        if (res._status === 200 && res._data && res._data.success) {
            console.log('✅ УСПЕХ: Лидерборд получен');
            console.log('   Записей:', res._data.count);
            console.log('   Первые 3:', res._data.leaderboard.slice(0, 3));
        } else {
            console.log('❌ ОШИБКА:', res._data);
        }
    } catch (err) {
        console.log('❌ ОШИБКА:', err.message);
    }
    
    console.log('');
}

async function testLeaderboardRedirect() {
    console.log('🔄 Тест 3: Редирект с /api/leaderboard');
    
    try {
        const handler = require('./api/leaderboard.js').default;
        
        const req = createMockRequest('GET', {}, { limit: '5' });
        const res = createMockResponse();
        
        await handler(req, res);
        
        if (res._status === 307 && res._data && res._data.redirect) {
            console.log('✅ УСПЕХ: Редирект работает');
            console.log('   URL:', res._data.redirect);
        } else {
            console.log('❌ ОШИБКА: Редирект не сработал');
        }
    } catch (err) {
        console.log('❌ ОШИБКА:', err.message);
    }
    
    console.log('');
}

async function runTests() {
    console.log('═══════════════════════════════════════════\n');
    
    await testSaveScore();
    await testGetLeaderboard();
    await testLeaderboardRedirect();
    
    console.log('═══════════════════════════════════════════');
    console.log('\n✅ Все тесты завершены!');
    console.log('\n📌 Для деплоя на Vercel запустите:');
    console.log('   vercel --prod\n');
}

runTests();
