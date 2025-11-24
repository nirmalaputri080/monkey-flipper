#!/usr/bin/env node

/**
 * Скрипт для генерации ключей шифрования и подписей
 * Использование: node generate-keys.js
 */

const cryptoUtils = require('./crypto-utils');
const crypto = require('crypto');

console.log('🔐 Генерация ключей безопасности для STARS интеграции\n');
console.log('=' .repeat(70));

// 1. Генерация AES-256 ключа шифрования
console.log('\n📦 1. AES-256 Ключ шифрования (для ENCRYPTION_KEY):');
console.log('-'.repeat(70));
const encryptionKey = crypto.randomBytes(32).toString('hex');
console.log(encryptionKey);
console.log('\nДобавьте в .env файл:');
console.log(`ENCRYPTION_KEY=${encryptionKey}`);

// 2. Генерация JWT Secret
console.log('\n\n🔑 2. JWT Secret (для JWT_SECRET):');
console.log('-'.repeat(70));
const jwtSecret = crypto.randomBytes(64).toString('hex');
console.log(jwtSecret);
console.log('\nДобавьте в .env файл:');
console.log(`JWT_SECRET=${jwtSecret}`);

// 3. Генерация RSA ключей для клиентских подписей
console.log('\n\n🔐 3. RSA Ключи для клиентских подписей (CLIENT):');
console.log('-'.repeat(70));
const clientKeys = cryptoUtils.generateKeyPair();
console.log('CLIENT_PRIVATE_KEY (храните на клиенте в безопасности):');
console.log(clientKeys.privateKey.replace(/\n/g, '\\n'));
console.log('\nCLIENT_PUBLIC_KEY (для server-api.js):');
console.log(clientKeys.publicKey.replace(/\n/g, '\\n'));
console.log('\nДобавьте в .env файл:');
console.log(`CLIENT_PUBLIC_KEY="${clientKeys.publicKey.replace(/\n/g, '\\n')}"`);

// 4. Генерация RSA ключей для серверных подписей
console.log('\n\n🔐 4. RSA Ключи для серверных подписей (SERVER):');
console.log('-'.repeat(70));
const serverKeys = cryptoUtils.generateKeyPair();
console.log('SERVER_PRIVATE_KEY (держите в секрете!):');
console.log(serverKeys.privateKey.replace(/\n/g, '\\n'));
console.log('\nSERVER_PUBLIC_KEY (можно передать клиенту для проверки):');
console.log(serverKeys.publicKey.replace(/\n/g, '\\n'));
console.log('\nДобавьте в .env файл:');
console.log(`SERVER_PRIVATE_KEY="${serverKeys.privateKey.replace(/\n/g, '\\n')}"`);
console.log(`SERVER_PUBLIC_KEY="${serverKeys.publicKey.replace(/\n/g, '\\n')}"`);

// 5. Пример полного .env файла
console.log('\n\n📄 5. Полный .env файл (пример):');
console.log('=' .repeat(70));
console.log(`# Database
DATABASE_URL=postgresql://user:password@host:5432/dbname

# JWT
JWT_SECRET=${jwtSecret}

# Telegram
BOT_TOKEN=your-telegram-bot-token

# Encryption (AES-256)
ENCRYPTION_KEY=${encryptionKey}

# Signature Keys (RSA)
CLIENT_PUBLIC_KEY="${clientKeys.publicKey.replace(/\n/g, '\\n')}"
SERVER_PRIVATE_KEY="${serverKeys.privateKey.replace(/\n/g, '\\n')}"
SERVER_PUBLIC_KEY="${serverKeys.publicKey.replace(/\n/g, '\\n')}"

# CORS
FRONTEND_URL=https://your-domain.com

# Server
PORT=3001
`);

console.log('\n✅ Ключи успешно сгенерированы!');
console.log('⚠️  ВАЖНО: Храните приватные ключи в секрете!');
console.log('⚠️  Не коммитьте .env файл в Git!');
console.log('\n');

// 6. Тест шифрования
console.log('🧪 Тест AES-256 шифрования:');
console.log('-'.repeat(70));
const testAddress = 'STARSxxx1234567890abcdefg';
console.log(`Исходный адрес: ${testAddress}`);

// Временно устанавливаем ключ
process.env.ENCRYPTION_KEY = encryptionKey;
const encrypted = cryptoUtils.encrypt(testAddress);
console.log(`Зашифрованный: ${encrypted}`);

const decrypted = cryptoUtils.decrypt(encrypted);
console.log(`Расшифрованный: ${decrypted}`);
console.log(`Тест ${testAddress === decrypted ? '✅ PASSED' : '❌ FAILED'}`);

// 7. Тест подписей
console.log('\n🧪 Тест RSA подписей:');
console.log('-'.repeat(70));
const testData = { userId: '12345', amount: 100, currency: 'stars' };
console.log(`Данные для подписи: ${JSON.stringify(testData)}`);

const signature = cryptoUtils.signData(testData, serverKeys.privateKey);
console.log(`Подпись (base64): ${signature.substring(0, 50)}...`);

const isValid = cryptoUtils.verifySignature(testData, signature, serverKeys.publicKey);
console.log(`Проверка подписи: ${isValid ? '✅ VALID' : '❌ INVALID'}`);

const isInvalid = cryptoUtils.verifySignature({ ...testData, amount: 999 }, signature, serverKeys.publicKey);
console.log(`Проверка подделки: ${!isInvalid ? '✅ DETECTED' : '❌ MISSED'}`);

console.log('\n✅ Все тесты пройдены!');
console.log('🚀 Готово к использованию!\n');
