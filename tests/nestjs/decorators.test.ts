import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RateLimit, SkipRateLimit } from '../../src/nestjs/decorators.js';
import { RATE_LIMIT_METADATA, RATE_LIMIT_SKIP_METADATA } from '../../src/nestjs/types.js';

describe('NestJS rate limit decorators', () => {
  const reflector = new Reflector();

  describe('@RateLimit', () => {
    it('sets rate-limit metadata on a class', () => {
      const options = { maxRequests: 5, windowMs: 60_000 };
      class AuthController {}
      RateLimit(options)(AuthController);

      expect(reflector.get(RATE_LIMIT_METADATA, AuthController)).toEqual(options);
    });

    it('sets rate-limit metadata on a method', () => {
      const options = { maxRequests: 1, windowMs: 1000, cost: 5 };
      class LoginController {
        login(): void {}
      }
      const descriptor = Object.getOwnPropertyDescriptor(LoginController.prototype, 'login');
      if (!descriptor) throw new Error('missing descriptor');
      RateLimit(options)(LoginController.prototype, 'login', descriptor);

      /** Nest `SetMetadata` stores method metadata on `descriptor.value` (the handler). */
      expect(reflector.get(RATE_LIMIT_METADATA, LoginController.prototype.login)).toEqual(options);
    });

  });

  describe('@SkipRateLimit', () => {
    it('sets skip metadata to true when no names are passed', () => {
      class HealthController {}
      SkipRateLimit()(HealthController);

      expect(reflector.get(RATE_LIMIT_SKIP_METADATA, HealthController)).toBe(true);
    });

    it("stores named skip metadata as ['per-second']", () => {
      class LightweightController {
        lightweight(): void {}
      }
      const descriptor = Object.getOwnPropertyDescriptor(LightweightController.prototype, 'lightweight');
      if (!descriptor) throw new Error('missing descriptor');
      SkipRateLimit('per-second')(LightweightController.prototype, 'lightweight', descriptor);

      expect(reflector.get(RATE_LIMIT_SKIP_METADATA, LightweightController.prototype.lightweight)).toEqual([
        'per-second',
      ]);
    });
  });
});
