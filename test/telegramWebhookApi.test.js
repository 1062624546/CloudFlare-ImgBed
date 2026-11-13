import assert from 'node:assert/strict';
import { TelegramAPI } from '../functions/utils/storage/telegramAPI.js';

describe('Telegram webhook API', () => {
    it('queries webhook info with GET and reports Telegram rejection without exposing credentials', async () => {
        const originalFetch = globalThis.fetch;
        const api = new TelegramAPI('123:test-token');
        try {
            globalThis.fetch = async (url, options) => {
                assert.match(url, /\/getWebhookInfo$/);
                assert.equal(options.method, 'GET');
                return Response.json({ ok: true, result: { url: '' } });
            };
            assert.deepEqual(await api.webhook('getWebhookInfo'), { url: '' });
            globalThis.fetch = async () => Response.json({
                ok: false, error_code: 401, description: 'Sensitive upstream details'
            }, { status: 401 });
            await assert.rejects(api.webhook('getWebhookInfo'), {
                message: 'tokenRejected', reason: 'tokenRejected', status: 401
            });
            globalThis.fetch = async () => { throw new Error('URL containing bot token'); };
            await assert.rejects(api.webhook('getWebhookInfo'), { message: 'connectionFailed' });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
