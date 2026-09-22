/** `prefers-reduced-motion` — 파티클·흔들림을 생략하고 경로/팝만 짧게 (§6.5). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
