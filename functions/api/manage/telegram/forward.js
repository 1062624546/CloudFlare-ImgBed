import { getDatabase } from '../../../utils/databaseAdapter.js';
import { forwardConfigKey, readForwardConfig, telegramBotId, telegramTokenDigest } from '../../../utils/telegramForwardConfig.js';
import { TelegramAPI } from '../../../utils/storage/telegramAPI.js';
import { getUploadConfig } from '../sysConfig/upload.js';

export async function onRequest({ request, env }) {
    const { method } = request;
    if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405 });

    const url = new URL(request.url);
    if (method === 'POST' && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) {
        return new Response(null, { status: 403 });
    }

    const db = getDatabase(env);
    const settings = await getUploadConfig(db, env);
    const channel = settings.telegram.channels.find(item => item.name === url.searchParams.get('channel'));
    const botId = telegramBotId(channel?.botToken);
    if (!channel || !botId || !/^-\d+$/.test(String(channel.chatId))) {
        return Response.json({ error: 'invalidChannel' }, { status: 400 });
    }

    const key = forwardConfigKey(botId);
    const config = await readForwardConfig(db, botId);
    const chatId = String(channel.chatId);
    const tokenDigest = await telegramTokenDigest(channel.botToken);
    const owned = config?.channelName === channel.name && config?.tokenDigest === tokenDigest;
    const callback = new URL('/api/telegram/forward', url);
    callback.searchParams.set('bot', botId);
    const api = new TelegramAPI(channel.botToken, channel.proxyUrl);

    let enabled;
    if (method === 'POST') {
        const body = await request.json().catch(() => null);
        enabled = body?.enabled;
        if (typeof enabled !== 'boolean') return new Response(null, { status: 400 });
        if (enabled && (!channel.enabled || callback.protocol !== 'https:')) {
            return Response.json({ error: 'invalidChannel' }, { status: 400 });
        }
    }

    let webhook;
    try {
        webhook = await api.webhook('getWebhookInfo');
    } catch {
        return Response.json({ error: 'telegramUnavailable' }, { status: 502 });
    }
    const active = Boolean(owned && webhook.url === config.url);
    const conflict = Boolean(webhook.url && !active);
    if (method === 'GET') {
        return Response.json({
            enabled: active && channel.enabled && config.chatId === chatId,
            conflict,
            deliveryError: active && Boolean(webhook.last_error_message)
        });
    }
    if (conflict) return Response.json({ error: 'webhookConflict' }, { status: 409 });

    try {
        if (enabled) {
            const secret = owned ? config.secret : crypto.randomUUID().replaceAll('-', '');
            const next = { secret, channelName: channel.name, chatId, tokenDigest, url: callback.href };
            // Persist the secret first so Telegram can deliver immediately after registration.
            await db.put(key, JSON.stringify(next));
            try {
                await api.webhook('setWebhook', { url: next.url, secret_token: secret, allowed_updates: ['message'] });
            } catch {
                // A lost response may still mean Telegram registered the webhook. Keep the
                // record so the next status check can reconcile the result.
                return Response.json({ error: 'telegramUnavailable' }, { status: 502 });
            }
        } else if (owned) {
            if (active) await api.webhook('deleteWebhook');
            await db.delete(key);
        }
    } catch {
        return Response.json({ error: 'updateFailed' }, { status: 502 });
    }
    return Response.json({ enabled });
}
