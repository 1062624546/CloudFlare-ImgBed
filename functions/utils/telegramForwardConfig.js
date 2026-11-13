export const forwardConfigKey = botId => `manage@telegramForward@${botId}`;

export function telegramBotId(token) {
    return /^(\d+):[\w-]+$/.exec(token || '')?.[1];
}

export async function telegramTokenDigest(token) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readForwardConfig(db, botId) {
    const value = await db.get(forwardConfigKey(botId));
    return value ? JSON.parse(value) : null;
}
