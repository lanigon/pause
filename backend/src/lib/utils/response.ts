import type { Response } from 'express'
import type { ErrorCodeValue } from './errors.js'

interface ApiEnvelope<T> {
  readonly success: boolean
  readonly data: T | null
  readonly error: { readonly code: ErrorCodeValue; readonly message: string; readonly details?: unknown } | null
}

export function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data, error: null }
  res.status(status).json(body)
}

export function fail(
  res: Response,
  status: number,
  code: ErrorCodeValue,
  message: string,
  details?: unknown,
): void {
  const body: ApiEnvelope<never> = {
    success: false,
    data: null,
    error: details === undefined ? { code, message } : { code, message, details },
  }
  res.status(status).json(body)
}
