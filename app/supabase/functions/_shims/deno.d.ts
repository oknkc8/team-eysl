/**
 * The Deno surface the push-notify function actually uses, and nothing else.
 *
 * This exists so `tsc -p tsconfig.functions.json` can read the Edge Function at
 * all. The real definitions live in Deno's own lib, which is not installed here
 * — deno is not on this machine, and installing it is a separate decision.
 *
 * WHAT THIS BUYS: our own code is typechecked. A misspelled property, a wrong
 * argument count, a value of the wrong type flowing between index.ts, send.ts,
 * payload.ts and endpoint.ts — all caught.
 *
 * WHAT IT DOES NOT: it cannot catch us being wrong ABOUT Deno, because this
 * file is our belief about Deno rather than Deno. If `Deno.serve`'s real
 * signature differs from the two lines below, the typecheck agrees with the
 * mistake. Keep this minimal for that reason — every line added here is another
 * thing that can be confidently wrong.
 */

declare const Deno: {
  env: {
    get(key: string): string | undefined
  }
  serve(handler: (request: Request) => Response | Promise<Response>): unknown
}
