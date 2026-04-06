import type { ExecutionContext } from '@nestjs/common';

/** Result of `createRequire()` — CommonJS `require` bound to a module. */
export type NodeRequireFn = ReturnType<typeof import('node:module').createRequire>;

/**
 * Resolve `req` / `res` from Apollo/Mercurius GraphQL context via `@nestjs/graphql`.
 *
 * @returns `null` when the package is missing or resolution fails — callers should fall back to HTTP.
 */
export function tryResolveGraphqlRequestResponse(
  context: ExecutionContext,
  requireImpl: NodeRequireFn,
): { req: unknown; res: unknown } | null {
  try {
    const { GqlExecutionContext } = requireImpl('@nestjs/graphql') as {
      GqlExecutionContext: {
        create: (ctx: ExecutionContext) => { getContext: () => { req?: unknown; res?: unknown } };
      };
    };
    const gqlCtx = GqlExecutionContext.create(context);
    const gql = gqlCtx.getContext();
    return { req: gql.req, res: gql.res };
  } catch {
    return null;
  }
}
