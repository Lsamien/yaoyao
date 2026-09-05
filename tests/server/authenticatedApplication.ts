import type Koa from 'koa'
import {
  createApplication,
  type ApplicationOptions,
  type ApplicationRuntime,
} from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { LocalAuthStore, type LocalUser } from '../../src/server/localAuth.js'

const TEST_ADMIN: LocalUser = {
  id: 'test-admin',
  username: 'test-admin',
  role: 'admin',
  enabled: true,
  mustChangePassword: false,
  createdAt: 1,
  updatedAt: 1,
}

const TEST_USER: LocalUser = {
  ...TEST_ADMIN,
  id: 'test-user',
  username: 'test-user',
  role: 'user',
}

class AuthenticatedTestStore extends LocalAuthStore {
  override canUseSource() { return true }
  override currentFromCookieHeader(_cookie: string | undefined): LocalUser { return TEST_ADMIN }
  override current(_ctx: Koa.Context): LocalUser { return TEST_ADMIN }
  override require(_ctx: Koa.Context, _allowPasswordChange = false): LocalUser { return TEST_ADMIN }
  override requireAdmin(_ctx: Koa.Context): LocalUser { return TEST_ADMIN }
}

class UserAuthenticatedTestStore extends LocalAuthStore {
  override canUseSource() { return true }
  override currentFromCookieHeader(_cookie: string | undefined): LocalUser { return TEST_USER }
  override current(_ctx: Koa.Context): LocalUser { return TEST_USER }
  override require(_ctx: Koa.Context, _allowPasswordChange = false): LocalUser { return TEST_USER }
}

export function createAuthenticatedApplication(
  options: ApplicationOptions & { config: ServerConfig },
): ApplicationRuntime {
  return createApplication({
    ...options,
    auth: new AuthenticatedTestStore(options.config.home, Boolean(options.config.tlsCert)),
  })
}


export function createUserAuthenticatedApplication(
  options: ApplicationOptions & { config: ServerConfig },
): ApplicationRuntime {
  return createApplication({
    ...options,
    auth: new UserAuthenticatedTestStore(options.config.home, Boolean(options.config.tlsCert)),
  })
}
