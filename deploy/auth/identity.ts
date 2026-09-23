import { AsyncLocalStorage } from 'node:async_hooks'

export const requestIdentity = new AsyncLocalStorage<{ email: string }>()
