/**
 * Well-known brand for {@link ComposedStore} instances. Survives minification (unlike `constructor.name`)
 * and matches across duplicate package installs (same `Symbol.for` in one JS realm).
 *
 * Custom wrappers that delegate to a composed store should also set this to `true`, or implement
 * {@link COMPOSED_UNWRAP}, or subclass {@link ComposedStore}.
 *
 * @since 2.4.1
 */
export const COMPOSED_STORE_BRAND = Symbol.for('ratelimit-flex.composed-store');

/**
 * Optional method for store wrappers (e.g. {@link InMemoryShield}) so
 * {@link isComposedStoreBrand} can see a {@link ComposedStore} behind delegates.
 *
 * Return the **immediate** inner store; detection walks up to {@link MAX_COMPOSED_UNWRAP_DEPTH} steps.
 *
 * @example
 * ```ts
 * [COMPOSED_UNWRAP]() {
 *   return this.inner;
 * }
 * ```
 *
 * @since 2.4.1
 */
export const COMPOSED_UNWRAP = Symbol.for('ratelimit-flex.composed-unwrap');

/** Guard against pathological unwrap chains. */
const MAX_COMPOSED_UNWRAP_DEPTH = 16;

let composedStoreCtor: (abstract new (...args: never[]) => object) | undefined;

/**
 * Opaque `Proxy` or other facades that cannot forward {@link COMPOSED_STORE_BRAND} / prototype checks:
 * associate the **facade** with the delegate {@link ComposedStore} (or another facade that unwraps to one).
 * Uses a `WeakMap` so detection does not rely on `get` / `has` traps.
 *
 * @since 2.4.1
 */
const composedFacadeToDelegate = new WeakMap<object, object>();

/**
 * Called once from `ComposedStore` at module load so {@link isComposedStoreBrand} can resolve
 * prototype chains (subclasses, forwarding proxies). Not for app use.
 *
 * @internal
 */
export function registerComposedStoreConstructor(
  ctor: abstract new (...args: never[]) => object,
): void {
  composedStoreCtor = ctor;
}

/**
 * Register a facade object (e.g. an opaque `Proxy`) so {@link isComposedStoreBrand} follows to `delegate`.
 * Idempotent replacements: last registration wins. Use {@link unregisterComposedStoreFacade} to remove.
 *
 * @since 2.4.1
 */
export function registerComposedStoreFacade(facade: object, delegate: object): void {
  composedFacadeToDelegate.set(facade, delegate);
}

/**
 * Remove a facade mapping (e.g. tests or teardown).
 *
 * @since 2.4.1
 */
export function unregisterComposedStoreFacade(facade: object): void {
  composedFacadeToDelegate.delete(facade);
}

function hasBrand(o: object): boolean {
  return (o as Record<symbol, unknown>)[COMPOSED_STORE_BRAND] === true;
}

function tryUnwrapDelegate(o: object): unknown {
  const fn = (o as Record<symbol, unknown>)[COMPOSED_UNWRAP];
  if (typeof fn !== 'function') {
    return o;
  }
  try {
    return (fn as (this: object) => unknown).call(o);
  } catch {
    return o;
  }
}

/** Mirrors ordinary `instanceof` prototype walk (avoids relying on `constructor.name`). */
function isPrototypeChainComposed(o: object): boolean {
  if (composedStoreCtor === undefined) {
    return false;
  }
  const targetProto = (composedStoreCtor as { prototype: object | null }).prototype;
  if (targetProto === undefined || targetProto === null) {
    return false;
  }
  let proto = Object.getPrototypeOf(o);
  while (proto !== null) {
    if (proto === targetProto) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Returns true when `store` is, unwraps to, or maps to a {@link ComposedStore}.
 *
 * **Per step:** peel {@link registerComposedStoreFacade} mappings → {@link COMPOSED_STORE_BRAND} →
 * prototype chain (subclasses / forwarding proxies) → {@link COMPOSED_UNWRAP}, until depth limit.
 *
 * **Opaque `Proxy`:** call {@link registerComposedStoreFacade}(`proxy`, innerComposed) if traps cannot
 * forward symbols or prototype checks.
 *
 * @since 2.4.1
 */
export function isComposedStoreBrand(store: unknown): boolean {
  if (store === null || typeof store !== 'object') {
    return false;
  }
  let current: unknown = store;
  let steps = 0;
  while (steps < MAX_COMPOSED_UNWRAP_DEPTH) {
    const o = current as object;

    const mapped = composedFacadeToDelegate.get(o);
    if (mapped !== undefined) {
      if (mapped === o) {
        return false;
      }
      current = mapped;
      steps++;
      continue;
    }

    if (hasBrand(o)) {
      return true;
    }
    if (isPrototypeChainComposed(o)) {
      return true;
    }

    const next = tryUnwrapDelegate(o);
    steps++;
    if (next === o || next === null || typeof next !== 'object') {
      return false;
    }
    current = next;
  }
  return false;
}
