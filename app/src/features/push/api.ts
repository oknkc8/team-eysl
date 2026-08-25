import { env } from '../../lib/env'
import { supabase } from '../../lib/supabase'
import {
  derivePushState,
  detectPushSupport,
  isIosUserAgent,
  vapidKeyToBytes,
  type PushState,
  type PushSupport,
} from './support'

/**
 * Registering this browser to receive notifications, and saying honestly
 * whether it is registered.
 *
 * Sending is not done from here and never will be: it needs the VAPID private
 * key, which exists only in the push-notify Edge Function's secrets, because a
 * key in this file would ship to every visitor. What the club is actually
 * notified about — 공지 등록, 일정 등록, 대기자 알림 — is triggered by database
 * triggers rather than by any browser (supabase/migrations/0022, and the header
 * of supabase/functions/push-notify/index.ts for why).
 *
 * The one thing this file does reach the sender for is sendTestPush(), whose
 * audience is the caller's own devices. Registered and receiving are different
 * facts, and until a notification actually arrives nobody can tell them apart.
 */

/** One row of push_subscriptions, as the settings screen shows it. */
export type PushDevice = {
  id: string
  endpoint: string
  user_agent: string | null
  created_at: string
  updated_at: string
  /** This browser's own registration, rather than another of the member's devices. */
  isThisDevice: boolean
}

export type PushStatus = {
  state: PushState
  support: PushSupport
  permission: 'default' | 'granted' | 'denied' | 'unavailable'
  /** Every device this member has registered, including ones not here. */
  devices: PushDevice[]
}

const DEVICE_COLUMNS = 'id, endpoint, user_agent, created_at, updated_at'

// navigator.serviceWorker.ready never settles when no worker has been
// registered — in a dev server without the PWA plugin's output, awaiting it
// hangs this screen forever with no error to show. So the wait is bounded and
// the timeout becomes a sentence the member can read.
const REGISTRATION_TIMEOUT_MS = 10_000

// ------------------------------------------------------------------ probes

function hasServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  // navigator.standalone is Safari's, and only Safari's — it is how an iPhone
  // reports being launched from the home screen, which is the only way iOS
  // delivers web push at all.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  const displayMode = window.matchMedia('(display-mode: standalone)').matches
  return iosStandalone || displayMode
}

function readPermission(): PushStatus['permission'] {
  if (typeof Notification === 'undefined') return 'unavailable'
  return Notification.permission
}

function readSupport(): PushSupport {
  return detectPushSupport({
    hasNotification: typeof Notification !== 'undefined',
    hasServiceWorker: hasServiceWorker(),
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    isIos: typeof navigator !== 'undefined' && isIosUserAgent(navigator.userAgent),
    isStandalone: isStandalone(),
  })
}

/** The service worker registration, or an error naming why there is none. */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  if (!hasServiceWorker()) throw new Error('이 기기에서는 알림을 사용할 수 없습니다')

  const existing = await navigator.serviceWorker.getRegistration()
  if (existing) return existing

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error('앱 준비가 끝나지 않았습니다. 새로고침 후 다시 시도해주세요.')),
      REGISTRATION_TIMEOUT_MS,
    )
  })
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

/** This browser's live subscription, without waiting on a worker that may never come. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!hasServiceWorker()) return null
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ?? null
}

// ------------------------------------------------------------------- reads

async function listDevices(memberId: string): Promise<Omit<PushDevice, 'isThisDevice'>[]> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select(DEVICE_COLUMNS)
    .eq('member_id', memberId)
    .order('updated_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

/**
 * Everything the settings screen needs, gathered at once.
 *
 * The browser half and the server half are read independently and then
 * compared, because that comparison is the only thing that can tell 알림 받는 중
 * from a row left behind by a subscription the browser has since dropped.
 */
export async function readPushStatus(memberId: string): Promise<PushStatus> {
  const [subscription, devices] = await Promise.all([currentSubscription(), listDevices(memberId)])
  const endpoint = subscription?.endpoint ?? null
  const support = readSupport()
  const permission = readPermission()

  return {
    state: derivePushState({
      configured: env.VAPID_PUBLIC_KEY !== null,
      support,
      permission,
      browserEndpoint: endpoint,
      storedEndpoints: devices.map((device) => device.endpoint),
    }),
    support,
    permission,
    devices: devices.map((device) => ({ ...device, isThisDevice: device.endpoint === endpoint })),
  }
}

// ------------------------------------------------------------------ writes

/**
 * Turn notifications on for this browser.
 *
 * Also the repair path: a subscription created against a different VAPID key
 * still exists and still looks healthy, but every notification sent to it is
 * rejected by the push service. The legacy app rebuilt the subscription
 * unconditionally to work around this (repairPushSubscription,
 * index.html:1520); comparing the keys means only a wrong one is replaced.
 */
