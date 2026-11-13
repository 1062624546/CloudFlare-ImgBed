import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';

describe('Telegram forwarded media', () => {
    it('indexes only permitted forwarded media under a stable directory key', async () => {
        const db = memoryDatabase();
        const { onRequest } = await loadFunction('functions/api/telegram/forward.js', {
            getDatabase: () => db,
            addFileToIndex: async () => ({ success: true }),
            fetchUploadConfig: async () => ({ telegram: { channels: [{ name: 'test' }] } }),
            sanitizeUploadFolder: value => value
        });
        const env = {
            TELEGRAM_FORWARD_SECRET: 'test-secret',
            TELEGRAM_FORWARD_CHAT_ID: '-100123',
            TELEGRAM_FORWARD_USER_ID: '42',
            TELEGRAM_FORWARD_CHANNEL: 'test'
        };
        const message = {
            message_id: 5, chat: { type: 'supergroup', id: -100123 }, from: { id: 42 },
            forward_origin: { type: 'hidden_user' },
            photo: [{ file_id: 'small', file_size: 100 }, { file_id: 'large', file_size: 200 }]
        };
        const send = (update, secret = 'test-secret') => onRequest({
            env, request: new Request('https://test/api/telegram/forward', {
                method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
                body: JSON.stringify({ message: update })
            })
        });
        assert.equal((await send(message, 'incorrect')).status, 403);
        assert.equal((await send({ ...message, from: { id: 10 } })).status, 204);
        assert.equal((await send({ ...message, forward_origin: undefined })).status, 204);
        const big = await send({ ...message, video: { file_id: 'big', file_size: 20_000_001 } });
        assert.equal((await big.json()).reason, 'telegram_download_limit');
        assert.equal(db.records.size, 0);
        assert.equal((await send(message)).status, 204);
        assert.equal((await send(message)).status, 204);
        assert.equal(db.records.size, 1);
        const stored = await db.getWithMetadata('telegram-forwards/tg--100123-5.jpg');
        assert.equal(stored.metadata.TgFileId, 'large');
        assert.equal(stored.metadata.Directory, 'telegram-forwards/');
    });
});
