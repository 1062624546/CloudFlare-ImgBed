import { getDatabase } from '../../utils/databaseAdapter.js';
import { addFileToIndex } from '../../utils/indexManager.js';
import { resolveFileExt, resolveFileType } from '../../utils/mimeTypes.js';
import { fetchUploadConfig } from '../../utils/sysConfig.js';
import { sanitizeUploadFolder } from '../../upload/uploadTools.js';

const MAX_DOWNLOAD_SIZE = 20_000_000;

function matchesSecret(expected, actual) {
    if (!actual || expected.length !== actual.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index++) {
        difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
    }
    return difference === 0;
}

export async function onRequest(context) {
    const { env, request } = context;
    const secret = env.TELEGRAM_FORWARD_SECRET;
    const chatId = env.TELEGRAM_FORWARD_CHAT_ID;
    const channelName = env.TELEGRAM_FORWARD_CHANNEL;
    if (!secret || !/^-\d+$/.test(chatId || '') || !channelName) return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!matchesSecret(secret, request.headers.get('X-Telegram-Bot-Api-Secret-Token'))) {
        return new Response(null, { status: 403 });
    }

    let message;
    try {
        ({ message } = await request.json());
    } catch {
        return new Response(null, { status: 400 });
    }
    if (!message?.forward_origin || String(message.chat?.id) !== String(chatId) ||
        !['group', 'supergroup'].includes(message.chat.type) ||
        (env.TELEGRAM_FORWARD_USER_ID && String(message.from?.id) !== String(env.TELEGRAM_FORWARD_USER_ID))) {
        return new Response(null, { status: 204 });
    }

    const photo = message.photo?.at(-1);
    const video = message.video;
    const document = message.document;
    const documentType = resolveFileType(document?.file_name, document?.mime_type);
    const media = video || photo || (/^(image|video)\//.test(documentType) ? document : null);
    if (!media?.file_id || !Number.isSafeInteger(message.message_id)) {
        return new Response(null, { status: 204 });
    }
    if (media.file_size > MAX_DOWNLOAD_SIZE) {
        return Response.json({ imported: false, reason: 'telegram_download_limit' });
    }

    const config = await fetchUploadConfig(env, context);
    if (!config.telegram?.channels?.some(channel => channel.name === channelName)) {
        return new Response('Telegram channel unavailable', { status: 503 });
    }

    const directory = sanitizeUploadFolder(env.TELEGRAM_FORWARD_FOLDER || 'telegram-forwards');
    const fallbackType = media === photo ? 'image/jpeg' : media === video ? 'video/mp4' : documentType;
    const type = resolveFileType(media.file_name, media.mime_type || fallbackType);
    const inferredExtension = media === photo ? 'jpg' : resolveFileExt(media.file_name || '', type);
    const extension = /^[a-z0-9]+$/i.test(inferredExtension) ? inferredExtension : 'bin';
    const fileName = media.file_name || `telegram-${message.message_id}.${extension}`;
    const fileId = [directory, `tg-${chatId}-${message.message_id}.${extension}`].filter(Boolean).join('/');
    const db = getDatabase(env);
    const existing = await db.getWithMetadata(fileId);

    const size = media.file_size || 0;
    const metadata = existing?.metadata?.TgFileId ? existing.metadata : {
        FileName: fileName, FileType: type, FileSize: (size / 1024 / 1024).toFixed(2), FileSizeBytes: size,
        Directory: directory ? directory + '/' : '', TimeStamp: message.date * 1000 || Date.now(),
        ListType: 'None', Label: 'None', Tags: [],
        Channel: 'TelegramNew', ChannelName: channelName, TgFileId: media.file_id
    };
    if (!existing?.metadata?.TgFileId) await db.put(fileId, '', { metadata });
    const indexed = await addFileToIndex(context, fileId, metadata);
    if (!indexed.success) return new Response('Unable to index Telegram file', { status: 503 });
    return new Response(null, { status: 204 });
}