export async function enablePush(memberId: string): Promise<void> {
  const key = env.VAPID_PUBLIC_KEY
  if (!key) throw new Error('이 빌드에는 알림 키가 설정되어 있지 않습니다')
  const applicationServerKey = vapidKeyToBytes(key)

  if (typeof Notification === 'undefined') throw new Error('이 기기에서는 알림을 사용할 수 없습니다')
  if (Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') throw new Error('알림 권한이 허용되지 않았습니다')
  }

  const registration = await readyRegistration()
  let subscription = await registration.pushManager.getSubscription()

  if (subscription && !usesKey(subscription, applicationServerKey)) {
    await subscription.unsubscribe()
    subscription = null
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      // Required by every browser that implements push: a notification must be
      // shown for each message, so silent background pushes are not possible.
      userVisibleOnly: true,
      applicationServerKey,
    })
  }

  await storeSubscription(memberId, subscription)
}

/**
 * Turn them off for this browser.
 *
 * The row goes first. It is what a sender reads, so removing it is what
 * actually stops notifications; if the browser then refuses to unsubscribe, the
 * member is off either way and the caller is told the endpoint is still live.
 * The other order risks a browser with no subscription and a row that keeps
 * being written to.
 */
export async function disablePush(memberId: string): Promise<{ browserUnsubscribed: boolean }> {
  const subscription = await currentSubscription()
  if (!subscription) return { browserUnsubscribed: true }

  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('member_id', memberId)
    .eq('endpoint', subscription.endpoint)
  if (error) throw error

  return { browserUnsubscribed: await subscription.unsubscribe() }
}

/**
 * Remove one registered device.
 *
 * The row for a phone that was reinstalled or thrown away cannot be reached
 * from that device any more, so it is removed from wherever the member is now.
 * push_subscriptions_self (0004) confines this to their own rows.
 */
export async function forgetDevice(deviceId: string): Promise<void> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('id', deviceId)
    .select('id')
  if (error) throw error
  // PostgREST answers a policy-refused DELETE with 200 and an empty array, so
  // the error alone would report a silent no-op as success — the same check
  // every mutation in the media module makes.
  if ((data ?? []).length === 0) throw new Error('기기를 삭제하지 못했습니다')
}

/** What the sender reports back about one send. */
export type TestPushResult = {
  /** Devices the push service accepted the message for. */
  sent: number
  /** Registrations deleted mid-send because their endpoint is gone. */
  pruned: number
  failed: number
}

/**
 * Ask the sender to notify this member's own devices, and nothing else.
 *
 * This is the only call in the app that reaches push-notify, and the request
 * carries no recipient: the function reads the member from the session token
 * sent with it (current_member_id(), the same gate every screen sits behind) and
 * refuses every event except self_test. There is nothing to aim.
 *
 * It exists because 알림 등록됨 and 알림이 도착함 are different facts, and this
 * whole feature spent its life as the first one — every subscription in the
 * table had been stored and never written to. A member who presses this and sees
 * nothing has learned something the settings screen could not otherwise tell
 * them, and so has whoever they report it to.
 */
export async function sendTestPush(): Promise<TestPushResult> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const token = data.session?.access_token
  // supabase-js refreshes an expiring session on its own, so a missing token
  // here means signed out rather than stale.
  if (!token) throw new Error('로그인이 만료됐습니다. 다시 로그인해주세요.')

  let response: Response
  try {
    response = await fetch(`${env.SUPABASE_URL}/functions/v1/push-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ event: 'self_test' }),
    })
  } catch {
    // A function that was never deployed looks exactly like being offline from
    // here, so the sentence has to cover both without guessing between them.
    throw new Error('알림 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.')
  }

  const body: unknown = await response.json().catch(() => ({}))
  const payload = (body ?? {}) as { ok?: boolean; error?: string; sent?: number; pruned?: number; failed?: number }

  if (!response.ok || payload.ok !== true) {
    // The function's own words when it has any — "push is not configured:
    // VAPID_PRIVATE_KEY not set" is worth showing an admin verbatim, and is a
    // different problem from a refused request.
    throw new Error(payload.error ?? `알림 전송에 실패했습니다 (HTTP ${response.status})`)
  }

  return {
    sent: Number(payload.sent ?? 0),
    pruned: Number(payload.pruned ?? 0),
    failed: Number(payload.failed ?? 0),
  }
}

// --------------------------------------------------------------- internals

async function storeSubscription(memberId: string, subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  // Both are what a sender encrypts to. A row without them is a row that can
  // never deliver anything, so it is better not written.
  if (!p256dh || !auth) throw new Error('구독 정보를 읽지 못했습니다')

  const { data, error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        member_id: memberId,
        endpoint: subscription.endpoint,
        p256dh,
        auth,
        // What lets a member tell three rows apart on the settings screen.
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString(),
      },
      // The table's unique (member_id, endpoint) — re-enabling on a device that
      // is already registered refreshes the row rather than duplicating it.
      { onConflict: 'member_id,endpoint' },
    )
    .select('id')
  if (error) throw error
  if ((data ?? []).length === 0) throw new Error('알림 등록을 저장하지 못했습니다')
}

/** Whether an existing subscription was created against this VAPID key. */
function usesKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const stored = subscription.options.applicationServerKey
  if (!stored) return false
  const bytes = new Uint8Array(stored)
  if (bytes.length !== key.length) return false
  return bytes.every((byte, index) => byte === key[index])
}
