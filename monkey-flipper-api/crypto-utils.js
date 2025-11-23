// ==================== CRYPTO UTILITIES ====================
// AES-256-GCM шифрование для безопасного хранения адресов кошельков

const crypto = require('crypto');

// ВАЖНО: В продакшне ключ должен храниться в .env файле!
// Генерируем 32-байтовый ключ (256 бит для AES-256)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);

// Проверяем что ключ правильной длины
if (Buffer.from(ENCRYPTION_KEY).length !== 32) {
    console.error('❌ ENCRYPTION_KEY должен быть 32 байта (256 бит)!');
    process.exit(1);
}

/**
 * Шифрует текст используя AES-256-GCM
 * @param {string} text - Текст для шифрования (например, адрес кошелька)
 * @returns {string} - Зашифрованные данные в формате: iv:authTag:encryptedData (hex)
 */
function encrypt(text) {
    if (!text) return null;
    
    try {
        // Генерируем случайный IV (Initialization Vector) - 16 байт для GCM
        const iv = crypto.randomBytes(16);
        
        // Создаем cipher с AES-256-GCM
        const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
        
        // Шифруем данные
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        // Получаем authentication tag (для проверки целостности)
        const authTag = cipher.getAuthTag();
        
        // Возвращаем: iv:authTag:encryptedData (все в hex)
        return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
        
    } catch (error) {
        console.error('❌ Ошибка шифрования:', error);
        throw new Error('Encryption failed');
    }
}

/**
 * Расшифровывает текст зашифрованный с помощью encrypt()
 * @param {string} encryptedText - Зашифрованный текст в формате: iv:authTag:encryptedData
 * @returns {string} - Расшифрованный текст
 */
function decrypt(encryptedText) {
    if (!encryptedText) return null;
    
    try {
        // Разбираем encryptedText на компоненты
        const parts = encryptedText.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted format');
        }
        
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encrypted = parts[2];
        
        // Создаем decipher
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
        
        // Устанавливаем authentication tag
        decipher.setAuthTag(authTag);
        
        // Расшифровываем
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
        
    } catch (error) {
        console.error('❌ Ошибка расшифровки:', error);
        throw new Error('Decryption failed');
    }
}

/**
 * Создает цифровую подпись для данных
 * @param {Object} data - Данные для подписи
 * @param {string} privateKey - Приватный ключ (PEM формат)
 * @returns {string} - Подпись в base64
 */
function signData(data, privateKey) {
    try {
        const sign = crypto.createSign('SHA256');
        sign.update(JSON.stringify(data));
        sign.end();
        return sign.sign(privateKey, 'base64');
    } catch (error) {
        console.error('❌ Ошибка создания подписи:', error);
        throw new Error('Signing failed');
    }
}

/**
 * Проверяет цифровую подпись
 * @param {Object} data - Данные для проверки
 * @param {string} signature - Подпись в base64
 * @param {string} publicKey - Публичный ключ (PEM формат)
 * @returns {boolean} - true если подпись валидна
 */
function verifySignature(data, signature, publicKey) {
    try {
        const verify = crypto.createVerify('SHA256');
        verify.update(JSON.stringify(data));
        verify.end();
        return verify.verify(publicKey, signature, 'base64');
    } catch (error) {
        console.error('❌ Ошибка проверки подписи:', error);
        return false;
    }
}

/**
 * Генерирует пару ключей RSA для подписей транзакций
 * @returns {Object} - { publicKey, privateKey } в PEM формате
 */
function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem'
        }
    });
    
    return { publicKey, privateKey };
}

/**
 * Создает безопасный хэш для данных (SHA-256)
 * @param {string} data - Данные для хэширования
 * @returns {string} - Хэш в hex формате
 */
function hashData(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
    encrypt,
    decrypt,
    signData,
    verifySignature,
    generateKeyPair,
    hashData
};
