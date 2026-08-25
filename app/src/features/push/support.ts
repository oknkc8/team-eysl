/**
 * The parts of web push that are decisions rather than browser calls.
 *
 * Kept separate from api.ts because these are the bits worth testing: what a
 * device is capable of, what its user agent says it is, and whether a VAPID key
 * is even a key. Everything that needs a live ServiceWorkerRegistration lives
 * next door.
 */

export type PushSupport =
  /** Everything push needs is present. */
  | 'ok'
  /** iOS only delivers web push to an app added to the home screen. */
  | 'needs-install'
  /** No service worker, no PushManager, or no Notification API. */
  | 'unsupported'

/**
 * What this device can do.
 *
 * The iOS check comes first, and that order is the whole point: Safari in a
 * normal tab exposes no PushManager at all, so testing capabilities first would
 * tell an iPhone owner "이 기기에서는 지원하지 않습니다" when the true answer is
 * "홈 화면에 추가하면 됩니다". The legacy app orders it the same way
 * (index.html:1408-1414).
 */
export function detectPushSupport(input: {
  hasNotification: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  isIos: boolean
  /** Running as an installed PWA rather than in a browser tab. */
  isStandalone: boolean
}): PushSupport {
  if (input.isIos && !input.isStandalone) return 'needs-install'
  if (!input.hasNotification || !input.hasServiceWorker || !input.hasPushManager)
    return 'unsupported'
  return 'ok'
}

export function isIosUserAgent(userAgent: string): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent)
}

/** The one sentence 알림 설정 has to get right. */
export type PushState =
  /** No VAPID key in this build, so nothing here can work yet. */
  | 'unconfigured'
  | 'unsupported'
  | 'needs-install'
  /** The member said no at the browser prompt; only they can undo that. */
  | 'blocked'
  /** This browser holds a subscription and the server has the matching row. */
  | 'on'
  /** This browser holds a subscription the server does not know about. */
  | 'needs-repair'
  | 'off'

/**
 * What to tell the member, from what is actually true right now.
 *
 * The brief for this screen is that a stored row must not be taken as proof
 * that push works, and this is where that holds. 'on' requires two independent
 * facts to agree: the browser still holds a subscription, and the server has a
 * row for that exact endpoint. Either one alone is a state with its own name.
 *
 * A subscription can lapse without anybody being told — the browser drops it,
 * the push service expires the endpoint, the member reinstalls — and each of
 * those leaves a row behind that a sender would keep writing to. Comparing
 * endpoints is what notices.
 */
export function derivePushState(input: {
  configured: boolean
  support: PushSupport
  permission: 'default' | 'granted' | 'denied' | 'unavailable'
  /** The endpoint this browser holds a live subscription for. */
  browserEndpoint: string | null
  /** Endpoints the server has stored for this member, across all their devices. */
  storedEndpoints: readonly string[]
}): PushState {
  if (!input.configured) return 'unconfigured'
  if (input.support === 'needs-install') return 'needs-install'
  if (input.support === 'unsupported') return 'unsupported'
  // Checked before the endpoints: a denied permission delivers nothing however
  // many rows are stored, and it is the only state the app cannot fix itself.
  if (input.permission === 'denied') return 'blocked'

  if (!input.browserEndpoint) return 'off'
  return input.storedEndpoints.includes(input.browserEndpoint) ? 'on' : 'needs-repair'
}

/**
 * A readable name for one registered device.
 *
 * push_subscriptions.user_agent exists so a member looking at three rows can
 * tell which is the phone they lost. A whole user agent string is not that, and
 * a version number is not either — the OS and the browser are.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim()
  if (ua === '') return '알 수 없는 기기'

  const os = detectOs(ua)
  const browser = detectBrowser(ua)
  if (!os && !browser) return '알 수 없는 기기'
  if (!browser) return os
  if (!os) return browser
  return `${os} · ${browser}`
}

function detectOs(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  // Checked after the iOS names: an iPhone's user agent also says "like Mac OS X".
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac'
  return ''
}

// Order is load-bearing. Every one of these ships a user agent containing
// "Safari", and Edge's contains "Chrome" as well, so the most specific token
// has to be tested first or everything reports as Safari.
function detectBrowser(ua: string): string {
  if (/Edg[A-Z]?\//i.test(ua)) return 'Edge'
  if (/SamsungBrowser/i.test(ua)) return '삼성 인터넷'
  if (/FxiOS|Firefox/i.test(ua)) return 'Firefox'
  if (/CriOS|Chrome/i.test(ua)) return 'Chrome'
  if (/Safari/i.test(ua)) return 'Safari'
  return ''
}

/**
 * The VAPID public key as the bytes pushManager.subscribe wants.
 *
 * It is distributed as base64url — no padding, `-` and `_` for `+` and `/` —
 * which atob does not accept, hence the rewrite. Ported from the legacy app
 * (index.html:1342-1348), with the validation it lacked: an applicationServerKey
 * of the wrong shape fails inside subscribe() as an opaque InvalidAccessError,
 * which is a miserable thing to debug from a phone. A P-256 public key is 65
 * bytes and begins with 0x04, so a mistyped key is caught here by name.
 *
 * The `<ArrayBuffer>` is spelled out because a bare `Uint8Array` means
 * `Uint8Array<ArrayBufferLike>`, which could be backed by a SharedArrayBuffer —
 * and applicationServerKey takes a BufferSource, which cannot. Leaving it off
 * makes the subscribe() call below fail to typecheck for a reason that has
 * nothing to do with this key.
 */
export function vapidKeyToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const trimmed = base64Url.trim()
  if (trimmed === '') throw new Error('VAPID 공개 키가 비어 있습니다')

  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4)
  const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/')

  let raw: string
  try {
    raw = atob(base64)
  } catch {
    throw new Error('VAPID 공개 키를 읽을 수 없습니다')
  }

  if (raw.length !== 65 || raw.charCodeAt(0) !== 0x04) {
    throw new Error('VAPID 공개 키 형식이 올바르지 않습니다')
  }

  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}
