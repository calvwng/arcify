import { deflateSync } from 'node:zlib';

export function pngIcon({ width = 2, height = 2, red = 30, extra = [] } = {}) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(body.length + 8);
        result.writeUInt32BE(data.length); body.copy(result, 4);
        let crc = 0xffffffff;
        for (const byte of body) {
            crc ^= byte;
            for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
        return result;
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([red, 70, 140, 255], y * (width * 4 + 1) + x * 4 + 1);
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        ...extra.map(([type, data]) => chunk(type, data)), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
    return `data:image/png;base64,${bytes.toString('base64')}`;
}
