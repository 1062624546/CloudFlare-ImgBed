import { getDatabase } from '../utils/databaseAdapter.js';
import { resolveFileType } from '../utils/mimeTypes.js';
import { fetchPageConfig } from '../utils/sysConfig.js';
import { TelegramAPI } from '../utils/storage/telegramAPI.js';
import {
    buildUniqueFileId, checkUploadFormat, createResponse, createUploadResponse, endUpload,
    getIPAddress, getUploadIp, sanitizeUploadFolder, selectConsistentChannel
} from './uploadTools.js';

const CHUNK_SIZE = 16 * 1024 * 1024;
const TTL = 72 * 60 * 60;
const KEY_PREFIX = 'manage@telegramResume@';
const ID_PATTERN = /^[a-f0-9]{64}$/;

function json(body, status = 200, headers = {}) {
    return createResponse(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
    });
}

export async function handleTelegramResume(context, action) {
    const { request, env, url, uploadConfig } = context;
    const db = getDatabase(env);
    if (!['init', 'status', 'part', 'complete'].includes(action)) {
        return json({ error: 'Unknown Telegram upload action' }, 400);
    }
    if (request.method !== (action === 'status' ? 'GET' : 'POST')) {
        return json({ error: 'Invalid request method' }, 405);
    }

    let stage = action;
    try {
        if (action === 'init') {
            const form = await request.formData();
            const fileName = form.get('originalFileName');
            const size = Number(form.get('size'));
            const fingerprint = form.get('fingerprint');
            if (typeof fileName !== 'string' || !fileName || fileName.length > 255 ||
                !Number.isSafeInteger(size) || size < 1 || typeof fingerprint !== 'string' || !ID_PATTERN.test(fingerprint)) {
                return json({ error: 'Invalid filename, size or SHA-256 fingerprint' }, 400);
            }
            const limit = uploadConfig.telegramMaxFileMiB ?? 0;
            if (limit && size > limit * 1024 * 1024) {
                return json({ error: 'Telegram file too large', telegramMaxFileMiB: limit }, 413);
            }
            const formatError = checkUploadFormat(fileName, uploadConfig);
            if (formatError) return formatError;

            const uploadId = Array.from(crypto.getRandomValues(new Uint8Array(32)),
                byte => byte.toString(16).padStart(2, '0')).join('');
            const channels = uploadConfig.telegram?.channels || [];
            const requestedChannel = url.searchParams.get('channelName');
            const channel = requestedChannel ? channels.find(item => item.name === requestedChannel) :
                selectConsistentChannel(channels, uploadId, uploadConfig.telegram?.loadBalance?.enabled);
            if (!channel) return json({ error: 'Telegram channel is unavailable' }, 409);

            const fileType = resolveFileType(fileName, form.get('originalFileType'));
            const uploadIp = getUploadIp(request);
            const session = {
                fileName, fileType, size, fingerprint,
                totalChunks: Math.ceil(size / CHUNK_SIZE),
                finalFileId: await buildUniqueFileId(context, fileName, fileType, uploadId.slice(0, 24)),
                channelName: channel.name,
                directory: sanitizeUploadFolder(url.searchParams.get('uploadFolder') || ''),
                uploadIp,
                uploadAddress: await getIPAddress(env, uploadIp, context.securityConfig),
                fileExpiresAt: context.fileExpiresAt,
                createdAt: Date.now(),
                expiresAt: Date.now() + TTL * 1000
            };
            await db.put(KEY_PREFIX + uploadId, JSON.stringify(session), { expirationTtl: TTL });
            return json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks: session.totalChunks, expiresAt: session.expiresAt });
        }

        const uploadId = url.searchParams.get('uploadId');
        if (!uploadId || !ID_PATTERN.test(uploadId)) return json({ error: 'Invalid upload ID' }, 400);
        const key = KEY_PREFIX + uploadId;
        const raw = await db.get(key);
        const session = raw && JSON.parse(raw);
        if (!session || session.expiresAt <= Date.now()) {
            return json({ error: 'Upload session expired or unavailable' }, 410);
        }

        const existing = await db.getWithMetadata(session.finalFileId);
        const finalized = existing?.metadata?.UploadSessionId === uploadId;
        if (action === 'part') {
            const rawIndex = url.searchParams.get('index');
            const index = Number(rawIndex);
            if (rawIndex === null || !Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
                return json({ error: 'Invalid chunk index' }, 400);
            }

            const partKey = key + '@' + index;
            if (finalized || await db.get(partKey)) return json({ index });

            const channel = uploadConfig.telegram?.channels?.find(item => item.name === session.channelName);
            if (!channel) return json({ error: 'Telegram channel is unavailable' }, 409);
            const expectedSize = Math.min(CHUNK_SIZE, session.size - index * CHUNK_SIZE);
            const length = Number(request.headers.get('Content-Length'));
            if (length && length !== expectedSize) return json({ error: 'Invalid chunk size' }, 400);
            stage = 'readChunk';
            if (!request.body) return json({ error: 'Missing chunk body' }, 400);
            let chunk;
            if (length === expectedSize) {
                chunk = await request.blob();
            } else {
                const reader = request.body.getReader();
                const pieces = [];
                let size = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > expectedSize) {
                        await reader.cancel();
                        return json({ error: 'Invalid chunk size' }, 400);
                    }
                    pieces.push(value);
                }
                chunk = new Blob(pieces);
            }
            if (chunk.size !== expectedSize) return json({ error: 'Invalid chunk size' }, 400);

            const fileName = session.fileName + '.part' + String(index).padStart(3, '0');
            const api = new TelegramAPI(channel.botToken, channel.proxyUrl);
            stage = 'sendDocument';
            const response = await api.sendFile(chunk, channel.chatId, 'sendDocument', 'document',
                `Part ${index + 1}/${session.totalChunks}`, fileName, { signal: AbortSignal.timeout(120000) });
            if (!response.ok) {
                const retryAfter = response.parameters?.retry_after;
                return json({ error: 'Telegram rejected the chunk' }, retryAfter ? 429 : 502,
                    retryAfter ? { 'Retry-After': String(retryAfter) } : {});
            }
            const part = api.getFileInfo(response);
            if (!part?.file_id || part.file_size !== expectedSize) {
                return json({ error: 'Telegram returned an invalid chunk' }, 502);
            }
            const record = { index, fileId: part.file_id, size: expectedSize };
            stage = 'saveChunk';
            await db.put(partKey, JSON.stringify(record), { expirationTtl: TTL, metadata: record });
            return json({ index });
        }

        const parts = finalized ? JSON.parse(existing.value) : await listParts(db, key);
        if (action === 'status') {
            return json({
                fingerprint: session.fingerprint, chunkSize: CHUNK_SIZE, totalChunks: session.totalChunks,
                completed: parts.map(part => part.index), finalized, expiresAt: session.expiresAt
            });
        }

        if (!finalized) {
            if (parts.length !== session.totalChunks) {
                return json({ error: 'Missing chunks', completed: parts.map(part => part.index) }, 409);
            }
            const formatError = checkUploadFormat(session.fileName, uploadConfig);
            if (formatError) return formatError;
            const metadata = {
                FileName: session.fileName, FileType: session.fileType,
                FileSize: (session.size / 1024 / 1024).toFixed(2), FileSizeBytes: session.size,
                UploadIP: session.uploadIp, UploadAddress: session.uploadAddress,
                ListType: 'None', Label: 'None', TimeStamp: session.createdAt, Tags: [],
                Directory: session.directory ? session.directory + '/' : '',
                Channel: 'TelegramNew', ChannelName: session.channelName,
                IsChunked: true, TotalChunks: session.totalChunks, UploadSessionId: uploadId
            };
            if (session.fileExpiresAt) metadata.ExpiresAt = session.fileExpiresAt;
            const manifest = parts.map(part => ({
                ...part, fileName: session.fileName + '.part' + String(part.index).padStart(3, '0')
            }));
            await db.put(session.finalFileId, JSON.stringify(manifest), { metadata });
            context.waitUntil(endUpload(context, session.finalFileId, metadata));
        }

        const src = '/file/' + session.finalFileId;
        const result = { src: url.searchParams.get('returnFormat') === 'full' ? url.origin + src : src };
        const pageConfig = await fetchPageConfig(env);
        const prefix = pageConfig.config?.find(item => item.id === 'urlPrefix')?.value;
        if (prefix) result.publicUrl = prefix.replace(/\/+$/, '') + '/' + session.finalFileId;
        if (session.fileExpiresAt) result.expiresAt = session.fileExpiresAt;
        return createUploadResponse(context, [result]);
    } catch (error) {
        console.warn('Telegram resumable upload failed:', error.name);
        const reason = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'requestFailed';
        return json({ error: 'Telegram upload request failed. The session can be retried.', stage, reason }, 502);
    }
}

async function listParts(db, key) {
    const parts = [];
    let cursor;
    do {
        const page = await db.list({ prefix: key + '@', cursor });
        for (const record of page.keys) {
            parts.push(record.value ? JSON.parse(record.value) : record.metadata);
        }
        cursor = page.list_complete === false ? page.cursor : undefined;
    } while (cursor);
    return parts.sort((a, b) => a.index - b.index);
}
