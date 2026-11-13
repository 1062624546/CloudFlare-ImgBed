import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';

describe('Telegram resumable upload', () => {
    it('keeps confirmed chunks after a failure and finalizes a single stable file', async () => {
        const db = memoryDatabase();
        const list = db.list.bind(db);
        db.list = async ({ prefix, cursor }) => {
            const { keys } = await list({ prefix });
            const page = keys.filter(key => !cursor || key.name > cursor);
            return { keys: page.slice(0, 1), list_complete: page.length <= 1, cursor: page[0]?.name };
        };
        const chunkSize = 16 * 1024 * 1024;
        const fingerprint = 'a'.repeat(64);
        let fail = false;
        let sends = 0;
        let indexed = 0;
        const { handleTelegramResume } = await loadFunction('functions/upload/telegramResume.js', {
            getDatabase: () => db,
            fetchPageConfig: async () => ({}),
            TelegramAPI: class {
                async sendFile(blob) {
                    sends++;
                    return fail ? { ok: false, parameters: { retry_after: 2 } } :
                        { ok: true, file_id: String(sends), file_size: blob.size };
                }
                getFileInfo(response) { return response; }
            },
            buildUniqueFileId: async () => 'media/clip.mp4',
            checkUploadFormat: () => null,
            createResponse: (body, init) => new Response(body, init),
            createUploadResponse: (_, result) => Response.json(result),
            endUpload: () => { indexed++; },
            getIPAddress: async () => '',
            getUploadIp: () => '127.0.0.1',
            sanitizeUploadFolder: () => 'media',
            selectConsistentChannel: channels => channels[0]
        });
        const call = (action, body, query = '') => {
            const url = new URL('https://test/upload?' + query);
            return handleTelegramResume({
                env: {}, url,
                request: new Request(url, { method: action === 'status' ? 'GET' : 'POST', body }),
                uploadConfig: { telegram: { channels: [{ name: 'test' }] } },
                waitUntil() {}
            }, action);
        };
        const form = new FormData();
        form.set('originalFileName', 'clip.mp4');
        form.set('size', String(chunkSize + 1));
        form.set('fingerprint', fingerprint);
        const init = await (await call('init', form)).json();
        assert.equal(init.totalChunks, 2);
        const query = 'uploadId=' + init.uploadId;
        assert.equal((await call('part', new Uint8Array(chunkSize), query + '&index=0')).status, 200);

        fail = true;
        const retry = await call('part', new Uint8Array(1), query + '&index=1');
        assert.equal(retry.status, 429);
        assert.equal(retry.headers.get('Retry-After'), '2');
        const status = await (await call('status', undefined, query)).json();
        assert.equal(status.fingerprint, fingerprint);
        assert.deepEqual(status.completed, [0]);
        assert.equal((await call('complete', undefined, query)).status, 409);
        assert.equal((await call('part', new Uint8Array(1), query + '&index=0')).status, 200);
        assert.equal(sends, 2);

        fail = false;
        assert.equal((await call('part', new Uint8Array(1), query + '&index=1')).status, 200);
        const large = new FormData();
        large.set('originalFileName', 'large.mp4');
        large.set('size', String(5 * 1024 ** 3));
        large.set('fingerprint', fingerprint);
        const largeInit = await call('init', large);
        assert.equal(largeInit.status, 200);
        assert.equal((await largeInit.json()).totalChunks, 320);

        const completed = await (await call('complete', undefined, query)).json();
        assert.deepEqual(completed, [{ src: '/file/media/clip.mp4' }]);
        assert.deepEqual(await (await call('complete', undefined, query)).json(), completed);
        assert.equal(indexed, 1);
        const file = await db.getWithMetadata('media/clip.mp4');
        assert.equal(file.metadata.FileSizeBytes, chunkSize + 1);
        assert.deepEqual(JSON.parse(file.value).map(part => part.index), [0, 1]);
    });
});
