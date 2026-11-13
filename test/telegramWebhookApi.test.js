import assert from 'node:assert/strict';
import { TelegramAPI } from '../functions/utils/storage/telegramAPI.js';

describe('Telegram webhook API', () => {
    it('omits the body for status queries and reports Telegram rejection without exposing credentials', async () => {
        const originalFetch = globalThis.fetch;
        const api = new TelegramAPI('123:test-token');
        try {
            globalThis.fetch = async (url, options) => {
                assert.match(url, /\/getWebhookInfo$/);
                assert.equal(options.method, 'GET');
                assert.equal(options.body, undefined);
                assert.ok(options.headers['User-Agent']);
                assert.equal(options.redirect, 'manual');
                return Response.json({ ok: true, result: { url: '' } });
            };
            assert.deepEqual(await api.webhook('getWebhookInfo'), { url: '' });
            globalThis.fetch = async (url, options) => {
                assert.match(url, /\/setWebhook$/);
                assert.equal(options.method, 'POST');
                assert.equal(options.body.get('allowed_updates'), '["message"]');
                return Response.json({ ok: true, result: true });
            };
            assert.equal(await api.webhook('setWebhook', { allowed_updates: ['message'] }), true);
            globalThis.fetch = async () => new Response(null, { status: 302 });
            await assert.rejects(api.webhook('getWebhookInfo'), {
                message: 'unexpectedRedirect', status: 302
            });
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
