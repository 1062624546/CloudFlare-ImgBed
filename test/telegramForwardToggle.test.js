import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import * as helpers from '../functions/utils/telegramForwardConfig.js';

describe('Telegram forward toggle', () => {
    it('reuses saved credentials, protects foreign webhooks and supports disabling', async () => {
        const db = memoryDatabase();
        const channel = { name: '盘', enabled: true, chatId: '-100123', botToken: '123:example' };
        let url = 'https://other.example/hook';
        let secret;
        const { onRequest } = await loadFunction('functions/api/manage/telegram/forward.js', {
            ...helpers,
            getDatabase: () => db,
            getUploadConfig: async () => ({ telegram: { channels: [channel] } }),
            TelegramAPI: class {
                async webhook(method, parameters) {
                    if (method === 'getWebhookInfo') return { url };
                    if (method === 'setWebhook') {
                        url = parameters.url;
                        secret = parameters.secret_token;
                        assert.deepEqual(parameters.allowed_updates, ['message']);
                    }
                    if (method === 'deleteWebhook') url = '';
                }
            }
        });
        const call = (enabled) => onRequest({
            env: {},
            request: new Request('https://img.example/api/manage/telegram/forward?channel=' + encodeURIComponent(channel.name),
                enabled === undefined ? {} : {
                    method: 'POST', headers: { Origin: 'https://img.example' }, body: JSON.stringify({ enabled })
                })
        });

        assert.equal((await call(true)).status, 409);
        assert.equal(url, 'https://other.example/hook');
        url = '';
        assert.deepEqual(await (await call(true)).json(), { enabled: true });
        assert.equal(url, 'https://img.example/api/telegram/forward?bot=123');
        assert.match(secret, /^[a-f0-9]{32}$/);
        const status = await (await call()).json();
        assert.deepEqual(status, { enabled: true, conflict: false, deliveryError: false });
        assert.deepEqual(await (await call(false)).json(), { enabled: false });
        assert.equal(url, '');
        assert.equal(db.records.size, 0);
    });
});
