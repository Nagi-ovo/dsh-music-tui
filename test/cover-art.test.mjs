import assert from 'node:assert/strict'
import test from 'node:test'
import { encode as encodePng } from 'fast-png'
import { encode as encodeJpeg } from 'jpeg-js'
import { allowedCoverUrl, CoverArtLoader } from '../lib/cover-art.js'

const JPEG_HEADERS = { 'content-type': 'image/jpeg' }

test('cover URLs are confined to HTTPS music.126.net hosts', () => {
  assert.equal(allowedCoverUrl('https://music.126.net/cover.jpg')?.hostname, 'music.126.net')
  assert.equal(allowedCoverUrl('https://p1.music.126.net/cover.jpg')?.hostname, 'p1.music.126.net')
  for (const source of [
    'http://p1.music.126.net/cover.jpg',
    'https://music.126.net.evil.example/cover.jpg',
    'https://notmusic.126.net/cover.jpg',
    'https://user@p1.music.126.net/cover.jpg',
    'https://p1.music.126.net:444/cover.jpg',
    'not a url',
  ]) {
    assert.equal(allowedCoverUrl(source), undefined, source)
  }
})

test('redirect targets are revalidated before another request', async () => {
  const calls = []
  const loader = new CoverArtLoader({
    fetcher: async url => {
      calls.push(String(url))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/cover.jpg' },
      })
    },
  })

  assert.equal(await loader.load('https://p1.music.126.net/start.jpg'), undefined)
  assert.deepEqual(calls, ['https://p1.music.126.net/start.jpg'])
})

test('cover downloads enforce declared and streamed byte caps', async () => {
  let decoded = 0
  const decoder = () => {
    decoded += 1
    return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }
  }
  const declared = new CoverArtLoader({
    decoder,
    fetcher: async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { ...JPEG_HEADERS, 'content-length': String(256 * 1024 + 1) },
    }),
  })
  const streamed = new CoverArtLoader({
    decoder,
    fetcher: async () => new Response(new Uint8Array(256 * 1024 + 1), {
      status: 200,
      headers: JPEG_HEADERS,
    }),
  })

  assert.equal(await declared.load('https://p1.music.126.net/declared.jpg'), undefined)
  assert.equal(await streamed.load('https://p1.music.126.net/streamed.jpg'), undefined)
  assert.equal(decoded, 0)
})

test('JPEG artwork decodes into a bounded six-by-three terminal thumbnail', async () => {
  const rgba = Buffer.alloc(8 * 8 * 4)
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = 40
    rgba[offset + 1] = 100
    rgba[offset + 2] = 180
    rgba[offset + 3] = 255
  }
  const jpeg = encodeJpeg({ width: 8, height: 8, data: rgba }, 80).data
  const loader = new CoverArtLoader({
    fetcher: async () => new Response(jpeg, { status: 200, headers: JPEG_HEADERS }),
  })

  const cover = await loader.load('https://p1.music.126.net/valid.jpg')
  assert.equal(cover?.image.width, 96)
  assert.equal(cover?.image.height, 96)
  assert.equal(cover?.image.data.byteLength, 96 * 96 * 4)
  assert.equal(cover?.rows.length, 3)
  for (const row of cover?.rows ?? []) {
    assert.equal(row.length, 6)
    for (const cell of row) {
      assert.match(cell.top, /^#[0-9a-f]{6}$/u)
      assert.match(cell.bottom, /^#[0-9a-f]{6}$/u)
    }
  }
})

test('NetEase PNG bytes mislabeled as image/jpg still render artwork', async () => {
  const rgba = new Uint8Array(8 * 8 * 4).fill(255)
  const png = encodePng({ width: 8, height: 8, data: rgba })
  const loader = new CoverArtLoader({
    fetcher: async () => new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/jpg' },
    }),
  })

  const cover = await loader.load('https://p4.music.126.net/cover.jpg')
  assert.equal(cover?.image.width, 96)
  assert.equal(cover?.image.data.byteLength, 96 * 96 * 4)
  assert.equal(cover?.rows.length, 3)
  assert.equal(cover?.rows[0]?.length, 6)
})

test('oversized PNG dimensions are rejected before pixel inflation', async () => {
  const header = new Uint8Array(33)
  header.set([137, 80, 78, 71, 13, 10, 26, 10])
  new DataView(header.buffer).setUint32(8, 13)
  header.set([73, 72, 68, 82], 12)
  new DataView(header.buffer).setUint32(16, 2048)
  new DataView(header.buffer).setUint32(20, 2048)
  const loader = new CoverArtLoader({
    fetcher: async () => new Response(header, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  })

  assert.equal(await loader.load('https://p4.music.126.net/huge.png'), undefined)
})

test('the cover cache retains the sixteen most recently used URLs', async () => {
  let fetches = 0
  const loader = new CoverArtLoader({
    fetcher: async () => {
      fetches += 1
      return new Response(new Uint8Array([1]), { status: 200, headers: JPEG_HEADERS })
    },
    decoder: () => ({
      width: 1,
      height: 1,
      data: new Uint8Array([1, 2, 3, 255]),
    }),
  })

  for (let index = 0; index < 17; index += 1) {
    await loader.load(`https://p1.music.126.net/${index}.jpg`)
  }
  assert.equal(fetches, 17)
  await loader.load('https://p1.music.126.net/1.jpg')
  assert.equal(fetches, 17)
  await loader.load('https://p1.music.126.net/0.jpg')
  assert.equal(fetches, 18)
})
