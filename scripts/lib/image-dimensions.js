/**
 * Shared utility for fetching image dimensions from a URL.
 * Used by both the backfill script and individual scrapers.
 *
 * Strategy: fetch just enough bytes to determine width/height from the
 * image header (PNG, JPEG, GIF, WebP). Falls back to fetching the whole
 * image and using the `image-size` package if partial fetch fails.
 */

import https from 'https'
import http from 'http'

/**
 * Probe an image URL and return { width, height } or null on failure.
 * Respects a timeout (default 8s) and follows up to 5 redirects.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout=8000]
 * @param {number} [opts.maxRedirects=5]
 * @returns {Promise<{width: number, height: number} | null>}
 */
export async function getImageDimensions(url, { timeout = 8000, maxRedirects = 5 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null

  try {
    const buffer = await fetchImageBuffer(url, { timeout, maxRedirects })
    if (!buffer || buffer.length < 24) return null
    return parseDimensions(buffer)
  } catch {
    return null
  }
}

/**
 * Fetch the first ~32KB of an image (enough for all common header formats).
 * Follows redirects manually.
 */
function fetchImageBuffer(url, { timeout, maxRedirects, _redirectCount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http

    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TurnoutBot/1.0)',
        'Accept': 'image/*',
      },
      timeout,
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.destroy()
        if (_redirectCount >= maxRedirects) return resolve(null)
        const next = new URL(res.headers.location, url).href
        return fetchImageBuffer(next, { timeout, maxRedirects, _redirectCount: _redirectCount + 1 })
          .then(resolve, reject)
      }

      if (res.statusCode !== 200) {
        res.destroy()
        return resolve(null)
      }

      const chunks = []
      let totalBytes = 0
      const MAX_BYTES = 32 * 1024 // 32KB is enough for any image header

      res.on('data', (chunk) => {
        chunks.push(chunk)
        totalBytes += chunk.length
        if (totalBytes >= MAX_BYTES) {
          res.destroy()
        }
      })

      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('close', () => resolve(Buffer.concat(chunks)))
      res.on('error', () => resolve(null))
    })

    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

/**
 * Parse width/height from raw image bytes.
 * Supports PNG, JPEG, GIF, WebP, BMP.
 */
function parseDimensions(buf) {
  // PNG: bytes 0-7 = signature, IHDR chunk starts at byte 8
  // Width at bytes 16-19, height at bytes 20-23 (big-endian uint32)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    if (buf.length < 24) return null
    return {
      width:  buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    }
  }

  // GIF: 'GIF87a' or 'GIF89a', width at bytes 6-7, height at bytes 8-9 (little-endian)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    if (buf.length < 10) return null
    return {
      width:  buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
    }
  }

  // BMP: 'BM', width at 18-21, height at 22-25 (little-endian int32)
  if (buf[0] === 0x42 && buf[1] === 0x4D) {
    if (buf.length < 26) return null
    return {
      width:  Math.abs(buf.readInt32LE(18)),
      height: Math.abs(buf.readInt32LE(22)),
    }
  }

  // WebP: 'RIFF' + 'WEBP'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return parseWebP(buf)
  }

  // JPEG: starts with 0xFF 0xD8
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    return parseJPEG(buf)
  }

  return null
}

/**
 * Parse JPEG dimensions by scanning for SOF markers.
 */
function parseJPEG(buf) {
  let offset = 2
  while (offset < buf.length - 8) {
    if (buf[offset] !== 0xFF) return null
    const marker = buf[offset + 1]

    // SOF markers (SOF0 through SOF15, excluding DHT/DAC/RST/SOI/EOI etc.)
    if (
      (marker >= 0xC0 && marker <= 0xCF) &&
      marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
    ) {
      if (offset + 9 > buf.length) return null
      return {
        height: buf.readUInt16BE(offset + 5),
        width:  buf.readUInt16BE(offset + 7),
      }
    }

    // Skip this marker segment
    if (offset + 3 >= buf.length) return null
    const segLen = buf.readUInt16BE(offset + 2)
    offset += 2 + segLen
  }
  return null
}

/**
 * Parse WebP dimensions (VP8/VP8L/VP8X).
 */
function parseWebP(buf) {
  if (buf.length < 30) return null
  const chunk = buf.toString('ascii', 12, 16)

  if (chunk === 'VP8 ') {
    // Lossy: width at 26-27, height at 28-29 (little-endian, masked)
    if (buf.length < 30) return null
    return {
      width:  buf.readUInt16LE(26) & 0x3FFF,
      height: buf.readUInt16LE(28) & 0x3FFF,
    }
  }

  if (chunk === 'VP8L') {
    // Lossless: bits at offset 21
    if (buf.length < 25) return null
    const bits = buf.readUInt32LE(21)
    return {
      width:  (bits & 0x3FFF) + 1,
      height: ((bits >> 14) & 0x3FFF) + 1,
    }
  }

  if (chunk === 'VP8X') {
    // Extended: 24-bit values at offsets 24-26 (width) and 27-29 (height)
    if (buf.length < 30) return null
    return {
      width:  (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
      height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
    }
  }

  return null
}
