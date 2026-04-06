import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GqlExecutionContext } from '@nestjs/graphql';
import {
  tryResolveGraphqlRequestResponse,
  type NodeRequireFn,
} from '../../src/nestjs/resolve-graphql-req-res.js';

describe('tryResolveGraphqlRequestResponse', () => {
  it('returns null when @nestjs/graphql cannot be loaded', () => {
    const requireMissing = ((id: string) => {
      if (id === '@nestjs/graphql') {
        throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
      }
      throw new Error(`unexpected: ${id}`);
    }) as NodeRequireFn;

    const ctx = {} as ExecutionContext;
    expect(tryResolveGraphqlRequestResponse(ctx, requireMissing)).toBeNull();
  });

  it('returns req/res from GqlExecutionContext when require succeeds', () => {
    const spy = vi.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({
        req: { ip: '5.5.5.5' },
        res: { setHeader: vi.fn() },
      }),
    } as unknown as ReturnType<typeof GqlExecutionContext.create>);

    const nodeRequire = ((id: string) => {
      if (id === '@nestjs/graphql') {
        return { GqlExecutionContext };
      }
      throw new Error(id);
    }) as unknown as NodeRequireFn;

    const ctx = {} as ExecutionContext;
    const out = tryResolveGraphqlRequestResponse(ctx, nodeRequire);
    expect(out).not.toBeNull();
    expect((out!.req as { ip: string }).ip).toBe('5.5.5.5');
    spy.mockRestore();
  });
});
