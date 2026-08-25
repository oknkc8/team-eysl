import { describe, it, expect } from 'vitest'
import {
  derivePushState,
  describeDevice,
  detectPushSupport,
  isIosUserAgent,
  vapidKeyToBytes,
} from './support'

// Built here rather than copied from anywhere: a real VAPID public key is safe
// to publish, but a synthetic one makes it obvious that no key material — not
// even a public half — is being carried around in tests.
function syntheticVapidKey(): string {
  const bytes = new Uint8Array(65)
  bytes[0] = 0x04
  for (let i = 1; i < 65; i += 1) bytes[i] = i
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const CAPABLE = {
  hasNotification: true,
  hasServiceWorker: true,
  hasPushManager: true,
  isIos: false,
  isStandalone: false,
}

describe('detectPushSupport', () => {
  it('accepts a browser with all three APIs', () => {
    expect(detectPushSupport(CAPABLE)).toBe('ok')
  })

  // Safari in a tab exposes no PushManager, so the capability check would call
  // an iPhone unsupported when the fix is one Add to Home Screen away.
  it('tells an iPhone in a tab to install, not that it is unsupported', () => {
    expect(
      detectPushSupport({ ...CAPABLE, hasPushManager: false, isIos: true, isStandalone: false }),
    ).toBe('needs-install')
  })

  it('accepts an iPhone once it is installed', () => {
    expect(detectPushSupport({ ...CAPABLE, isIos: true, isStandalone: true })).toBe('ok')
  })

  it('reports a desktop browser without a PushManager as unsupported', () => {
    expect(detectPushSupport({ ...CAPABLE, hasPushManager: false })).toBe('unsupported')
  })

  it('needs all three, not any of them', () => {
    expect(detectPushSupport({ ...CAPABLE, hasNotification: false })).toBe('unsupported')
    expect(detectPushSupport({ ...CAPABLE, hasServiceWorker: false })).toBe('unsupported')
  })
})

describe('isIosUserAgent', () => {
  it('recognises the three iOS devices', () => {
    expect(isIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)')).toBe(true)
    expect(isIosUserAgent('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)')).toBe(true)
    expect(isIosUserAgent('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X)')).toBe(true)
  })

  it('does not mistake a Mac for one', () => {
    expect(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
  })
})

describe('describeDevice', () => {
  // Every one of these contains "Safari", and Edge's also contains "Chrome",
  // so the order the tokens are tested in is what these assertions protect.
  it('names the browser that is actually running', () => {
    expect(
      describeDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('iPhone · Safari')

    expect(
      describeDevice(
        'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Android · Chrome')

    expect(
      describeDevice(
        'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Android · 삼성 인터넷')

    expect(
      describeDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      ),
    ).toBe('Windows · Edge')
  })

  // An iPhone's user agent says "like Mac OS X", so an OS check in the wrong
  // order labels every iPhone a Mac.
  it('does not label an iPhone a Mac', () => {
    expect(
      describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile Safari/604.1'),
    ).toContain('iPhone')
  })

  // user_agent is nullable, and a member with an unnamed device should see a
  // row they can still delete rather than an empty line.
  it('says so when there is nothing to go on', () => {
    expect(describeDevice(null)).toBe('알 수 없는 기기')
    expect(describeDevice('  ')).toBe('알 수 없는 기기')
    expect(describeDevice('curl/8.4.0')).toBe('알 수 없는 기기')
  })
})

describe('derivePushState', () => {
  const LIVE = {
    configured: true,
    support: 'ok',
    permission: 'granted',
    browserEndpoint: 'https://fcm.googleapis.com/fcm/send/AAA',
    storedEndpoints: ['https://fcm.googleapis.com/fcm/send/AAA'],
  } as const

  it('is on only when the browser and the server agree on the same endpoint', () => {
    expect(derivePushState(LIVE)).toBe('on')
  })

  // The defect this screen was asked not to have: a row in push_subscriptions
  // is not evidence that this device still receives anything.
  it('does not call a stored row from a dead subscription "on"', () => {
    expect(
      derivePushState({
        ...LIVE,
        browserEndpoint: 'https://fcm.googleapis.com/fcm/send/NEW',
        storedEndpoints: ['https://fcm.googleapis.com/fcm/send/OLD'],
      }),
    ).toBe('needs-repair')
  })

  it('is off when the browser holds no subscription, however many rows exist', () => {
    expect(derivePushState({ ...LIVE, browserEndpoint: null })).toBe('off')
  })

  // Permission granted but never subscribed is the state the legacy app called
  // "등록 필요"; here it is simply off, because nothing will arrive.
  it('is off when permission was granted but nothing was subscribed', () => {
    expect(
      derivePushState({ ...LIVE, browserEndpoint: null, storedEndpoints: [] }),
    ).toBe('off')
  })

  it('reports a denied permission ahead of anything about endpoints', () => {
    expect(derivePushState({ ...LIVE, permission: 'denied' })).toBe('blocked')
  })

  // Capability and configuration outrank permission: asking an iPhone in a tab
  // for permission produces a prompt that cannot lead anywhere.
  it('puts install and support ahead of permission', () => {
    expect(derivePushState({ ...LIVE, support: 'needs-install', permission: 'denied' })).toBe(
      'needs-install',
    )
    expect(derivePushState({ ...LIVE, support: 'unsupported' })).toBe('unsupported')
  })

  it('says a build with no VAPID key is unconfigured before anything else', () => {
    expect(derivePushState({ ...LIVE, configured: false, support: 'unsupported' })).toBe(
      'unconfigured',
    )
  })
})

describe('vapidKeyToBytes', () => {
  it('decodes a base64url key to its 65 bytes', () => {
    const bytes = vapidKeyToBytes(syntheticVapidKey())
    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(0x04)
    expect(bytes[64]).toBe(64)
  })

  it('tolerates surrounding whitespace, which a copied .env value carries', () => {
    expect(vapidKeyToBytes(`  ${syntheticVapidKey()}\n`)).toHaveLength(65)
  })

  // Each of these fails inside pushManager.subscribe() as an opaque
  // InvalidAccessError, which is the failure this function exists to pre-empt.
  it('refuses a key that is not one, by name', () => {
    expect(() => vapidKeyToBytes('')).toThrow(/비어/)
    expect(() => vapidKeyToBytes('not a key at all!!')).toThrow(/읽을 수 없|형식/)
    expect(() => vapidKeyToBytes('c2hvcnQ')).toThrow(/형식/)
  })
})
